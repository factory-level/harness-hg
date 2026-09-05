// Bootstrap stage 2 — `hermes profile install <source>#<ref>` per entry in
// the `agents:` stack config list. Each install invokes the gitops-emitter
// plugin (installed + configured in stage 1), which renders that agent's
// HermesProfile record and pushes it to the GitOps repo — scaffolding the
// repo from infra/gitops-template/ on the very first install if it doesn't exist
// yet (see gitops_emitter/README.md's "Scaffold behavior").
//
// One local.Command per agent, run SERIALLY (each chained via dependsOn
// onto the previous agent's Command, not just onto stage 1) rather than in
// parallel: any of them may be the one that scaffolds the GitOps repo on
// first run (ensure_repo_and_scaffold in gitops_emitter/scaffold.py), and
// two concurrent first-installs would race that repo-creation/scaffold
// step.
//
// Idempotency: `hermes profile install <source> --force -y` is safe to
// rerun unconditionally (--force overwrites an existing profile of the
// same name, user data preserved per the fork's own contract) — a second
// run with unchanged content is a cheap no-op all the way down, because
// gitops_emitter/gitrepo.py's publish() never creates an empty commit for
// byte-identical content. `triggers` on top of that means `pulumi up` only
// re-runs the Command at all when the pinned inputs actually change.
//
// HERMES_GITOPS_REQUIRE_EMITTER=1 is set on every agent Command so a broken
// or unsubscribed plugin fails the install loudly (see
// gitops_emitter/README.md's "Fail-loud semantics") instead of silently
// proceeding as if GitOps sync were optional (plugin push failure ->
// hermes exits 1 -> Command fails -> `pulumi up` fails).

import { spawnSync } from "node:child_process";
import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";
import { shellQuote } from "../hermes-install/index.ts";
import { checkAgentTopology } from "./topology-preview.ts";
import type { AgentSpec, BootstrapConfig } from "../../../control-flow/config.ts";

/** Derive a stable, valid Pulumi resource-name suffix for an agent.
 *
 * Prefers the explicit `name` (matches `hermes profile install --name`, so
 * the Pulumi resource name and the installed profile name agree); falls
 * back to a sanitized form of `source` PLUS `subdir` when `name` is unset
 * (the distribution's own manifest name isn't known until install time).
 * The subdir must participate: an application repository ships many
 * distributions, so several agents[] entries legitimately share one
 * source URL and differ only by subdir - source alone would collide the
 * per-agent Command URNs (found by the four-profile marketing fleet). */
