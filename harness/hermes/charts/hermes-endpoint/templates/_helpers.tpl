{{/* Which endpoints this chart realizes at the edge. Included: `public`
     (explicitly declared world-reachable) and `webhook` (schema-enforced
     signature verification at the receiver). EXCLUDED until their
     enforcement objects exist (ADR-35 cost): `authenticated` and
     `external` - rendering them as bare Ingresses would expose an
     identity-gated or service-token endpoint with no gate, so they render
     NOTHING here, loudly documented, rather than an open door.
     `internal`/`private` are cluster-DNS-reachable by definition. An
     entry also needs the compiler-projected `url`. */}}
{{- define "hermesEndpoint.exposed" -}}
{{- $out := list -}}
{{- range .Values.spec.endpoints | default list -}}
{{- if and .url (has .type (list "public" "webhook")) -}}
{{- $out = append $out . -}}
{{- end -}}
{{- end -}}
{{- $out | toJson -}}
{{- end -}}

{{- define "hermesEndpoint.guard" -}}
{{- if not .Values.spec.id -}}
{{- fail "hermes-endpoint: spec.id is required (this chart consumes a deployments/endpoints record, never hand-authored values)" -}}
{{- end -}}
{{- range .Values.spec.endpoints | default list -}}
{{- if not .backend -}}
{{- fail (printf "hermes-endpoint: endpoint %s carries no backend routing - regenerate the record with a current `hg topology emit`" .name) -}}
{{- end -}}
{{- end -}}
{{- if eq .Values.providers.ingress "cloudflare" -}}
{{- fail "hermes-endpoint: providers.ingress=cloudflare is not implemented by this chart yet (the standalone-tunnel Stack is a declared follow-up; use providers.ingress=ingress, or none)" -}}
{{- end -}}
{{- if not (has .Values.providers.ingress (list "ingress" "none")) -}}
{{- fail (printf "hermes-endpoint: providers.ingress must be ingress|none, got %q" .Values.providers.ingress) -}}
{{- end -}}
{{- end -}}

{{/* hostname from the compiler-projected URL: strip scheme, cut at the
     first slash. The compiler owns naming; this chart never builds a
     hostname itself. (regexReplaceAll is (pattern, string, replacement) -
     never pipe the string in, the pipe lands in the REPLACEMENT slot.) */}}
{{- define "hermesEndpoint.host" -}}
{{- $noScheme := regexReplaceAll "^https?://" . "" -}}
{{- regexReplaceAll "/.*$" $noScheme "" -}}
{{- end -}}

{{/* Deterministic object name for one endpoint: <id>-<endpoint>,
     flattened; over 63 chars it keeps a readable 54-char head plus an
     8-char sha256 of the FULL identity (the compiler's k8sName
     discipline) so distinct endpoints can never alias by truncation. */}}
{{- define "hermesEndpoint.objectName" -}}
{{- $full := printf "%s-%s" (index . 0) (index . 1) | replace "/" "-" | replace "@" "-" -}}
{{- if le (len $full) 63 -}}
{{- $full -}}
{{- else -}}
{{- printf "%s-%s" (trunc 54 $full | trimSuffix "-") (sha256sum $full | trunc 8) -}}
{{- end -}}
{{- end -}}
