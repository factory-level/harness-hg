// GENERATED FILE — DO NOT EDIT.
//
// Source:   agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json
// Producer: infra/scripts/generate-contract-types.mjs
// Contract: ADR-7 — JSON Schema is canonical; every other machine-readable
//           description is generated from it (#139).
//
// Regenerate:  make contract-types
// Drift-check: make contract-types-drift  (runs in `make test`)
//
// Only the closed provider vocabularies are generated. The interfaces in
// config.ts are NOT projections of any schema — BootstrapConfig carries
// bootstrap-only concepts no record schema describes — and generating half
// of a file leaves you unable to tell which half is which.

/**
 * pod is the ONLY compute provider: the per-agent VM compute path
 * (gce/libvirt) was removed outright (issue #27 [G8]).
 */
export const COMPUTE_PROVIDERS = ["pod"] as const;
export type ComputeProvider = (typeof COMPUTE_PROVIDERS)[number];

/**
 * k8s is the ONLY secret provider: values are encrypted in the Pulumi
 * stack (`pulumi config set --secret`) and materialized as k8s Secrets —
 * no external secret backend (vault/gsm/sops removed, issue #30 [H1]).
 */
export const SECRET_PROVIDERS = ["k8s"] as const;
export type SecretProvider = (typeof SECRET_PROVIDERS)[number];

/**
 * `tailscale` is in the frozen schema and NOT here: ADR-9 retired it
 * (#131). A frozen schema keeps the value; the platform stops accepting
 * it.
 *
 * Retired and therefore not accepted: `tailscale`.
 */
export const INGRESS_PROVIDERS = ["ingress", "cloudflare", "none"] as const;
export type IngressProvider = (typeof INGRESS_PROVIDERS)[number];

/**
 * Where an agent's backup artifacts land.
 */
export const BACKUP_PROVIDERS = ["pvc", "none"] as const;
export type BackupProvider = (typeof BACKUP_PROVIDERS)[number];
