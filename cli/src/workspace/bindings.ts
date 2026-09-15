// Compile the operator-authored WorkspaceBindings declaration (issue #361,
// environment/workspaces.yaml) into deployment-neutral normalized records.
// A repository reaches a profile ONLY through a binding that names both -
// bundle membership, distribution source, credentials and prompts grant
// nothing. The compiler is pure: revision resolution reads nothing itself;
// the caller passes the profile records in as data, so compile-twice
// byte-equality holds (the topology compiler's discipline).

import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  assertNoNestedMounts,
  assertSecretName,
  assertUnique,
  assertWorkspaceMount,
  type BundleDeclarations,
  type BundleRepositoryDeclaration,
} from "../platform/profile-bundles";
import type { ValidationFinding } from "../platform/index";
import { CONTRACTS_ROOT } from "../lib.ts";

// One schema per declared apiVersion - a document names its own contract
// and is validated against exactly that; unknown versions are refused
// loudly rather than guessed at (the environment-bundles discipline).
const SCHEMA_FILES: Record<string, string> = {
  "hermes.gitops/v1alpha1": path.join(CONTRACTS_ROOT, "environment-workspaces/v1alpha1/workspaces.schema.json"),
  // v1alpha2 adds revision mode `tracked` (ADR 0197).
  "hermes.gitops/v1alpha2": path.join(CONTRACTS_ROOT, "environment-workspaces/v1alpha2/workspaces.schema.json"),
};

export type WorkspaceRevision =
  | { mode: "pinned"; sha: string }
  | { mode: "application-revision"; application: string }
  | { mode: "tracked"; branch: string; refreshInterval: string };

/** A tracked binding's release channel (ADR 0197): the pod clones the
 * branch tip at boot and fast-forwards it in place every interval. */
export interface WorkspaceTracking {
  branch: string;
  refreshInterval: string;
}

/** The refresh floor. The schema's pattern already refuses less; the
 * compiler re-checks so a declaration built in code cannot slip under it. */
export const MIN_REFRESH_SECONDS = 300;

/** `30m` / `1h` -> seconds. Throws on anything else or on a value below
 * the floor - the chart and the sync container read the same units. */
export function parseRefreshInterval(value: string): number {
  const match = /^([1-9][0-9]*)(m|h)$/.exec(value);
  if (!match) throw new Error(`refreshInterval ${JSON.stringify(value)} must be whole minutes or hours, e.g. 30m or 1h`);
  const seconds = Number(match[1]) * (match[2] === "h" ? 3600 : 60);
  if (seconds < MIN_REFRESH_SECONDS) {
    throw new Error(`refreshInterval ${JSON.stringify(value)} is below the 5m minimum`);
  }
  return seconds;
}

/** Why a branch name is unsafe to track, or null. The schema's rules,
 * restated where the value becomes a shell word and a git refspec. */
export function trackedBranchProblem(branch: string): string | null {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(branch)) return "may only contain letters, digits, '.', '_', '-' and '/'";
  if (branch.startsWith("refs/")) return "is named without the refs/heads/ prefix";
  if (branch === "HEAD") return "may not be HEAD";
  if (/^[-./]/.test(branch) || /[/.]$/.test(branch)) return "may not start with '-', '.' or '/', or end with '/' or '.'";
  if (branch.includes("..") || branch.includes("//") || /\/[.-]/.test(branch)) return "may not contain '..', '//' or a component starting with '.' or '-'";
  if (/\.lock(\/|$)/.test(branch)) return "may not contain a '.lock' component";
  if (/^[0-9a-f]{40}$/.test(branch)) return "is a commit, not a branch - pin it with mode: pinned";
  return null;
}

export interface WorkspaceRepositoryDeclaration {
  name: string;
  /** `"self"` = the bound profile's OWN distribution repository, resolved
   * per profile from its deployed record (url from spec.source, revision
   * from spec.sha, credential from spec.gitAuthSecretRef). Still an
   * explicit grant - installing a distribution mounts nothing until a
   * binding says self. */
  source:
    | "self"
    | {
        url: string;
        revision: WorkspaceRevision;
        authSecretRef?: string;
      };
  mount: {
    path: string;
    access: "read-only" | "read-write";
  };
}

export interface WorkspaceBindingDeclaration {
  repository: string;
  profiles: string[];
  purpose: string;
}

