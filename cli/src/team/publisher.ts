import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { relativePath, type TeamPlan } from "./plan.ts";
import type { Projection } from "./compiler.ts";
import { run, gitEnvironment, type Run } from "./process.ts";

export const OWNERSHIP_FILE = "deployments/team-ownership.json";
/** Whole sensitive profile sections are withheld, including old/escaped credential text. */
export function redactAppValueDiff(plan: TeamPlan, diff: string): string {
  const sensitive = new Set(plan.sources.flatMap(s => s.agents.filter(a => Object.keys(a.appValueBindings ?? {}).length).map(a => `profiles/${a.name}/profile.yaml`)));
  return diff.split(/(?=^diff --git )/m).map(section => {
    const file = section.match(/^diff --git a\/(\S+) b\/\1\n/)?.[1];
    if (sensitive.size && section.trim() && !file) return "[Unrecognized diff section withheld because managed application credentials are present.]\n";
    return file && sensitive.has(file) ? `${section.split("\n")[0]}\n[Profile details withheld: contains managed application credentials, including prior values.]\n` : section;
  }).join("");
}
interface Ownership { version: 1; installation: string; fingerprint: string; files: Record<string, string> }
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const allowed = (file: string) => relativePath(file) && /^(profiles\/|catalog\/profiles\/|deployments\/)/.test(file);
function safePath(root: string, file: string): string {
  if (!allowed(file)) throw new Error("Projection attempted an unmanaged path");
  const target = path.join(root, file);
  for (let current = target; current !== root; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error("Generated tree contains a symbolic link");
  }
  return target;
}
/** Preserve everything we do not own. Validate all paths and drift before the first write. */
export function stageProjection(root: string, installation: string, projection: Projection, dryRun = false, adoptBaseline = false): string[] {
  root = path.resolve(root);
  const manifest = safePath(root, OWNERSHIP_FILE);
  const previous: Ownership | undefined = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")) : undefined;
  if (previous && (previous.version !== 1 || previous.installation !== installation || !previous.files)) throw new Error("Destination is owned by another installation or unsupported ownership version");
  const profilesDir = path.join(root, "profiles");
  if (fs.existsSync(profilesDir)) for (const profile of fs.readdirSync(profilesDir)) {
    const entry = fs.lstatSync(path.join(profilesDir, profile));
    if (entry.isSymbolicLink()) throw new Error("Generated tree contains a symbolic link");
    if (!entry.isDirectory()) continue;
    const file = `profiles/${profile}/profile.yaml`;
    if (!projection.files.has(file)) throw new Error(`Register existing profile ${profile} before publishing a shared destination`);
    if (!previous && adoptBaseline && projection.files.has(file)) {
      const old = parse(fs.readFileSync(safePath(root, file), "utf8"));
      const next = parse(String(projection.files.get(file)));
      const canonical = (url: string) => {
        const github = url?.trim().match(/^(?:github\.com\/|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)\/?$/i);
        return JSON.stringify(github ? ["github", github[1]!.replace(/\.git$/i, "").toLowerCase()] : ["raw", url]);
      };
      if (canonical(old?.spec?.source) !== canonical(next?.spec?.source)) {
        const identity = (value: unknown) => {
          if (typeof value !== "string") return "missing source";
          try {
            const parsed = new URL(value);
            return JSON.stringify({ protocol: parsed.protocol, host: parsed.host, path: parsed.pathname, whitespace: value.trim() !== value });
          } catch { return JSON.stringify({ repository: value.match(/github\.com[:/]([\w.-]+\/[\w.-]+)/)?.[1], form: value.trim().startsWith("git@github.com:") ? "scp" : value.trim().startsWith("github.com/") ? "bare-https-host" : "unrecognized", whitespace: value.trim() !== value }); }
        };
        throw new Error(`Existing profile ${profile} belongs to another source (${identity(old?.spec?.source)}; expected ${identity(next?.spec?.source)}); automatic adoption refused`);
      }
    }
  }
  for (const [file, expected] of Object.entries(previous?.files ?? {})) {
    const target = safePath(root, file);
    if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== expected) throw new Error(`Generated drift at ${file}; correct source/bootstrap ownership before publication`);
  }
  for (const file of projection.files.keys()) safePath(root, file);
  for (const file of projection.files.keys()) {
    const target = path.join(root, file);
    if (!previous?.files[file] && !(!previous && adoptBaseline) && fs.existsSync(target) && hash(fs.readFileSync(target)) !== hash(projection.files.get(file)!)) {
      throw new Error(`Unowned generated file ${file} differs; reproduce the existing deployment from its source before adoption`);
    }
  }
  // A profile alone can never create the ApplicationSet workload (#3).
  const discovered = new Set([...projection.files].filter(([key]) => /^deployments\/agents\/[^/]+\/deployment.yaml$/.test(key)).map(([, value]) => parse(String(value))?.spec?.profile));
  for (const profile of projection.profiles) if (!discovered.has(profile)) throw new Error(`No deployment topology for ${profile}`);
  const changed: string[] = [];
  for (const file of Object.keys(previous?.files ?? {})) if (!projection.files.has(file)) {
    if (!dryRun) fs.unlinkSync(path.join(root, file)); changed.push(file);
  }
  for (const [file, bytes] of projection.files) {
    const target = path.join(root, file);
    if (fs.existsSync(target) && hash(fs.readFileSync(target)) === hash(bytes)) continue;
    if (!dryRun) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes); } changed.push(file);
  }
  const next: Ownership = { version: 1, installation, fingerprint: projection.fingerprint,
    files: Object.fromEntries([...projection.files].sort(([a], [b]) => a.localeCompare(b)).map(([file, value]) => [file, hash(value)])) };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (!fs.existsSync(manifest) || fs.readFileSync(manifest, "utf8") !== text) {
    if (!dryRun) { fs.mkdirSync(path.dirname(manifest), { recursive: true }); fs.writeFileSync(manifest, text); } changed.push(OWNERSHIP_FILE);
  }
  return changed;
}

