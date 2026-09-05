{{/*
app.fullname - the base name for this app's Deployment; each Service appends
its own -<service> suffix. Just the release name (which the ApplicationSet
sets to hermes-<persona>-<appname>), so names stay short and deterministic
even with several services — the local testing CLI's smoke check can address
"<fullname>-<service>" reliably.
*/}}
{{- define "app.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
app.labels - the standard selector labels, shared by Deployment pod template
and Service selector so they always agree.
*/}}
{{- define "app.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
