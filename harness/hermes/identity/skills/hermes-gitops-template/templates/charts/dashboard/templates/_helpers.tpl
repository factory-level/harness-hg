{{/*
dashboard.persona - the profile this dashboard belongs to. The ApplicationSet
installs every child app into namespace "hermes-<persona>", so the persona is
the namespace minus that prefix. (Same rule as charts/monitoring.)
*/}}
{{- define "dashboard.persona" -}}
{{- trimPrefix "hermes-" .Release.Namespace -}}
{{- end -}}

{{/*
dashboard.uid - a STABLE Grafana uid for this dashboard. Stable matters:
Grafana keys a dashboard by uid, so a changing uid orphans the old copy and
creates a duplicate. Derived from the namespace (a DNS label, already unique
per profile), truncated to leave room for the "-starter" suffix under
Grafana's 40-char cap.
*/}}
{{- define "dashboard.uid" -}}
{{- printf "%s-starter" (trunc 32 .Release.Namespace | trimSuffix "-") -}}
{{- end -}}

{{/*
dashboard.serviceRegex - the Traefik service-label regex the traffic panel
filters on. Traefik names Kubernetes-Ingress-backed services
"<namespace>-<service>-<port>@kubernetes", so this matches every service of
THIS profile's namespace and nothing from any other profile.
*/}}
{{- define "dashboard.serviceRegex" -}}
{{- printf "%s-.*@kubernetes" .Release.Namespace -}}
{{- end -}}

{{/*
dashboard.introMarkdown - the teaching panel shown at the top of the
dashboard. It explains, live and in place, how dashboards work on this
platform, so an author learns the conventions by opening the thing itself.
Rendered into the dashboard JSON via toJson (which escapes it correctly).
*/}}
{{- define "dashboard.introMarkdown" -}}
## Hermes — {{ include "dashboard.persona" . }} · starter dashboard

**How this reaches Grafana.** You are looking at a Kubernetes ConfigMap, not
a hand-imported dashboard. This chart labels it `grafana_dashboard: "1"`, and
the platform Grafana's sidecar watches every namespace for that label and
loads whatever it finds. To ship a new dashboard, you ship a ConfigMap — no
clicking, no API calls. Deleting the ConfigMap removes the dashboard.

**The rules this ecosystem follows:**

- **One shared datasource.** Every panel queries the Prometheus datasource
  uid `{{ .Values.datasourceUid }}` — the single Prometheus every profile
  reports into. Never hard-code a different uid; you will just get empty
  panels.
- **Stable uids.** This dashboard's uid is derived from the profile
  namespace and never changes. Grafana keys dashboards by uid: a uid that
  changes on every render orphans the old copy and spawns a duplicate.
- **Namespace-scoped queries.** Filter every query to THIS profile — by
  namespace label, or (for Traefik traffic) the service regex
  `{{ include "dashboard.serviceRegex" . }}`. A dashboard that accidentally
  sums all profiles is worse than no dashboard.
- **What fires is what you see.** Panels use the SAME queries as the alert
  rules in charts/monitoring, and draw the alert threshold as a line. When an
  operator asks "why did it page?", the dashboard already shows the answer.

See `CONVENTIONS.md` in this chart for the full guide and a copy-paste panel
recipe.
{{- end -}}

{{/*
dashboard.nextStepsMarkdown - a short "now make it yours" panel.
*/}}
{{- define "dashboard.nextStepsMarkdown" -}}
### Make it yours

1. Add a panel: append an object to `panels[]` in
   `templates/configmap-dashboard.yaml`, give it a unique `id` and a
   `gridPos` (x/y/w/h on a 24-column grid), and reuse `datasource` uid
   `{{ .Values.datasourceUid }}`.
2. Bump this chart's `version` (Chart.yaml + hermes-gitops.yaml), then
   `helm package` + `helm push` it.
3. Argo CD syncs the new ConfigMap; the sidecar reloads the dashboard in
   seconds. No Grafana restart.
{{- end -}}