export function agentSlug(agent: AgentSpec): string {
  const base =
    agent.name || (agent.subdir ? `${agent.source}/${agent.subdir}` : agent.source);
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

/** Render the HERMES_GITOPS_OVERRIDES document for an agent, or null if
 * there's nothing to override (no need for the env var / a temp file at
 * all — see gitops_emitter/README.md's "HERMES_GITOPS_OVERRIDES contract").
 *
 * Serialized as JSON — a strict subset of YAML, so the plugin's
 * yaml.safe_load reads it unchanged and this program needs no YAML
 * dependency of its own. The document is exactly `agents[].overrides`
 * (apps/deployment/expose/gitAuthSecretRef — the old workload_selection
 * channel died with the workload menu). */
export function overridesDocument(agent: AgentSpec): string | null {
  const doc: Record<string, unknown> = { ...(agent.overrides ?? {}) };
  if (Object.keys(doc).length === 0) return null;
  return JSON.stringify(doc, null, 2) + "\n";
}

// The install script is STATIC (issue #32 [K1]): every per-agent value
// rides in `environment` as its own key, so `pulumi preview` renders a
// legible per-key before/after of the desired state (source, ref, name,
// overrides document) instead of a shell-text diff
// or an opaque "will run a command". An environment change is an UPDATE
// (re-runs the idempotent install), never a spurious replace.
// Real update semantics (issue #23 [F5]): a FIRST install runs
// \`hermes profile install\` (no --force) and fires the fork's
// profile_install hook; when the profile already exists, the fork's
// already-exists error names it and the script dispatches to
// \`hermes profile update <name>\` instead - firing profile_update, so
// commit messages say "update" and F3's event dispatch routes it
// through the PR gate. (HERMES_GITOPS_DESIRED_SOURCE_SHA is not consumed
// here - it is a plan-time-resolved INPUT whose change is what re-runs
// this Command when a mutable ref moves upstream.)
// Decommission on removal (issue #24 [F6]): the Command's delete action
// prunes profiles/<name>/ from the GitOps repo via the plugin's
// decommission CLI (same direct-vs-PR posture as install/update),
// making the ApplicationSet drop the Application and Argo CD prune the
// workload. Name resolution: explicit name when declared, else by
// spec.source match. Runs with the installed tool's interpreter; if the
// hermes venv is already gone (full-stack destroy teardown races), the
// removal is skipped with a loud message rather than blocking destroy.
export const AGENT_DECOMMISSION_SCRIPT = `set -eu
export PATH="\${UV_TOOL_BIN_DIR:-$HOME/.local/bin}:$PATH"
if ! command -v hermes >/dev/null 2>&1; then
  echo "hermes-agent decommission: hermes tool not found - skipping GitOps prune for \${HERMES_GITOPS_DESIRED_NAME:-\$HERMES_GITOPS_DESIRED_SOURCE} (remove profiles/<name>/ from the GitOps repo manually if it still exists)" >&2
  exit 0
fi
first_line="$(sed -n '1p' "$(command -v hermes)")"
if [ "$first_line" = '#!/bin/sh' ]; then
  HERMES_PY="$(sed -n '2p' "$(command -v hermes)" | sed -E "s/^'''exec' '([^']+)'.*/\\1/")"
else
  case "$first_line" in
    '#!'*) rest="\${first_line#??}"; HERMES_PY="\${rest%% *}" ;;
    *) HERMES_PY="" ;;
  esac
fi
if [ -z "$HERMES_PY" ] || [ ! -x "$HERMES_PY" ]; then
  echo "hermes-agent decommission: could not resolve the hermes interpreter - skipping GitOps prune" >&2
  exit 0
fi
if [ -n "\${HERMES_GITOPS_DESIRED_NAME:-}" ]; then
  "$HERMES_PY" -m gitops_emitter.decommission_cli "$HERMES_GITOPS_DESIRED_NAME"
else
  "$HERMES_PY" -m gitops_emitter.decommission_cli --source "$HERMES_GITOPS_DESIRED_SOURCE"
fi
`;

export const AGENT_INSTALL_SCRIPT = `set -eu
export PATH="\${UV_TOOL_BIN_DIR:-$HOME/.local/bin}:$PATH"
SRC="$HERMES_GITOPS_DESIRED_SOURCE"
if [ -n "\${HERMES_GITOPS_DESIRED_REF:-}" ]; then
  SRC="$SRC#$HERMES_GITOPS_DESIRED_REF"
fi
if [ -n "\${HERMES_GITOPS_DESIRED_OVERRIDES_DOC:-}" ]; then
  OVERRIDES_DIR="\${TMPDIR:-/tmp}/hermes-gitops-bootstrap/overrides"
  mkdir -p "$OVERRIDES_DIR"
  OVERRIDES_FILE="$OVERRIDES_DIR/\${HERMES_GITOPS_AGENT_SLUG:-agent}.yaml"
  printf '%s' "$HERMES_GITOPS_DESIRED_OVERRIDES_DOC" > "$OVERRIDES_FILE"
  export HERMES_GITOPS_OVERRIDES="$OVERRIDES_FILE"
fi
# The agent-team layout (ADR 0178): a subdir ending in /src is the payload
# alone, and \`hermes profile install --subdir\` stages exactly that - the
# emitter hook cannot see ../harness-hg from inside the install. Clone the
# source at the resolved sha beside it and name the contract directory;
# the emitter REFUSES a /src subdir with no contract rather than emitting a
# record with zero apps.
SUBDIR_NORM="\${HERMES_GITOPS_DESIRED_SUBDIR:-}"
SUBDIR_NORM="\${SUBDIR_NORM%/}"
case "$SUBDIR_NORM" in
  */src|src)
    CSRC="$HERMES_GITOPS_DESIRED_SOURCE"
    case "$CSRC" in
      http://*|https://*|git@*|ssh://*|/*|.*|~*) ;;
      *) CSRC="https://$CSRC" ;;
    esac
    CWORK="$(mktemp -d "\${TMPDIR:-/tmp}/hermes-gitops-contract.XXXXXX")"
    trap 'rm -rf "$CWORK"' EXIT
    GIT_TERMINAL_PROMPT=0 git clone --quiet "$CSRC" "$CWORK/src"
    if [ -n "\${HERMES_GITOPS_DESIRED_SOURCE_SHA:-}" ]; then
      git -C "$CWORK/src" checkout --quiet --detach "$HERMES_GITOPS_DESIRED_SOURCE_SHA"
    elif [ -n "\${HERMES_GITOPS_DESIRED_REF:-}" ]; then
      git -C "$CWORK/src" checkout --quiet --detach "$HERMES_GITOPS_DESIRED_REF"
    fi
    AGENT_DIR="\${SUBDIR_NORM%/src}"
    AGENT_DIR="\${AGENT_DIR%src}"
    export HERMES_GITOPS_CONTRACT_DIR="$CWORK/src/\${AGENT_DIR:+$AGENT_DIR/}harness-hg"
    ;;
esac
set -- hermes profile install "$SRC" -y
if [ -n "\${HERMES_GITOPS_DESIRED_NAME:-}" ]; then
  set -- "$@" --name "$HERMES_GITOPS_DESIRED_NAME"
fi
if [ -n "\${HERMES_GITOPS_DESIRED_SUBDIR:-}" ]; then
  set -- "$@" --subdir "$HERMES_GITOPS_DESIRED_SUBDIR"
fi
set +e
INSTALL_OUT="$("$@" 2>&1)"
INSTALL_RC=$?
set -e
printf '%s\n' "$INSTALL_OUT"
if [ $INSTALL_RC -ne 0 ]; then
  EXISTING_NAME="$(printf '%s' "$INSTALL_OUT" | sed -n "s/.*Profile '\\([^']*\\)' already exists.*/\\1/p" | head -1)"
  if [ -z "$EXISTING_NAME" ]; then
    exit $INSTALL_RC
  fi
  # An existing profile is re-installed IN PLACE with --force, not
  # \`profile update\`: update re-reads the profile's STORED source and
  # subdir and has no --subdir of its own, so a subdir that moved (ADR
  # 0178's agents/<harness>/<name>/src) failed with "Subdirectory
  # 'distributions/<x>' does not exist". This host-side profile store is
  # only the emitter hook's trigger - the pod installs itself from its own
  # clone at boot - so --force here loses nothing the fleet holds.
  "$@" --force
fi
`;

/** Resolve a mutable source ref to a concrete sha at plan time (issue
 * #23 [F5]). A 40-hex ref is already immutable and returned as-is; a
 * branch/tag (or unset ref = the remote HEAD) is resolved via
 * `git ls-remote`, so an upstream commit changes this Command input and
 * `pulumi up` re-runs the install/update instead of silently keeping a
 * stale sha. Returns null (with a preview warning) when resolution
 * fails (e.g. offline) - drift detection degrades, correctness doesn't. */
export function resolveSourceRevision(source: string, ref: string): string | null {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  let remote = source;
  if (!/^(?:[a-z+]+:\/\/|git@|\/|\.|~)/.test(remote) && /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}\//.test(remote)) {
    remote = `https://${remote}`;
  }
  const target = ref || "HEAD";
  const run = spawnSync("git", ["ls-remote", remote, target], {
    timeout: 15_000,
    encoding: "utf-8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (run.status !== 0) return null;
  const line = (run.stdout ?? "").split("\n").find((l) => l.trim() !== "");
  const sha = line?.split("\t")[0]?.trim();
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Per-agent desired-state environment (issue #32 [K1]) — the Command
 * inputs `pulumi preview` diffs. Pure; unit-tested. */
export function agentDesiredStateEnv(
  agent: AgentSpec,
  overridesDoc: string | null,
  // Injectable for hermetic tests; the default does a real ls-remote.
  resolver: (source: string, ref: string) => string | null = resolveSourceRevision,
): Record<string, string> {
  const env: Record<string, string> = {
    HERMES_GITOPS_DESIRED_SOURCE: agent.source,
    HERMES_GITOPS_AGENT_SLUG: agentSlug(agent),
  };
  if (agent.ref) env["HERMES_GITOPS_DESIRED_REF"] = agent.ref;
  if (agent.subdir) env["HERMES_GITOPS_DESIRED_SUBDIR"] = agent.subdir;
  if (agent.name) env["HERMES_GITOPS_DESIRED_NAME"] = agent.name;
  if (overridesDoc !== null) env["HERMES_GITOPS_DESIRED_OVERRIDES_DOC"] = overridesDoc;
  const resolved = resolver(agent.source, agent.ref);
  if (resolved !== null) {
    env["HERMES_GITOPS_DESIRED_SOURCE_SHA"] = resolved;
  } else {
    pulumi.log.warn(
      `hermes-agent ${agentSlug(agent)}: could not resolve ${agent.source}` +
        `${agent.ref ? "#" + agent.ref : ""} to a sha at plan time - ` +
        "mutable-ref drift will not re-trigger this install until " +
        "resolution succeeds",
    );
  }
  return env;
}

export interface HermesAgentsArgs {
  config: BootstrapConfig;
  // Stage 1's resources (empty when stages.hermes was false this run),
  // chained onto the first agent's Command; every subsequent agent's
  // Command chains onto the previous agent's, enforcing the serial install
  // order documented above.
  dependsOn: pulumi.Resource[];
}

export class HermesAgents extends pulumi.ComponentResource {
  readonly resources: pulumi.Resource[];

  constructor(name: string, args: HermesAgentsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:HermesAgents", name, {}, opts);
    const cfg = args.config;

    // Plan-time topology gate (#145): an unresolved required capability
    // in any agent's contract fails preview here, before a single
    // Command is registered. Throws on compile errors; degrades with a
    // warning when a source cannot be fetched (same asymmetry as
    // resolveSourceRevision - correctness never depends on being online).
    // The registered targetClusters[] names ride along so TOPO017 (#176)
    // joins cluster registration with topology consumption, and the
    // agentSecrets variable NAMES (never values) feed the reserved-env
    // collision check - the render-time envGuard cannot see them.
    checkAgentTopology(
      cfg.agents,
      cfg.targetClusters.map((t) => t.name),
      Object.values(cfg.agentSecrets).flatMap((vars) => Object.keys(vars)),
    );

    const resources: pulumi.Resource[] = [];
    let previous: pulumi.Resource[] = [...args.dependsOn];

    // Only Hermes agents install through `hermes profile install`; Eve
    // agents (ADR-149) are emitted by the EveAgents component, which
    // chains onto this one. The topology gate above saw them all.
    for (const agent of cfg.agents.filter((a) => a.runtime === "hermes")) {
      const overridesDoc = overridesDocument(agent);

      const environment: Record<string, pulumi.Input<string>> = {
        HERMES_GITOPS_REQUIRE_EMITTER: "1",
        // Declarative override lifecycle (issue #11 [E2]): when this
        // agent declares no overrides, the stack is stating
        // "no override layer" - the emitter deletes any previously
        // persisted <overrides_dir>/<name>.yaml instead of letting the
        // last-written copy silently keep applying.
        ...(overridesDoc === null ? { HERMES_GITOPS_OVERRIDES_CLEAR: "1" } : {}),
        // Names only, never values: tells the emitter which env vars the
        // stack's agentSecrets config carries per instance (issue #37
        // [K5]).
        HERMES_GITOPS_AVAILABLE_SECRETS_JSON: JSON.stringify(
          Object.fromEntries(
            Object.entries(cfg.agentSecrets).map(([n, vars]) => [n, Object.keys(vars)]),
          ),
        ),
        // The desired state itself (issue #32 [K1]) - each key is a
        // Command input, so preview shows a per-key before/after.
        ...agentDesiredStateEnv(agent, overridesDoc),
      };
      if (cfg.gitopsGitToken !== null) {
        // Defensive redundancy, not the primary path: stage 1 already
        // wrote GITOPS_GIT_TOKEN into the operating profile's .env;
        // passing it here keeps stage-2-only iteration working.
        environment["GITOPS_GIT_TOKEN"] = cfg.gitopsGitToken;
      }

      const cmd = new local.Command(
        `hermes-profile-install-${agentSlug(agent)}`,
        {
          create: AGENT_INSTALL_SCRIPT,
          update: AGENT_INSTALL_SCRIPT,
          delete: AGENT_DECOMMISSION_SCRIPT,
          environment,
        },
        { parent: this, dependsOn: previous },
      );
      resources.push(cmd);
      previous = [cmd];
    }

    this.resources = resources;
    this.registerOutputs({});
  }
}
