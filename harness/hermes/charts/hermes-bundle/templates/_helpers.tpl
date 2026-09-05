{{- define "hermes-bundle.name" -}}
{{- .Values.spec.name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "hermes-bundle.fullname" -}}
{{- printf "hermes-%s" (include "hermes-bundle.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "hermes-bundle.labels" -}}
app.kubernetes.io/name: hermes-bundle
app.kubernetes.io/instance: {{ include "hermes-bundle.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
hermes-gitops.factorylevel.dev/bundle: {{ include "hermes-bundle.name" . | quote }}
hermes-gitops.factorylevel.dev/managed: "true"
{{- end -}}

{{- define "hermes-bundle.selectorLabels" -}}
app.kubernetes.io/name: hermes-bundle
app.kubernetes.io/instance: {{ include "hermes-bundle.fullname" . }}
{{- end -}}

{{- define "hermes-bundle.image" -}}
{{- $tag := .Values.image.tag -}}
{{- if .Values.spec.deployment.baseImageTag -}}
{{- $tag = .Values.spec.deployment.baseImageTag -}}
{{- end -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
