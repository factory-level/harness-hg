// Per-agent secret propagation (issue #38 [K6] — UX_TARGET point 4):
//
//   pulumi config set --secret --path 'agentSecrets.<name>.<VAR>' <value>
//     -> ciphertext in Pulumi.<stack>.yaml (the single source)
//     -> Pulumi decrypts at apply and writes k8s Secret
//        "hermes-<name>-env" in namespace "hermes-<name>"
//     -> the workload references it (the chart's envFrom secretRef —
//        templates/pod/statefulset.yaml — targets exactly that name)
//
// No external secret backend and no operator hand-seeding: this replaces
// the ExternalSecret hop that used to materialize spec.envRequires from
// operator-seeded Secrets in hermes-secrets.
//
// Namespace ordering: the per-agent namespace is normally created by the
// Argo CD ApplicationSet (CreateNamespace=true). This component creates
// it too — first-writer wins and the loser no-ops (server-side apply),
// which removes the race where the Secret would land before the
// namespace exists. The namespace is retainOnDelete: the workload's
// LIFECYCLE belongs to GitOps (agent decommission -> Argo prune, issue
// #24 [F6]); `pulumi destroy` must not rip a running agent's namespace
// out from under Argo just because its env Secret went away.
//
// Rotation: a changed value updates the Secret in place; env vars from a
// Secret do NOT propagate into running pods, so each agent's Secret pairs
// with a rollout-restart Command triggered by a digest of the secret
// VALUES (the digest lives only in the command's triggers as a dependency
// fingerprint — never in the Secret or any manifest).
//
// ROTATION IS COMPLETE ONLY WHEN THE WORKLOAD IS RUNNING THE NEW VALUE
// (#142, design 05). That is a stronger claim than "the Secret is
// updated", and it is the one an operator needs: a rotated credential
// that no pod has picked up has not been rotated, it has been staged.
//
// The restart used to be best-effort — every failure collapsed into one
// line claiming "first install". So an RBAC denial, an unreachable API
// server and a genuinely absent StatefulSet were indistinguishable, and
// all three reported success. Now the absent case is CHECKED for
// explicitly (and distinguished from an unreachable cluster by whether
// the namespace is visible), which is what frees every other failure to
// be fatal — and the command waits for `rollout status` rather than
// returning the moment the annotation is patched.
//
// The argocd component ships a cluster-wide ignoreDifferences for
// kubectl.kubernetes.io/restartedAt so selfHeal doesn't revert the
// restart annotation (which would roll the workload a second time).

import * as crypto from "node:crypto";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { local } from "@pulumi/command";
import { ConfigError, type BootstrapConfig, RUNTIME_PREFIX, runtimeOfInstance } from "../../control-flow/config.ts";

