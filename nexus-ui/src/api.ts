// The ONE plugin API base. The id `hermes-gitops` is the frozen wire
// prefix during the transition; its rename is dispositioned to #672 in
// the naming ledger (kept stable through the flip so `hg nexus prove`
// stayed green against the live factory).
// The demo shell (src/demo.tsx) overrides the base so a static host can
// serve the avatar library from files; the plugin build leaves it unset.
export const API = ((globalThis as { __HG_API_BASE__?: string }).__HG_API_BASE__) ?? "/api/plugins/hermes-gitops";