export interface WorkspaceDeclarations {
  apiVersion: string;
  kind: string;
  repositories: WorkspaceRepositoryDeclaration[];
  bindings: WorkspaceBindingDeclaration[];
}

/** The subset of a profile record the compiler resolves against. The
 * CALLER reads `profiles/<name>/profile.yaml`; passing `sha: undefined`
 * (hg validate has no gitops clone) keeps every structural rule live
 * while deferring resolution to where records exist. */
export interface WorkspaceProfileRecord {
  source?: string;
  sha?: string;
  /** The record's namespace-local distribution-clone credential - what a
   * `source: self` repository mounts with (same repository, same key). */
  gitAuthSecretRef?: string;
  /** The record's `spec.runtime`. Only an Eve agent can refresh a tracked
   * workspace in its pod; undefined = unknown, which refuses nothing. */
  runtime?: string;
}

/** One compiled binding - the generated model of #361. The runtime
 * renderer decides bundle mount vs independent-profile mount; nothing
 * here encodes that choice. */
export interface NormalizedWorkspaceBinding {
  repository: string;
  source: string;
  /** A full commit for pinned, application-revision and self bindings.
   * Always "" for a tracked binding: its commit is whatever the pod last
   * refreshed to, never a compiled value. */
  resolvedRevision: string;
  mountPath: string;
  access: "read-only" | "read-write";
  purpose: string;
  targetProfiles: string[];
  authSecretRef?: string;
  /** Present only for a tracked binding (ADR 0197). */
  tracking?: WorkspaceTracking;
}

export interface WorkspaceCompileResult {
  bindings: NormalizedWorkspaceBinding[];
  findings: ValidationFinding[];
}

const FULL_SHA = /^[0-9a-f]{40}$/;

function dump(value: unknown): string {
  return stringifyYaml(value, { sortMapEntries: true, lineWidth: 0 });
}

/** Compare git URLs by identity, not spelling: the same repository is
 * legally written `git@github.com:org/x.git`, `https://github.com/org/x`
 * and `ssh://git@github.com/org/x`. Resolution against a deployed record
 * must not fail (or worse, pass) on the notation. */
