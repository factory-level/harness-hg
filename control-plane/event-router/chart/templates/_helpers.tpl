{{/* Fail loudly on a missing routing record - the guard every persona
     chart uses for its own required values. */}}
{{- define "hermes-event-router.spec" -}}
{{- if not .Values.spec.router -}}
{{- fail "hermes-event-router: .Values.spec must be a deployments/communication/<id>/values.yaml record (spec.router missing) - install with the emitted file, never bare" -}}
{{- end -}}
{{- end -}}

{{- define "hermes-event-router.service" -}}
{{- include "hermes-event-router.spec" . -}}
{{- .Values.spec.router.service -}}
{{- end -}}
