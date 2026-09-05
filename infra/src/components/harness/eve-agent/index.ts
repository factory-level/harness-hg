// Bootstrap for agents on the Eve runtime (ADR-149): one serialized
// local.Command per `agents[]` entry with `runtime: eve`, running the
// push-driven emit (`python -m gitops_emitter.emit_cli --runtime eve`).
//
// Why a separate component and not a branch in HermesAgents: the Hermes
// path emits a record as a SIDE EFFECT of `hermes profile install` (the
// fork's lifecycle hook fires this package's emitter). Eve has no install
// hook - its hooks observe runtime stream events - so the bootstrap itself
// is the emitter's caller. Nothing from stage 1 is needed: no fork, no
// `hermes` on PATH, no $HERMES_HOME/config.yaml. The emit runs the plugin
// straight from its uv project (`uv run --directory <plugin repo>`) with
// HERMES_GITOPS_CONFIG_SOURCE=env and the same HERMES_GITOPS_* contract
// stage 1 writes into config.yaml (pluginConfigEnvironment), so the GitOps
// repository sees the same publisher, mode and idempotency either way.
//
// The serial chain (each Command dependsOn the previous, the first on
// HermesAgents' resources) is the same reasoning as HermesAgents': every
// emit may be the one that scaffolds the repo, and two concurrent pushes
// to one branch would race. Failure semantics: a non-zero exit from the
// emit CLI fails the Command and therefore `pulumi up`, the same
// fail-loud chain HERMES_GITOPS_REQUIRE_EMITTER gives the Hermes path.

import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";
import { resolvePluginPath } from "../hermes-install/index.ts";
import { pluginConfigEnvironment } from "../hermes-install/index.ts";
import { agentDesiredStateEnv, agentSlug, resolveSourceRevision } from "../hermes-agent/index.ts";
import { EVE_RUNTIME_VERSION, type AgentSpec, type BootstrapConfig } from "../../../control-flow/config.ts";

/** Clone the source at the resolved sha into a scratch checkout and emit
 * from agents[].subdir inside it. The sha is re-resolved here (not only at
 * plan time) so the record names the commit the pod will build; a mutable
 * ref that moved between preview and apply still converges on the next
 * tick because HERMES_GITOPS_DESIRED_SOURCE_SHA is a Command input. */
export const EVE_EMIT_SCRIPT = `set -eu
SRC="$HERMES_GITOPS_DESIRED_SOURCE"
case "$SRC" in
  http://*|https://*|git@*|ssh://*|/*|.*|~*) ;;
  *) SRC="https://$SRC" ;;
esac
REF="\${HERMES_GITOPS_DESIRED_REF:-HEAD}"
WORK="$(mktemp -d "\${TMPDIR:-/tmp}/hermes-gitops-eve.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
GIT_TERMINAL_PROMPT=0 git clone --quiet "$SRC" "$WORK/src"
if [ -n "\${HERMES_GITOPS_DESIRED_SOURCE_SHA:-}" ]; then
  SHA="$HERMES_GITOPS_DESIRED_SOURCE_SHA"
else
  SHA="$(git -C "$WORK/src" rev-parse "\${REF}^{commit}")"
fi
git -C "$WORK/src" checkout --quiet --detach "$SHA"
AGENT_DIR="$WORK/src\${HERMES_GITOPS_DESIRED_SUBDIR:+/$HERMES_GITOPS_DESIRED_SUBDIR}"
set -- python -m gitops_emitter.emit_cli --runtime eve \\
  --agent-dir "$AGENT_DIR" --source "$HERMES_GITOPS_DESIRED_SOURCE" --sha "$SHA" \\
  --event "$HERMES_GITOPS_EVE_EVENT" --expect-eve-version "$HERMES_GITOPS_EVE_VERSION"
if [ -n "\${HERMES_GITOPS_DESIRED_REF:-}" ]; then set -- "$@" --ref "$HERMES_GITOPS_DESIRED_REF"; fi
if [ -n "\${HERMES_GITOPS_DESIRED_SUBDIR:-}" ]; then set -- "$@" --subdir "$HERMES_GITOPS_DESIRED_SUBDIR"; fi
if [ -n "\${HERMES_GITOPS_DESIRED_NAME:-}" ]; then set -- "$@" --name "$HERMES_GITOPS_DESIRED_NAME"; fi
if [ -n "\${HERMES_GITOPS_EVE_APP_VALUES_JSON:-}" ]; then set -- "$@" --app-values "$HERMES_GITOPS_EVE_APP_VALUES_JSON"; fi
uv run --directory "$HERMES_GITOPS_PLUGIN_PATH" "$@"
`;

/** The delete action: remove the record through the decommission CLI
 * (records live under profiles/<name>/ whichever runtime wrote them). By
 * name when the stack declared one, else by source - narrowed by subdir,
 * because a monorepo ships several agents under one source and the
 * subdir is what tells them apart. The plugin checkout may already be
 * gone on a full destroy; that is reported, not fatal, the same as the
 * Hermes path. */