const NAME_MAX_LENGTH = 40;
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** How long to wait for the rolled workload to come back (#142).
 *
 * Long enough for an ordinary agent pod (image pull, init container,
 * readiness), short enough that a `pulumi up` against a broken workload
 * fails rather than hanging. A rollout still going after this is not
 * "slow" - it is a pod that cannot start on the new value, which is
 * exactly what rotation has to report. */
const ROLLOUT_TIMEOUT = "180s";


export function buildRestartScript(namespace: string): string {
  return `set -eu
if ! command -v kubectl >/dev/null 2>&1; then
  echo "agent-secrets: kubectl not found - cannot roll ${namespace} onto the new secret value." >&2
  echo "  The Secret IS updated; the running pod is still using the OLD one until something restarts it." >&2
  echo "  Install kubectl on the operator host, or restart the workload yourself:" >&2
  echo "    kubectl -n ${namespace} rollout restart statefulset ${namespace}" >&2
  exit 1
fi
if [ -n "\${HERMES_GITOPS_KUBECONFIG_CONTENT:-}" ]; then
  KCFG="$(mktemp)"
  trap 'rm -f "$KCFG"' EXIT
  printf '%s' "$HERMES_GITOPS_KUBECONFIG_CONTENT" > "$KCFG"
  KFLAGS="--kubeconfig $KCFG"
else
  KFLAGS=""
fi
if [ -n "\${HERMES_GITOPS_KUBECONFIG_CONTEXT:-}" ]; then
  KFLAGS="$KFLAGS --context $HERMES_GITOPS_KUBECONFIG_CONTEXT"
fi

# ABSENT is a real, expected state on a first install - Argo CD creates
# the StatefulSet later and the pod starts against the already-written
# Secret. So absence has to be recognised; but ONLY absence, and only
# from the server saying so.
#
# The test is the API server's own NotFound, read out of the error rather
# than inferred from a non-zero exit. Inferring is how #142 came back
# through a narrower door: a role that can read namespaces but NOT
# statefulsets fails this get, and a reachability proxy (can I see the
# namespace?) answers yes - reporting a first install, exiting 0, and
# leaving a running pod on the old credential. Forbidden, Unauthorized, a
# refused connection and a timeout are all fatal here, because none of
# them is evidence that the workload does not exist.
STS_ERR="$(kubectl $KFLAGS -n ${namespace} get statefulset ${namespace} 2>&1 >/dev/null)" && STS_FOUND=yes || STS_FOUND=no
if [ "$STS_FOUND" = "no" ]; then
  case "$STS_ERR" in
    *NotFound*|*"not found"*)
      echo "agent-secrets: no statefulset ${namespace} yet (first install) - the pod will start against the new Secret." >&2
      exit 0
      ;;
  esac
  echo "agent-secrets: cannot determine whether ${namespace} is running - refusing to report a rotation." >&2
  echo "  The server did not say the StatefulSet is absent, so this is a permissions or connectivity" >&2
  echo "  problem rather than a first install. The Secret IS updated; the running pod (if any) still" >&2
  echo "  has the OLD value." >&2
  echo "  kubectl said: $STS_ERR" >&2
  exit 1
fi

kubectl $KFLAGS -n ${namespace} rollout restart statefulset ${namespace}

# COMPLETION, not just a request. Without this the command returns the
# moment the annotation is patched, which is before a single pod has
# restarted - so "rotation succeeded" meant "we asked".
if ! kubectl $KFLAGS -n ${namespace} rollout status statefulset ${namespace} --timeout=${ROLLOUT_TIMEOUT}; then
  echo "agent-secrets: ${namespace} did not finish rolling within ${ROLLOUT_TIMEOUT}." >&2
  echo "  The Secret is updated and the restart was requested, but at least one pod is NOT yet running the new value." >&2
  echo "  Inspect it:  kubectl -n ${namespace} rollout status statefulset ${namespace}" >&2
  echo "               kubectl -n ${namespace} describe pod -l app.kubernetes.io/instance=${namespace}" >&2
  exit 1
fi
echo "agent-secrets: ${namespace} is running the rotated secret values." >&2
`;
}


/** Validate + normalize the `agentSecrets` stack config object
 * ({instanceName: {ENV_VAR: value}}). Pure — unit-tested in
 * tests/agent-secrets.test.ts. Keys must satisfy the same rules the rest
 * of the platform enforces: instance names are DNS-1123 labels <=40
 * chars (gitops_emitter/render.py's validate_name), env var names match
 * the profile schema's envRequires pattern. */
export function parseAgentSecrets(raw: unknown): Record<string, Record<string, string>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      "hermes-gitops-bootstrap:agentSecrets must be a mapping of " +
        "{instanceName: {ENV_VAR: value}}",
    );
  }
  const result: Record<string, Record<string, string>> = {};
  for (const [name, vars] of Object.entries(raw as Record<string, unknown>)) {
    if (name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agentSecrets key ${JSON.stringify(name)} is not a valid ` +
          `instance name (DNS-1123 label, max ${NAME_MAX_LENGTH} chars)`,
      );
    }
    if (typeof vars !== "object" || vars === null || Array.isArray(vars)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agentSecrets.${name} must be a mapping of {ENV_VAR: value}`,
      );
    }
    const entry: Record<string, string> = {};
    for (const [envVar, value] of Object.entries(vars as Record<string, unknown>)) {
      if (!ENV_VAR_PATTERN.test(envVar)) {
        throw new ConfigError(
          `hermes-gitops-bootstrap:agentSecrets.${name}.${envVar} is not a valid env var ` +
            "name (UPPER_SNAKE_CASE, matching the profile schema's envRequires pattern)",
        );
      }
      entry[envVar] = String(value);
    }
    result[name] = entry;
  }
  return result;
}

/** Validate + normalize the `agentGitAuth` stack config object (issue
 * #18 [G1]): {instanceName: {username, password} | {sshPrivateKey}} —
 * materialized as Secret "hermes-<name>-git-auth" in the instance
 * namespace, the credential the chart's gitAuthSecretRef mounts for a
 * private spec.source clone. Pure — unit-tested. */
