// The Pulumi state backend of a team installation's bootstrap stack (ADR 0196): derived from the
// environment spec named for the stack, never whatever `pulumi login` ran last. A plan does not
// name its environment spec, but the stack name is the environment name (`hg env apply <name>`
// refuses a spec named otherwise and writes Pulumi.<name>.yaml), so the spec is found by name:
// `<bootstrap>/environments/<stack>.yaml`, or an `environment.yaml` one directory below. This
// module only reports; the credential gate decides what refuses. No spec content is ever quoted.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { envStateBucketUri, type EnvironmentSpec } from "../env/spec.ts";
import { isRecord } from "../env/stack-config.ts";

export interface TeamBackend {
  /** The one backend every usable spec agrees on; absent when none derives one, or they disagree. */
  derived?: string;
  /** The specs that derived it. */
  specs: string[];
  /** The operator's PULUMI_BACKEND_URL, when set. */
  operator?: string;
  /** Specs that disagree: each backend with the files deriving it. */
  conflicts: { backend: string; specs: string[] }[];
  /** Candidate specs that could not be used, and why - paths, codes and positions only. */
  problems: string[];
}

const ENV_SPEC_API = /^hermes-gitops\.factorylevel\.dev\/environment\//;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** A YAML parser error reduced to its position: the parser's own message quotes the source. */
export function yamlProblem(relative: string, error: unknown): string {
  const at = (error as { linePos?: { line: number; col: number }[] } | null)?.linePos?.[0];
  return `${relative} is not valid YAML${at ? ` (line ${at.line}, column ${at.col})` : ""}`;
}

export function deriveBackend(plan: { bootstrap: { directory: string; stack: string } }, root: string, operator: string | undefined = process.env.PULUMI_BACKEND_URL): TeamBackend {
  const { directory, stack } = plan.bootstrap;
  const relative = (file: string) => path.relative(root, file);
  const environments = path.resolve(root, directory, "environments");
  const problems: string[] = [];
  const candidates = [path.join(environments, `${stack}.yaml`)];
  try {
    for (const entry of fs.readdirSync(environments, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(environments, entry.name, "environment.yaml"));
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") problems.push(`${relative(environments)} cannot be listed (${code ?? "I/O error"})`);
  }
  const backends = new Map<string, string[]>();
  for (const file of candidates) {
    let text: string;
    try { text = fs.readFileSync(file, "utf8"); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") problems.push(`${relative(file)} cannot be read (${code ?? "I/O error"})`);
      continue;
    }
    let doc: unknown;
    try { doc = parse(text); } catch (error) { problems.push(yamlProblem(relative(file), error)); continue; }
    const named = file === candidates[0];
    if (!isRecord(doc) || typeof doc["apiVersion"] !== "string" || !ENV_SPEC_API.test(doc["apiVersion"])) {
      // A directory's environment.yaml may be some other document; the spec named for the stack may not.
      if (named) problems.push(`${relative(file)} is not an environment spec (no hermes-gitops.factorylevel.dev/environment apiVersion)`);
      continue;
    }
    if (doc["name"] !== stack) {
      if (named) problems.push(`${relative(file)} does not name environment ${stack}`);
      continue;
    }
    if (typeof doc["project"] !== "string" || !GCP_PROJECT.test(doc["project"])) {
      problems.push(`${relative(file)} names environment ${stack} but has no valid project`);
      continue;
    }
    const uri = envStateBucketUri({ project: doc["project"] } as EnvironmentSpec, stack);
    backends.set(uri, [...(backends.get(uri) ?? []), relative(file)]);
  }
  const conflicts = backends.size > 1 ? [...backends].map(([backend, specs]) => ({ backend, specs })) : [];
  const only = backends.size === 1 ? [...backends][0] : undefined;
  return { ...(only ? { derived: only[0], specs: only[1] } : { specs: [] }), ...(operator ? { operator } : {}), conflicts, problems };
}