/** Review the real destination in a disposable checkout before any infrastructure mutation. */
export async function previewProjection(plan: TeamPlan, projection: Projection, checkout: string, token?: string, exec: Run = run) {
  const env = gitEnvironment(token);
  const git = (args: string[]) => exec(["git", ...args], checkout, env);
  await git(["clone", "--no-checkout", "--", plan.destination.repository, "."]);
  await git(["checkout", "--detach", `origin/${plan.destination.branch}`]);
  const revision = (await git(["rev-parse", "HEAD"])).trim();
  const adopting = !fs.existsSync(path.join(checkout, OWNERSHIP_FILE)) && plan.adoptRevision !== undefined;
  if (adopting && revision !== plan.adoptRevision) throw new Error("Destination advanced since adoption review; regenerate and review the adoption plan");
  const appCredentialChanges = plan.sources.flatMap(source => source.agents.flatMap(agent => {
    const bindings = Object.keys(agent.appValueBindings ?? {});
    if (!bindings.length) return [];
    const file = safePath(checkout, `profiles/${agent.name}/profile.yaml`);
    const old = fs.existsSync(file) ? parse(fs.readFileSync(file, "utf8")) : undefined;
    const next = parse(String(projection.files.get(`profiles/${agent.name}/profile.yaml`)));
    return bindings.map(binding => {
      const [app, ...parts] = binding.split(".");
      const value = (record: any) => parts.reduce((v, key) => v?.[key], record?.spec?.apps?.find((entry: any) => entry.name === app)?.values);
      return { profile: agent.name, path: binding, changed: JSON.stringify(value(old)) !== JSON.stringify(value(next)) };
    });
  }));
  let files: string[];
  try { files = stageProjection(checkout, plan.id, projection, false, adopting); }
  catch (error) { throw new Error(`Destination revision ${revision}: ${error instanceof Error ? error.message : "projection review failed"}`); }
  if (files.length) await git(["add", "-A", "--", ...files]);
  const diff = files.length ? await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--no-renames"]) : "";
  return { revision, files, diff: redactAppValueDiff(plan, diff), appCredentialChanges };
}