export function parseAgentGitAuth(
  raw: unknown,
): Record<string, Record<string, string>> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(
      "hermes-gitops-bootstrap:agentGitAuth must be a mapping of " +
        "{instanceName: {username, password} | {sshPrivateKey}}",
    );
  }
  const result: Record<string, Record<string, string>> = {};
  for (const [name, cred] of Object.entries(raw as Record<string, unknown>)) {
    if (name.length > NAME_MAX_LENGTH || !NAME_PATTERN.test(name)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agentGitAuth key ${JSON.stringify(name)} is not a valid ` +
          `instance name (DNS-1123 label, max ${NAME_MAX_LENGTH} chars)`,
      );
    }
    if (typeof cred !== "object" || cred === null || Array.isArray(cred)) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agentGitAuth.${name} must be a mapping`,
      );
    }
    const c = cred as Record<string, unknown>;
    const hasHttps = Boolean(c["username"]) && Boolean(c["password"]);
    const hasSsh = Boolean(c["sshPrivateKey"]);
    if (!hasHttps && !hasSsh) {
      throw new ConfigError(
        `hermes-gitops-bootstrap:agentGitAuth.${name} needs either username+password ` +
          "(HTTPS PAT) or sshPrivateKey (SSH deploy key)",
      );
    }
    const entry: Record<string, string> = {};
    if (hasHttps) {
      entry["username"] = String(c["username"]);
      entry["password"] = String(c["password"]);
    }
    if (hasSsh) {
      // The chart mounts this data key as /git-auth/ssh-privatekey.
      entry["ssh-privatekey"] = String(c["sshPrivateKey"]);
    }
    result[name] = entry;
  }
  return result;
}

/** Digest of one agent's secret values — the rollout-restart Command's
 * change trigger. Not a security boundary (it never leaves the Pulumi
 * state's trigger list, which is encrypted like any other input). */
export function secretsDigest(vars: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(vars).sort(([a], [b]) => a.localeCompare(b))),
  );
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

export interface AgentSecretsArgs {
  provider: k8s.Provider;
  config: BootstrapConfig;
  // The provisioned/referenced cluster's kubeconfig text, when known —
  // handed to the best-effort rollout-restart kubectl. undefined means
  // "ambient kubeconfig".
  kubeconfig: pulumi.Input<string> | undefined;
  kubeconfigContext: string | undefined;
  /** Per-instance secrets sourced from RESOURCE OUTPUTS rather than stack
   * config — today the SlackWorkspace provision credentials (ADR 0175).
   * Merged over the config-sourced vars; on a key collision the resource
   * output wins (state is authoritative for what it provisioned). */
  extraSecrets?: Record<string, Record<string, pulumi.Input<string>>>;
}

export class AgentSecrets extends pulumi.ComponentResource {
  readonly resources: pulumi.Resource[];
  /** instance name -> its `agent-secrets-roll` Command, for callers that
   * must order work after the pod is RUNNING the new values (the Slack
   * events attach, ADR 0175). */
  readonly rolls: Record<string, pulumi.Resource> = {};

