// Event-router signing secrets, provisioned by the bootstrap (ADR-53).
//
// The router signs every agent-edge delivery with a per-target secret and
// REFUSES to deliver without one - router.ts classifies the attempt
// `no-secret` and drops it. control-plane/event-router/chart/values.yaml
// states the ownership plainly: "Values are provisioned by the platform
// (locally: hg up), NEVER by this chart."
//
// Until now "the platform" meant only `hg up` (cli/src/platform.ts:1629).
// Argo CD delivers the router in a real environment
// (gitops-template/bootstrap/applicationsets/communication.yaml), where
// nothing created the Secret - so every agent edge failed silently while
// the workload itself looked healthy. This closes that.
//
// Two conventions are borrowed from the communication compiler rather
// than re-declared, and a change to either breaks this component:
//   - the Secret KEY is `<profile-namespace>-env` (communication.ts:448)
//   - the profile namespace is `hermes-<profile>` under the single
//     layout (compile.ts:219)
// The value is the target profile's WEBHOOK_SECRET, which the operator
// already supplies through agentSecrets - so this derives the whole
// Secret from existing config rather than asking for it twice.
//
// Namespace: the single-layout router lives in `hermes-system`
// (communication.ts:224). Multi-region routers are `hermes-system-<region>`
// and are NOT covered here - a multi-region fleet still needs `hg up` or a
// follow-up. Argo creates the namespace with CreateNamespace=true, which
// does not take ownership, so owning it here is safe and gives the Secret
// a guaranteed-present parent before the router syncs.

import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import type { BootstrapConfig } from "../../control-flow/config.ts";

export const ROUTER_NS = "hermes-system";
export const ROUTER_SECRET = "hermes-event-router-secrets";
/** The env var a profile publishes its webhook signing secret under. */
export const WEBHOOK_SECRET_VAR = "WEBHOOK_SECRET";

/** Secret KEY for a profile's signing secret. Mirrors
 * `${inst.namespace}-env` in cli/src/topology/communication.ts:448, with
 * the single-layout namespace from cli/src/topology/compile.ts:219. */
export function routerSecretKey(profile: string): string {
  return `hermes-${profile}-env`;
}

/** {key: WEBHOOK_SECRET} for every agent that declares one, plus any
 * operator-declared extra keys (`routerSecrets` stack config, #357):
 * external-input signing secrets and chatops webhook-URL credentials.
 * Extra keys must not shadow a derived agent key - a typo that silently
 * replaced a signing secret would break deliveries three hops away.
 * Pure, so the key convention is testable without a cluster. */
export function routerSecretEntries(
  agentSecrets: Record<string, Record<string, string>>,
  extraSecrets: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [instance, vars] of Object.entries(agentSecrets)) {
    const secret = vars[WEBHOOK_SECRET_VAR];
    if (secret !== undefined) out[routerSecretKey(instance)] = secret;
  }
  for (const [key, value] of Object.entries(extraSecrets)) {
    if (out[key] !== undefined) {
      throw new Error(
        `routerSecrets.${key} collides with the derived signing-secret key for an agent - ` +
          "rename the extra key; per-agent WEBHOOK_SECRETs are owned by agentSecrets",
      );
    }
    out[key] = value;
  }
  return out;
}

/** `routerSecrets` stack config: {secretKey: value}. Keys become file
 * names under the router's /secrets mount, so they must be valid Secret
 * data keys. Values are never logged. */
export function parseRouterSecrets(raw: unknown): Record<string, string> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "hermes-gitops-bootstrap:routerSecrets must be a mapping of {secretKey: value}",
    );
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[-._a-zA-Z0-9]+$/.test(key) || key.length > 253) {
      throw new Error(
        `hermes-gitops-bootstrap:routerSecrets key ${JSON.stringify(key)} is not a valid ` +
          "Kubernetes Secret data key",
      );
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`hermes-gitops-bootstrap:routerSecrets.${key} must be a non-empty string`);
    }
    result[key] = value;
  }
  return result;
}

export interface RouterSecretsArgs {
  provider: k8s.Provider;
  config: BootstrapConfig;
}

export class RouterSecrets extends pulumi.ComponentResource {
  /** null when no agent declares a WEBHOOK_SECRET - a fleet with no
   * agent-edge routes needs no Secret, exactly as `hg up` skips it. */
  readonly secret: k8s.core.v1.Secret | null;

  constructor(name: string, args: RouterSecretsArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:RouterSecrets", name, {}, opts);

    const stringData = routerSecretEntries(args.config.agentSecrets, args.config.routerSecrets);
    if (Object.keys(stringData).length === 0) {
      this.secret = null;
      this.registerOutputs({});
      return;
    }

    const namespace = new k8s.core.v1.Namespace(
      "ns-hermes-system",
      { metadata: { name: ROUTER_NS } },
      { parent: this, provider: args.provider },
    );

    this.secret = new k8s.core.v1.Secret(
      ROUTER_SECRET,
      {
        metadata: {
          name: ROUTER_SECRET,
          namespace: ROUTER_NS,
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

    this.registerOutputs({});
  }
}