export class ForgeFailure extends Error {
  constructor(readonly status: number, readonly transient: boolean) { super(`GitHub publication failed (HTTP ${status}); ${transient ? "retry budget exhausted" : "resolve permissions, review/check requirements or conflicting changes"}`); }
}
export function transientMergeFailure(status: number, message: string): boolean {
  return status === 405 && /base branch was modified/i.test(message);
}
export interface Forge {
  request(method: string, route: string, body?: unknown): Promise<any>;
}
export function github(repository: string, token: string): Forge {
  const repo = repository.replace(/^https:\/\/github.com\//, "").replace(/^git@github.com:/, "").replace(/\.git$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Team publisher requires a GitHub repository");
  return { async request(method, route, body) {
    const response = await fetch(`https://api.github.com/repos/${repo}${route}`, { method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const data = await response.json() as any;
    if (!response.ok) throw new ForgeFailure(response.status, transientMergeFailure(response.status, String(data.message)));
    return data;
  } };
}
export interface Publication { state: "unchanged" | "pending" | "merged"; revision: string; pullRequest?: string }

/** Stable content-addressed branches, normal pushes, one PR for the whole projection. */
export async function publishProjection(plan: TeamPlan, projection: Projection, checkout: string, token: string,
  exec: Run = run, forge: Forge = github(plan.destination.repository, token)): Promise<Publication> {
  const env = { ...gitEnvironment(token), GIT_AUTHOR_NAME: "Harness Hg", GIT_AUTHOR_EMAIL: "gitops-emitter@localhost", GIT_COMMITTER_NAME: "Harness Hg", GIT_COMMITTER_EMAIL: "gitops-emitter@localhost" };
  const git = (args: string[]) => exec(["git", ...args], checkout, env);
  const base = plan.destination.branch;
  const head = `hg-team/${plan.id}/${projection.fingerprint}`;
  await git(["clone", "--no-checkout", "--", plan.destination.repository, "."]);
  await git(["checkout", "--detach", `origin/${base}`]);
  const baseRevision = (await git(["rev-parse", "HEAD"])).trim();
  const adopting = !fs.existsSync(path.join(checkout, OWNERSHIP_FILE)) && plan.adoptRevision !== undefined;
  if (adopting && baseRevision !== plan.adoptRevision) throw new Error("Destination advanced since adoption review; regenerate and review the adoption plan");
  const changed = stageProjection(checkout, plan.id, projection, true, adopting);
  if (!changed.length) return { state: "unchanged", revision: (await git(["rev-parse", "HEAD"])).trim() };
  // Stage on the base, then restore a previous pending branch only if it has exactly
  // the same generated intent. This resumes interruption after push, before PR creation.
  const remote = (await git(["ls-remote", "--heads", "origin", head])).trim();
  if (remote) {
    await git(["fetch", "origin", head]);
    await git(["checkout", "-b", head, "FETCH_HEAD"]);
    const owned = JSON.parse(fs.readFileSync(path.join(checkout, OWNERSHIP_FILE), "utf8"));
    if (owned.installation !== plan.id || owned.fingerprint !== projection.fingerprint) throw new Error("Pending publication does not match the planned projection");
    if (stageProjection(checkout, plan.id, projection, true).length) throw new Error("Pending publication content differs from its fingerprint");
  } else {
    await git(["checkout", "-b", head]);
    stageProjection(checkout, plan.id, projection, false, adopting);
    await git(["add", "-A", "--", ...changed]);
    await git(["commit", "-m", `fix(team): reconcile ${plan.id} at ${projection.fingerprint.slice(0, 12)}`]);
    await git(["push", "origin", `HEAD:refs/heads/${head}`]);
  }
  const owner = plan.destination.repository.replace(/^https:\/\/github.com\//, "").replace(/^git@github.com:/, "").split("/")[0];
  const existing = await forge.request("GET", `/pulls?state=open&base=${encodeURIComponent(base)}&head=${encodeURIComponent(`${owner}:${head}`)}`);
  const pr = existing[0] ?? await forge.request("POST", "/pulls", { head, base,
    title: `Reconcile team installation ${plan.id}`, body: `Generated by hg team from declared source and bootstrap inputs.\n\nProjection: \`${projection.fingerprint}\`.\n\nAll ${projection.profiles.length} registered profiles and their companion projections publish together.` });
  let revision = (await git(["rev-parse", "HEAD"])).trim();
  if (!plan.destination.autoMerge) return { state: "pending", revision, pullRequest: pr.html_url };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await forge.request("PUT", `/pulls/${pr.number}/merge`, { sha: revision, merge_method: "merge" });
      // Not merged but not refused: review or checks are still required. That is a wait, not a
      // defect - the PR stays open and a later resume merges it.
      if (!result.merged) return { state: "pending", revision, pullRequest: pr.html_url };
      return { state: "merged", revision: result.sha, pullRequest: pr.html_url };
    } catch (error) {
      // GitHub answers 405 when branch protection blocks the merge (a missing review or check):
      // the same wait as above, surfaced as a status code.
      if (error instanceof ForgeFailure && error.status === 405 && !error.transient) return { state: "pending", revision, pullRequest: pr.html_url };
      if (!(error instanceof ForgeFailure) || !error.transient || attempt === 2) throw error;
      await git(["fetch", "origin", base]);
      // A normal merge preserves head history. Semantic conflicts fail; never force push.
      await git(["merge", "--no-edit", `origin/${base}`]);
      await git(["push", "origin", `HEAD:refs/heads/${head}`]);
      revision = (await git(["rev-parse", "HEAD"])).trim();
    }
  }
  throw new Error("Publication retry budget exhausted");
}