export const EVE_DECOMMISSION_SCRIPT = `set -eu
if [ ! -d "$HERMES_GITOPS_PLUGIN_PATH/plugin/gitops_emitter" ]; then
  echo "eve-agent decommission: plugin checkout $HERMES_GITOPS_PLUGIN_PATH not found - skipping GitOps prune for \${HERMES_GITOPS_DESIRED_NAME:-\$HERMES_GITOPS_DESIRED_SOURCE} (remove profiles/<name>/ from the GitOps repo manually if it still exists)" >&2
  exit 0
fi
if [ -n "\${HERMES_GITOPS_DESIRED_NAME:-}" ]; then
  uv run --directory "$HERMES_GITOPS_PLUGIN_PATH" python -m gitops_emitter.decommission_cli "$HERMES_GITOPS_DESIRED_NAME"
elif [ -n "\${HERMES_GITOPS_DESIRED_SUBDIR:-}" ]; then
  uv run --directory "$HERMES_GITOPS_PLUGIN_PATH" python -m gitops_emitter.decommission_cli --source "$HERMES_GITOPS_DESIRED_SOURCE" --subdir "$HERMES_GITOPS_DESIRED_SUBDIR"
else
  uv run --directory "$HERMES_GITOPS_PLUGIN_PATH" python -m gitops_emitter.decommission_cli --source "$HERMES_GITOPS_DESIRED_SOURCE"
fi
`;

/** The per-agent Command environment. Pure; unit-tested. Every key is a
 * Command input `pulumi preview` diffs - the desired state (source, ref,
 * subdir, resolved sha), the plugin configuration (the same contract stage
 * 1 writes to config.yaml), and the Eve runtime pin. */
/** Per-instance secret NAMES the platform will deliver — config-sourced
 * `agentSecrets` plus the names ADR 0175's provision path materializes
 * from Pulumi state (a provisioned Slack app always yields exactly these
 * two). Names are pure config knowledge, so the stage-2 emit's fail-loud
 * required-secret check can trust them without any stage-3 dependency. */
export function availableSecretNames(cfg: BootstrapConfig): Record<string, string[]> {
  const names = Object.fromEntries(
    Object.entries(cfg.agentSecrets).map(([n, vars]) => [n, Object.keys(vars)]),
  );
  if (cfg.slack.enabled) {
    for (const [agent, app] of Object.entries(cfg.slack.apps)) {
      if (app.appId !== "") continue; // adopted apps ride config alone
      names[agent] = [
        ...new Set([...(names[agent] ?? []), "SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"]),
      ].sort();
    }
  }
  return names;
}

export function eveAgentEnv(
  cfg: BootstrapConfig,
  agent: AgentSpec,
  pluginPath: string,
  event: "install" | "update",
  resolver: (source: string, ref: string) => string | null = resolveSourceRevision,
): Record<string, pulumi.Input<string>> {
  const env: Record<string, pulumi.Input<string>> = {
    ...pluginConfigEnvironment(cfg),
    HERMES_GITOPS_CONFIG_SOURCE: "env",
    HERMES_GITOPS_PLUGIN_PATH: pluginPath,
    HERMES_GITOPS_EVE_VERSION: EVE_RUNTIME_VERSION,
    HERMES_GITOPS_EVE_EVENT: event,
    HERMES_GITOPS_REQUIRE_EMITTER: "1",
    // Names only, never values (the fail-loud secret check).
    HERMES_GITOPS_AVAILABLE_SECRETS_JSON: JSON.stringify(availableSecretNames(cfg)),
    ...agentDesiredStateEnv(agent, null, resolver),
  };
  // overrides.appValues (the only override an Eve instance carries) ->
  // emit_cli --app-values; JSON so a nested fragment survives the shell.
  const appValues = (agent.overrides as Record<string, unknown> | null)?.["appValues"];
  if (appValues !== undefined && appValues !== null) {
    env["HERMES_GITOPS_EVE_APP_VALUES_JSON"] = JSON.stringify(appValues);
  }
  if (cfg.gitopsGitToken !== null) env["GITOPS_GIT_TOKEN"] = cfg.gitopsGitToken;
  return env;
}

export interface EveAgentsArgs {
  config: BootstrapConfig;
  dependsOn: pulumi.Resource[];
}

export class EveAgents extends pulumi.ComponentResource {
  readonly resources: pulumi.Resource[];

  constructor(name: string, args: EveAgentsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:EveAgents", name, {}, opts);
    const cfg = args.config;
    const eveAgents = cfg.agents.filter((a) => a.runtime === "eve");
    const resources: pulumi.Resource[] = [];
    if (eveAgents.length === 0) {
      this.resources = resources;
      this.registerOutputs({});
      return;
    }
    // The topology gate already ran in HermesAgents over ALL agents.
    const pluginPath = resolvePluginPath(cfg);
    let previous: pulumi.Resource[] = [...args.dependsOn];
    for (const agent of eveAgents) {
      const cmd = new local.Command(
        `eve-agent-emit-${agentSlug(agent)}`,
        {
          create: EVE_EMIT_SCRIPT,
          update: EVE_EMIT_SCRIPT,
          delete: EVE_DECOMMISSION_SCRIPT,
          // A local.Command runs one script for create and update and
          // cannot tell them apart, so the event word in the commit
          // message is always "install"; the GitOps history is the record
          // of updates, not that word.
          environment: eveAgentEnv(cfg, agent, pluginPath, "install"),
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
