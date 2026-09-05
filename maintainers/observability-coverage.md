# Control-plane observability coverage (#662)

The honesty ledger for every `control-plane/` component, per the six coverage dimensions.
Maintained, not a one-off: a row changes when the component's coverage changes, and
`hg observability prove` OBS011/OBS012 gate the two router components' overlay presence.
"none — <reason>" is a filled entry; a blank is a bug in this document.

Legend: ✓ exists · ✗ gap (issue linked) · `none` deliberate absence with the reason.

| Component | Metrics | Alerts | Dashboards | Logs | Health | Drill-down |
|---|---|---|---|---|---|---|
| grafana | ✓ kube-prometheus-stack self-metrics | ✗ none fire on Grafana itself (#699) | ✓ its own UI; `hg grafana prove` asserts promised panels | ✗ kubectl only until Loki (#661) | ✓ `hg dash errors` + sidecar import status | ✓ `hg dash list\|errors` |
| prometheus | ✓ self-scrape | ✓ `defaultRules` cluster alerts | ✓ stack defaults | ✗ #661 | ✓ stack probes | ✓ PromQL |
| alertmanager | ✓ stack | ✓ `defaultRules` | ✓ stack defaults | ✗ #661 | ✓ stack probes | ✓ its UI |
| loki | ✓ /metrics scraped by the stack | ✗ none on Loki itself (fold into #700's scope) | ✓ `hg-control-plane-logs` | ✓ it IS the logs backend | ✓ /ready probe | ✓ Grafana Explore |
| event-router | ✓ `hermes_router_*`/`hermes_event_*` series | ✗ no alert fires on DLQ depth or delivery failure (#700) | ✓ via monitoring/observability panels | ✗ #661 | ✓ overlay `communication` source — **gated by OBS011** | ✓ `hg event status\|trace\|dlq` |
| alert-router | ✓ delivery observable via Grafana contact-point state | ✗ no alert on a dead alert path — the watcher is unwatched (#700) | ✗ no dedicated panel (#700) | ✗ #661 | ✓ overlay `grafana` source — **gated by OBS012** | ✓ `hg dash errors` |
| nexus | ✓ served-plan/feature metrics via plugin API | none — read-only surface; an outage is visible as the canvas itself | ✓ it *is* a dashboard surface | ✗ #661 | ✓ overlay is served BY it; `hg nexus prove` | ✓ `hg nexus inspect` |
| wiki | none — static site, nginx stub metrics not scraped (fine) | none — an outage is a broken link, not a page | none | ✗ #661 rollout | ✓ /version probe (readiness) | ✓ the site itself |
| argocd | ✓ `argocd_*` series | ✓ `defaultRules` app-health routes | ✓ observability overview panels | ✗ #661 | ✓ overlay `argocd` source | ✓ Argo UI + `hg logs` conditions |
| external-secrets | ✓ ESO controller metrics | ✗ no alert on sync failure — a dead secret store is silent until a pod restarts (#701) | ✗ none (#701) | ✗ #661 | ✓ ClusterSecretStore status conditions | ✓ `kubectl get externalsecret` |
| dex-sso | ✗ nothing scraped (#701) | ✗ none (#701) | ✗ none (#701) | ✗ #661 | ✓ `hg auth prove` (on demand, not continuous) | ✓ `hg identity` |
| tunnel | ✓ Cloudflare-side analytics (external) | none — the external-uptime watcher was killed (#647); an in-cluster replacement is a #662 follow-up folded into #700's scope decision | ✗ none in-cluster | ✗ #661 | ✓ `hg edge prove` (on demand) | ✓ `hg edge list` |
| monitoring (workload plane) | ✓ it produces them | ✓ per-profile rules + AlertmanagerConfig | ✓ per-profile dashboard | ✗ #661 | ✓ render-time receivers guard | ✓ `hg dash list --profile` |
| observability | ✓ consumes stack series | none — dashboards don't alert; rules live in monitoring/defaultRules by design | ✓ the three promised-uid singletons | ✗ #661 | ✓ `fleetRegister` asserts the uids | ✓ Grafana folder |
| fleet-dashboard | ✓ budget series | ✓ fleet budget alerts | ✓ the fleet singleton | ✗ #661 | ✓ render-time guard | ✓ budget `valuesObject` |

## The systemic gaps, as filed issues

- **[#661](https://github.com/factory-level/harness-hg/issues/661)** — **built (ADR 0165)**:
  the Logs column's ✗ entries close as environments converge on the seed (local `hg up`
  now; factory via the deploy follow-up issue).
- **#699** — Grafana's own failure is unalerted (the watcher's watcher).
- **#700** — the routing components' alerting: DLQ depth, delivery failure, and a dead
  alert path all fire nothing today; called out by the braindump as the first gap
  candidates, now gated for presence by OBS011/OBS012.
- **#701** — the quiet third: external-secrets sync failures, dex-sso (nothing scraped at
  all), and their missing panels.

On-demand vs continuous: several Health entries are `hg … prove` commands — real coverage,
but only when a human runs them. Turning the prove matrices into scheduled checks is
phase-4/5 territory (#670's walkthroughs become acceptance runs), not re-filed here.