  constructor(name: string, args: AgentSecretsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:AgentSecrets", name, {}, opts);
    const resources: pulumi.Resource[] = [];

    const agentSecrets = args.config.agentSecrets;
    const extraSecrets = args.extraSecrets ?? {};
    const agentGitAuth = args.config.agentGitAuth;
    const namespaces = new Map<string, k8s.core.v1.Namespace>();
    // ADR-151: an Eve instance lives in ag-eve-<name>; the runtime comes
    // off the agents[] entry that names the instance.
    const nsNameOf = (instanceName: string): string =>
      `${RUNTIME_PREFIX[runtimeOfInstance(args.config.agents, instanceName)]}${instanceName}`;
    const ensureNamespace = (instanceName: string): k8s.core.v1.Namespace => {
      const namespaceName = nsNameOf(instanceName);
      let ns = namespaces.get(namespaceName);
      if (ns === undefined) {
        ns = new k8s.core.v1.Namespace(
          `ns-${namespaceName}`,
          { metadata: { name: namespaceName } },
          { parent: this, provider: args.provider, retainOnDelete: true },
        );
        namespaces.set(namespaceName, ns);
      }
      return ns;
    };

    // Private-source credentials (issue #18 [G1]): Secret
    // hermes-<name>-git-auth, the target of the record's
    // gitAuthSecretRef. Same secret-tracking posture as agentSecrets.
    for (const [instanceName, cred] of Object.entries(agentGitAuth)) {
      const namespaceName = nsNameOf(instanceName);
      const secretName = `${namespaceName}-git-auth`;
      const namespace = ensureNamespace(instanceName);
      const stringData: Record<string, pulumi.Output<string>> = {};
      for (const [key, value] of Object.entries(cred)) {
        stringData[key] = pulumi.secret(value);
      }
      const secret = new k8s.core.v1.Secret(
        secretName,
        {
          metadata: {
            name: secretName,
            namespace: namespaceName,
            labels: { "hermes-gitops.factorylevel.dev/managed": "true" },
          },
          stringData,
        },
        {
          parent: this,
          provider: args.provider,
          dependsOn: [namespace],
          additionalSecretOutputs: ["stringData", "data"],
        },
      );
      resources.push(namespace, secret);
    }

    // The instance set is the UNION of the two sources: an instance whose
    // only secrets are resource-provisioned (post-migration Slack twins)
    // still gets its env Secret + roll.
    const instanceNames = [
      ...new Set([...Object.keys(agentSecrets), ...Object.keys(extraSecrets)]),
    ].sort();
    for (const instanceName of instanceNames) {
      const vars = agentSecrets[instanceName] ?? {};
      const extra = extraSecrets[instanceName] ?? {};
      const namespaceName = nsNameOf(instanceName);
      const secretName = `${namespaceName}-env`;

      const namespace = ensureNamespace(instanceName);

      // Values re-enter Pulumi's secret tracking here: agentSecrets is
      // read as a plain object (resource construction needs its KEYS),
      // so each VALUE is individually wrapped with pulumi.secret() and
      // the Secret's stringData is additionally marked secret — state
      // and preview diffs stay ciphertext. extraSecrets values are
      // already-tainted Outputs and win any key collision.
      const stringData: Record<string, pulumi.Output<string>> = {};
      for (const [envVar, value] of Object.entries(vars)) {
        stringData[envVar] = pulumi.secret(value);
      }
      for (const [envVar, value] of Object.entries(extra)) {
        stringData[envVar] = pulumi.secret(value);
      }

      const secret = new k8s.core.v1.Secret(
        secretName,
        {
          metadata: {
            name: secretName,
            namespace: namespaceName,
            labels: { "hermes-gitops.factorylevel.dev/managed": "true" },
          },
          stringData,
        },
        {
          parent: this,
          provider: args.provider,
          dependsOn: [namespace],
          additionalSecretOutputs: ["stringData", "data"],
        },
      );

      // Rotation is complete only when the workload is RUNNING the new
      // value (#142, design 05). The previous script wrote the Secret,
      // asked for a restart, and swallowed every failure into one line
      // claiming "first install":
      //
      //   kubectl ... rollout restart ... 2>/dev/null || echo "no
      //   statefulset ... (first install) - skipping"
      //
      // So an RBAC denial, an unreachable API server and a genuinely
      // absent StatefulSet were indistinguishable, and all three reported
      // success. "The value is stored" does not imply "every workload
      // consuming it has picked it up", and nothing detected or reported
      // the difference - a rotation could appear to succeed while the old
      // credential kept running.
      //
      // Now: absent is a distinct, checked state; everything else fails.
      // The kubeconfig text (possibly a secret Output) rides in as an env
      // var, never on the command line.
      const restartScript = buildRestartScript(namespaceName);

      const environment: Record<string, pulumi.Input<string>> = {};
      if (args.kubeconfig !== undefined) {
        environment["HERMES_GITOPS_KUBECONFIG_CONTENT"] = args.kubeconfig;
      }
      if (args.kubeconfigContext) {
        environment["HERMES_GITOPS_KUBECONFIG_CONTEXT"] = args.kubeconfigContext;
      }

      // The digest trigger must see the RESOLVED merged values: extra
      // vars are Outputs, so the digest itself becomes an Output. It
      // lives only in the trigger list (encrypted state), same as before.
      const mergedForDigest = pulumi
        .all(stringData)
        .apply((resolved) => secretsDigest(resolved));
      const restart = new local.Command(
        `agent-secrets-roll-${instanceName}`,
        {
          create: restartScript,
          update: restartScript,
          environment,
          triggers: [mergedForDigest],
        },
        { parent: this, dependsOn: [secret] },
      );
      this.rolls[instanceName] = restart;

      resources.push(namespace, secret, restart);
    }

    this.resources = resources;
    this.registerOutputs({});
  }
}
