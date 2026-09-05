{{- /*
Helpers for the fleet budget/TCO chart. Unlike charts/monitoring this is
a fleet SINGLETON (one release per cluster, in hermes-monitoring), so
uids and names are constants, not namespace-derived.
*/ -}}

{{/* fleet.contactPoint - the one fleet-level Grafana contact point. */}}
{{- define "fleet.contactPoint" -}}
hermes-fleet-alerts
{{- end -}}

{{/*
fleet.budgetRuleUid - stable per-persona alert rule uid. MUST depend on
the persona ONLY (never the budget amount): Grafana treats a changed uid
as delete+create, which resets alert state and silences on every budget
edit. Grafana caps uids at 40 chars: "flt-bgt-" (8) + persona (<= 54 by
schema, in practice a short DNS label) truncated to fit.
*/}}
{{- define "fleet.budgetRuleUid" -}}
{{- printf "flt-bgt-%s" . | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{/*
fleet.rulesWouldRender - "1" when at least one alert rule would render:
alerts enabled AND (a budget exists OR the fleet-total rule is on).
Shared by the alerts gate and the receivers guard so they can never
disagree.
*/}}
{{- define "fleet.rulesWouldRender" -}}
{{- if and .Values.alert.enabled (or (gt (len (default dict .Values.budgets)) 0) (gt (.Values.alert.fleetBudgetUsd | float64) 0.0)) -}}
1
{{- end -}}
{{- end -}}

{{/*
fleet.receiversGuard - fail the render loudly if a rule WOULD render
with no receiver (an alert with no receiver is a silent no-op, and
silent is worse than loud). A budget-less or alert-disabled install
renders the dashboard alone, silently and legitimately.
*/}}
{{- define "fleet.receiversGuard" -}}
{{- include "hermes-alerting.receiversGuard" (dict
      "chart" "charts/fleet-dashboard"
      "render" (include "fleet.rulesWouldRender" .)
      "webhookUrl" .Values.alert.webhookUrl
      "discordUrl" .Values.alert.discordUrl
      "remedy" "set one in bootstrap/fleet-dashboard.yaml's valuesObject, or set alert.enabled: false") -}}
{{- end -}}