export function canonicalGitUrl(url: string): string {
  return url
    .trim()
    .replace(/^git@([^:/]+):/, "$1/")
    .replace(/^(?:https?|ssh|git):\/\//, "")
    .replace(/^git@/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

export function loadWorkspaceDeclarations(file: string): WorkspaceDeclarations {
  const raw = parseYaml(fs.readFileSync(file, "utf8")) as WorkspaceDeclarations;
  const schemaFile = SCHEMA_FILES[raw?.apiVersion as string];
  if (!schemaFile) {
    throw new Error(
      `${file}: unsupported apiVersion ${JSON.stringify(raw?.apiVersion)} ` +
        `(supported: ${Object.keys(SCHEMA_FILES).join(", ")})`,
    );
  }
  const schema = JSON.parse(fs.readFileSync(schemaFile, "utf8"));
  const ajv = new Ajv2020({ allErrors: true, useDefaults: true });
  const validate = ajv.compile(schema);
  if (!validate(raw)) {
    const lines = (validate.errors ?? []).map((error) => {
      const extra =
        "additionalProperty" in error.params
          ? ` (${JSON.stringify(error.params["additionalProperty"])})`
          : "";
      return `${error.instancePath || "/"} ${error.message ?? "invalid"}${extra}`;
    });
    throw new Error(`${file} failed workspace schema validation:\n- ${lines.join("\n- ")}`);
  }
  return raw;
}

/** Read every emitted profile record's `{source, sha}` from a gitops
 * tree - the caller-side half of revision resolution (the compiler stays
 * pure). Missing or unparseable records simply yield no entry; the
 * compiler then reports the unknown profile/application by name. */
export function readWorkspaceProfileRecords(gitopsDir: string): Map<string, WorkspaceProfileRecord> {
  const records = new Map<string, WorkspaceProfileRecord>();
  const root = path.join(gitopsDir, "profiles");
  if (!fs.existsSync(root)) return records;
  for (const name of fs.readdirSync(root)) {
    const file = path.join(root, name, "profile.yaml");
    if (!fs.existsSync(file)) continue;
    try {
      const record = parseYaml(fs.readFileSync(file, "utf8")) as {
        spec?: { source?: string; sha?: string; gitAuthSecretRef?: string; runtime?: string };
      } | null;
      records.set(name, {
        source: record?.spec?.source,
        sha: record?.spec?.sha,
        gitAuthSecretRef: record?.spec?.gitAuthSecretRef,
        runtime: record?.spec?.runtime,
      });
    } catch {
      // A corrupt record is the emitter's problem; the compiler will
      // name the profile as unresolved rather than hiding it here.
    }
  }
  return records;
}

/** Compile declarations into normalized bindings. Data errors accumulate
 * as findings instead of throwing: `hg validate` reports every violation
 * at once, and `ok` is `no error findings` computed by the caller. */
export function compileWorkspaceBindings(
  declarations: WorkspaceDeclarations,
  profileRecords: Map<string, WorkspaceProfileRecord>,
  opts: { requireResolution: boolean },
): WorkspaceCompileResult {
  const findings: ValidationFinding[] = [];
  const error = (profile: string, message: string, fix?: string) =>
    findings.push({ profile, severity: "error", check: "workspaces", message, ...(fix ? { fix } : {}) });
  const warn = (profile: string, message: string) =>
    findings.push({ profile, severity: "warning", check: "workspaces", message });
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (thrown) {
      error("*", thrown instanceof Error ? thrown.message : String(thrown));
    }
  };

  guard(() =>
    assertUnique(
      declarations.repositories.map((repository) => repository.name),
      "workspace repositories",
    ),
  );

  const repositoryByName = new Map<string, WorkspaceRepositoryDeclaration>();
  for (const repository of declarations.repositories) {
    if (!repositoryByName.has(repository.name)) repositoryByName.set(repository.name, repository);
    guard(() => assertWorkspaceMount(repository.mount.path, `workspace repository ${repository.name} mount.path`));
    const source = repository.source;
    if (source === "self") continue; // resolved per profile below
    if (source.authSecretRef) {
      guard(() =>
        assertSecretName(source.authSecretRef!, `workspace repository ${repository.name} authSecretRef`),
      );
    }
    // The only private-repository signal a pure compiler has is the URL
    // scheme: ssh remotes cannot be cloned anonymously, so a missing
    // credential reference is certain breakage, not a maybe.
    const url = source.url;
    if ((/^git@/.test(url) || /^ssh:\/\//.test(url)) && !source.authSecretRef) {
      error(
        "*",
        `workspace repository ${repository.name}: ssh source ${JSON.stringify(url)} needs authSecretRef ` +
          "naming the namespace-local Git credential Secret",
        "add source.authSecretRef to the repository declaration",
      );
    }
  }

  const bound = new Set<string>();
  const bindings: NormalizedWorkspaceBinding[] = [];
  for (const binding of declarations.bindings) {
    const repository = repositoryByName.get(binding.repository);
    if (!repository) {
      error(
        "*",
        `workspace binding ${JSON.stringify(binding.repository)} does not name a declared repository`,
        "declare it under repositories or fix the binding's repository field",
      );
      continue;
    }
    bound.add(binding.repository);

    for (const profile of binding.profiles) {
      if (!profileRecords.has(profile)) {
        error(
          profile,
          `workspace binding ${binding.repository}: unknown profile ${JSON.stringify(profile)}`,
          "bind only installed profiles - check the profile name against profiles/",
        );
      }
    }

    // `self`: the bound profile's own distribution repository, resolved
    // PER PROFILE - each target's record supplies url, deployed sha and
    // the namespace-local clone credential, so one declaration serves
    // every profile without naming any of them. Expansion is one
    // normalized binding per profile because the resolved facts differ.
    if (repository.source === "self") {
      for (const profile of binding.profiles) {
        const record = profileRecords.get(profile);
        if (!record) continue; // the unknown-profile error above already fired
        if (opts.requireResolution) {
          if (!record.sha || !FULL_SHA.test(record.sha) || !record.source) {
            error(
              profile,
              `workspace repository ${repository.name}: profile ${profile}'s record has no ` +
                "source and full commit SHA to resolve self against",
            );
            continue;
          }
        }
        bindings.push({
          repository: repository.name,
          source: record.source ?? "self",
          resolvedRevision: record.sha && FULL_SHA.test(record.sha) ? record.sha : "",
          mountPath: repository.mount.path,
          access: repository.mount.access,
          purpose: binding.purpose,
          targetProfiles: [profile],
          ...(record.gitAuthSecretRef ? { authSecretRef: record.gitAuthSecretRef } : {}),
        });
      }
      continue;
    }

    // A tracked binding (ADR 0197) compiles to its release channel, never
    // a commit: the pod clones the branch tip and refreshes it in place.
    // Only a standalone Eve agent runs the refresh - a record naming
    // another runtime refuses here rather than rendering a chart that
    // expects a sha (bundles refuse in mergeWorkspacesIntoBundles).
    if (repository.source.revision.mode === "tracked") {
      const { branch, refreshInterval } = repository.source.revision;
      let valid = true;
      const branchProblem = trackedBranchProblem(branch);
      if (branchProblem) {
        valid = false;
        error("*", `workspace repository ${repository.name}: tracked branch ${JSON.stringify(branch)} ${branchProblem}`);
      }
      try {
        parseRefreshInterval(refreshInterval);
      } catch (thrown) {
        valid = false;
        error("*", `workspace repository ${repository.name}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
      }
      for (const profile of binding.profiles) {
        const runtime = profileRecords.get(profile)?.runtime;
        if (runtime !== undefined && runtime !== "eve") {
          valid = false;
          error(
            profile,
            `workspace repository ${repository.name} tracks branch ${branch}, but profile ${profile} runs ` +
              `${JSON.stringify(runtime)} - only Eve agents refresh a workspace in the pod`,
            "pin the repository (mode: pinned) for this profile",
          );
        }
      }
      if (!valid) continue;
      bindings.push({
        repository: repository.name,
        source: repository.source.url,
        resolvedRevision: "",
        mountPath: repository.mount.path,
        access: repository.mount.access,
        purpose: binding.purpose,
        targetProfiles: [...binding.profiles],
        ...(repository.source.authSecretRef ? { authSecretRef: repository.source.authSecretRef } : {}),
        tracking: { branch, refreshInterval },
      });
      continue;
    }

    // Resolve the revision to a full immutable SHA. Mutable refs are
    // schema-rejected for pinned mode; application-revision resolves
    // against the named application's DEPLOYED record, and refuses when
    // the record's source is a different repository - mounting repo X at
    // unrelated repo Y's revision would silently ship the wrong tree.
    let resolvedRevision: string | undefined;
    const revision = repository.source.revision;
    if (revision.mode === "pinned") {
      resolvedRevision = revision.sha;
    } else {
      const record = profileRecords.get(revision.application);
      if (!record) {
        error(
          "*",
          `workspace repository ${repository.name}: application-revision names unknown application ` +
            JSON.stringify(revision.application),
          "the application must be an installed profile with a deployed record",
        );
      } else if (opts.requireResolution) {
        if (!record.sha || !FULL_SHA.test(record.sha)) {
          error(
            "*",
            `workspace repository ${repository.name}: application ${revision.application}'s record has no ` +
              "full commit SHA to resolve against",
          );
        } else if (!record.source || canonicalGitUrl(record.source) !== canonicalGitUrl(repository.source.url)) {
          error(
            "*",
            `workspace repository ${repository.name}: application ${revision.application}'s record tracks ` +
              `${JSON.stringify(record.source ?? "(no source)")}, not ${JSON.stringify(repository.source.url)} - ` +
              "an application revision only pins the repository that application deploys from",
          );
        } else {
          resolvedRevision = record.sha;
        }
      }
    }
    if (opts.requireResolution && resolvedRevision === undefined) continue;

    bindings.push({
      repository: repository.name,
      source: repository.source.url,
      // Unresolved is representable only in the no-resolution mode
      // (hg validate without a gitops clone); emitters always resolve.
      resolvedRevision: resolvedRevision ?? "",
      mountPath: repository.mount.path,
      access: repository.mount.access,
      purpose: binding.purpose,
      targetProfiles: [...binding.profiles],
      ...(repository.source.authSecretRef ? { authSecretRef: repository.source.authSecretRef } : {}),
    });
  }

  for (const repository of declarations.repositories) {
    if (!bound.has(repository.name)) {
      warn("*", `workspace repository ${repository.name} is declared but bound to no profile - dead configuration`);
    }
  }

  // Per-profile mount coherence: the same profile must not receive two
  // repositories at the same or nested paths, whatever bindings deliver
  // them. Access defaults to none - profiles outside every binding are
  // simply absent here.
  const mountsByProfile = new Map<string, string[]>();
  for (const binding of bindings) {
    for (const profile of binding.targetProfiles) {
      const mounts = mountsByProfile.get(profile) ?? [];
      mounts.push(binding.mountPath);
      mountsByProfile.set(profile, mounts);
    }
  }
  for (const [profile, mounts] of mountsByProfile) {
    try {
      assertUnique(mounts, `profile ${profile} workspace mount paths`);
      assertNoNestedMounts(mounts, `profile ${profile} workspace mount paths`);
    } catch (thrown) {
      error(profile, thrown instanceof Error ? thrown.message : String(thrown));
    }
  }

  return { bindings, findings };
}

/** Fold compiled bindings into the authored bundle declarations, so the
 * EXISTING bundle compiler and chart render per-profile mounts unchanged.
 * Returns a new declarations object; the authored one is not mutated.
 *
 * Bindings are the ONLY source of bundle repositories: authored
 * bundle-local `repositories`/`repositoryRefs` are refused upstream by
 * loadBundleDeclarations (#365), so the merge writes the generated fields
 * outright. */
export function mergeWorkspacesIntoBundles(
  declarations: BundleDeclarations,
  bindings: NormalizedWorkspaceBinding[],
): BundleDeclarations {
  const merged: BundleDeclarations = JSON.parse(JSON.stringify(declarations));

  for (const bundle of merged.bundles ?? []) {
    const memberNames = new Set(bundle.profiles.map((profile) => profile.name));
    const relevant = bindings.filter((binding) =>
      binding.targetProfiles.some((profile) => memberNames.has(profile)),
    );
    if (relevant.length === 0) continue;

    const additions = new Map<string, BundleRepositoryDeclaration>();
    for (const binding of relevant) {
      // A bundle mounts each checkout into its members through a subPath,
      // which pins the directory when the member starts: an in-pod refresh
      // could never reach them (ADR 0197 cost). Refuse, never half-work.
      if (binding.tracking) {
        throw new Error(
          `bundle ${bundle.name}: repository ${binding.repository} tracks branch ${binding.tracking.branch}, ` +
            "but bundled agents mount workspaces through a subPath that an in-pod refresh cannot reach - " +
            "deploy the bound agents standalone, or pin the repository",
        );
      }
      const record: BundleRepositoryDeclaration = {
        name: binding.repository,
        source: binding.source,
        sha: binding.resolvedRevision,
        mountPath: binding.mountPath,
        access: binding.access,
        ...(binding.authSecretRef ? { gitAuthSecretRef: binding.authSecretRef } : {}),
      };
      // One repository name = one physical checkout in the bundle PVC.
      // A `self` binding expands per profile, and two co-bundled profiles
      // whose records resolve to DIFFERENT sources/revisions/credentials
      // would silently share whichever landed last - refuse instead;
      // identical duplicates (several bindings, one repository) collapse.
      const prior = additions.get(binding.repository);
      if (prior && JSON.stringify(prior) !== JSON.stringify(record)) {
        throw new Error(
          `bundle ${bundle.name}: repository ${binding.repository} resolves differently for ` +
            `different bound profiles (${prior.sha.slice(0, 12)}@${prior.source} vs ` +
            `${record.sha.slice(0, 12)}@${record.source}) - one bundle checkout cannot serve both`,
        );
      }
      additions.set(binding.repository, record);
    }
    bundle.repositories = [...additions.values()];
    // A bundle's checkouts are PHYSICAL (one PVC): mounts that merely
    // belong to different profiles still collide at the bundle level, and
    // the bundle compiler would refuse three steps later. Refuse here, in
    // the one place validate, plan and up all pass through.
    const bundleMounts = bundle.repositories.map((repository) => repository.mountPath);
    assertUnique(bundleMounts, `bundle ${bundle.name} repository mount paths`);
    assertNoNestedMounts(bundleMounts, `bundle ${bundle.name} repository mount paths`);

    for (const profile of bundle.profiles) {
      const assigned = [
        ...new Set(
          relevant
            .filter((binding) => binding.targetProfiles.includes(profile.name))
            .map((binding) => binding.repository),
        ),
      ];
      if (assigned.length === 0) continue;
      profile.repositoryRefs = assigned;
    }
  }
  return merged;
}

const BINDINGS_FILE = "deployments/workspaces/bindings.yaml";
const WORKSPACES_ROOT = "deployments/workspaces";

/** The generated artifacts. Two shapes from one compile:
 *
 * - `bindings.yaml` - every normalized binding, sorted for byte-stable
 *   emission. The canonical record; a schema waits for its consumer.
 * - `profiles/<name>.yaml` - a chart VALUES file per bound profile that is
 *   NOT bundle-placed, containing exactly `spec.workspace` in the
 *   hermes-profile chart's shape (#362). The agents ApplicationSets and
 *   the local loop layer it onto the release; an unbound profile has no
 *   file and renders byte-identically to before the feature.
 *
 * Bundled profiles are excluded here - their mounts travel through the
 * bundle values (mergeWorkspacesIntoBundles). */
export function workspaceFiles(
  bindings: NormalizedWorkspaceBinding[],
  bundledProfiles: ReadonlySet<string> = new Set(),
  terminalCwds: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const files = new Map<string, string>();
  if (bindings.length === 0) return files;
  const sorted = [...bindings].sort(
    (a, b) => a.repository.localeCompare(b.repository) || a.purpose.localeCompare(b.purpose),
  );
  files.set(BINDINGS_FILE, dump({ spec: { bindings: sorted } }));

  const byProfile = new Map<string, NormalizedWorkspaceBinding[]>();
  for (const binding of sorted) {
    for (const profile of binding.targetProfiles) {
      if (bundledProfiles.has(profile)) continue;
      byProfile.set(profile, [...(byProfile.get(profile) ?? []), binding]);
    }
  }
  for (const [profile, assigned] of byProfile) {
    if (assigned.length > 1 && !terminalCwds[profile]) {
      // The declaration has no per-profile terminalCwd surface yet, and
      // the chart refuses several repositories without one - fail here,
      // at compile, instead of shipping values Argo cannot render.
      throw new Error(
        `profile ${profile}: ${assigned.length} workspace repositories bound to an independently ` +
          "deployed profile - multi-repository independent profiles need a terminalCwd authoring " +
          "surface that does not exist yet (bind one repository, or bundle the profile)",
      );
    }
    const terminalCwd = terminalCwds[profile] || assigned[0]!.mountPath;
    if (!assigned.some(binding => binding.mountPath === terminalCwd)) {
      throw new Error(`profile ${profile}: terminalCwd must name a bound repository mount`);
    }
    // A tracked repository carries its channel instead of a sha: the
    // eve-agent chart renders the sync container from `tracking`, and the
    // values never change on a refresh, so neither does the pod.
    const repositories = assigned.map((binding) => ({
      name: binding.repository,
      source: binding.source,
      ...(binding.tracking
        ? { tracking: { branch: binding.tracking.branch, refreshInterval: binding.tracking.refreshInterval } }
        : { sha: binding.resolvedRevision }),
      mountPath: binding.mountPath,
      access: binding.access,
      ...(binding.authSecretRef ? { gitAuthSecretRef: binding.authSecretRef } : {}),
    }));
    files.set(
      `${WORKSPACES_ROOT}/profiles/${profile}.yaml`,
      dump({ spec: { workspace: { repositories, terminalCwd } } }),
    );
  }
  return files;
}

/** Desired-set writer for the deployments/workspaces tree: write what
 * changed, delete what is no longer desired, prune empty dirs. */
export function writeWorkspaceTree(
  gitopsDir: string,
  files: Map<string, string>,
  checkOnly = false,
): { written: string[]; deleted: string[]; changed: boolean } {
  const root = path.join(gitopsDir, WORKSPACES_ROOT);
  const existing: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      const absolute = path.join(dir, entry);
      if (fs.statSync(absolute).isDirectory()) walk(absolute);
      else existing.push(path.posix.join(WORKSPACES_ROOT, path.relative(root, absolute).split(path.sep).join("/")));
    }
  };
  walk(root);

  const deleted = existing.filter((rel) => !files.has(rel));
  const written: string[] = [];
  for (const [rel, content] of files) {
    const absolute = path.join(gitopsDir, rel);
    const current = fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined;
    if (current !== content) written.push(rel);
  }
  const changed = written.length > 0 || deleted.length > 0;
  if (checkOnly || !changed) return { written, deleted, changed };

  for (const rel of deleted) fs.rmSync(path.join(gitopsDir, rel), { force: true });
  for (const rel of written) {
    const absolute = path.join(gitopsDir, rel);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, files.get(rel)!);
  }
  for (const dir of [path.join(root, "profiles"), root]) {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  }
  return { written, deleted, changed };
}
