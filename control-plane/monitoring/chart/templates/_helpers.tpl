{{/*
monitoring.persona - the profile name this chart observes. The
ApplicationSet installs every child app into namespace "hermes-<persona>",
so the persona is the namespace minus that prefix.
*/}}
{{- define "monitoring.persona" -}}
{{- trimPrefix "hermes-" .Release.Namespace -}}
{{- end -}}

{{/*
monitoring.uidbase - stable per-profile prefix for Grafana uids (rule,
contact point receiver, dashboard). Grafana caps uids at 40 chars, so the
namespace (already a DNS label <= 40) is truncated to leave room for the
short suffixes the templates append.
*/}}
{{- define "monitoring.uidbase" -}}
{{- trunc 32 .Release.Namespace | trimSuffix "-" -}}
{{- end -}}

{{/*
monitoring.serviceRegex - the Traefik service-label regex the site-visits
query filters on. Traefik names Kubernetes-Ingress-backed services
"<namespace>-<service>-<port>@kubernetes", so the default matches every
service of THIS profile's namespace.
*/}}
{{- define "monitoring.serviceRegex" -}}
{{- .Values.metric.serviceRegex | default (printf "%s-.*@kubernetes" .Release.Namespace) -}}
{{- end -}}

{{/*
monitoring.agentStatefulSet - the Hermes agent StatefulSet to health-watch.
Under the ApplicationSet naming convention the agent StatefulSet and the
profile namespace share the same name ("hermes-<persona>").
*/}}
{{- define "monitoring.agentStatefulSet" -}}
{{- .Values.agentStatefulSet | default .Release.Namespace -}}
{{- end -}}

{{/*
monitoring.contactPoint - the Grafana contact point name every rule in
this profile routes to (via notification_settings, no policy-tree edits).
*/}}
{{- define "monitoring.contactPoint" -}}
{{- printf "%s-alerts" .Release.Namespace -}}
{{- end -}}

{{/*
monitoring.rulesWouldRender - "1" when at least one alert rule would
render. Shared by the alerts gate and the receivers guard so they can
never disagree: they DID disagree, and a profile with only a business
rule enabled rendered a contact point with an empty receivers list and
three rules pointing at it (#617). The gate is the authority; the guard
asks it rather than restating it.
*/}}
{{- define "monitoring.rulesWouldRender" -}}
{{- if or .Values.alert.siteVisits5m.enabled .Values.alert.health.enabled .Values.alert.business.failures.enabled .Values.alert.business.inactivity.enabled -}}
1
{{- end -}}
{{- end -}}

{{/*
monitoring.receiversGuard - alerts with nowhere to go are a silent no-op,
and silent is worse than loud: if any rule is enabled, at least one
receiver URL must be set. The profile's hermes-gitops.yaml marks
alert.webhookUrl as valuesRequired, so a normal install already fails
earlier (in the emitter, listing the exact pulumi override command); this
guard is the chart-side backstop for direct helm renders.
*/}}
{{- define "monitoring.receiversGuard" -}}
{{- include "hermes-alerting.receiversGuard" (dict
      "chart" "charts/monitoring"
      "render" (include "monitoring.rulesWouldRender" .)
      "webhookUrl" .Values.alert.webhookUrl
      "discordUrl" .Values.alert.discordUrl
      "remedy" "supply at least one receiver (pulumi config set --path 'agents[<i>].overrides.appValues.monitoring.alert.webhookUrl' <url>)") -}}
{{- end -}}
