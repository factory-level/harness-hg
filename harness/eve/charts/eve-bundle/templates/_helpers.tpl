{{/*
Helper partials for the eve-bundle chart (ADR-150). An Eve bundle is named
`ag-eve-<bundle>` (ADR-151) - namespace, Service, StatefulSet - with
`ag-eve-<bundle>-<member>-route-auth` per member; the bundle-aware surfaces
in `hg` (backupNsOf, the recovery proof, Argo identity) derive the same
prefix from the members' runtime. Labels stay hermes-gitops.factorylevel.dev.
*/}}

{{- define "eve-bundle.name" -}}
{{- .Values.spec.name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "eve-bundle.fullname" -}}
{{- printf "ag-eve-%s" (include "eve-bundle.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "eve-bundle.labels" -}}
app.kubernetes.io/name: eve-bundle
app.kubernetes.io/instance: {{ include "eve-bundle.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
hermes-gitops.factorylevel.dev/bundle: {{ include "eve-bundle.name" . | quote }}
hermes-gitops.factorylevel.dev/runtime: eve
hermes-gitops.factorylevel.dev/managed: "true"
{{- end -}}

{{- define "eve-bundle.selectorLabels" -}}
app.kubernetes.io/name: eve-bundle
app.kubernetes.io/instance: {{ include "eve-bundle.fullname" . }}
{{- end -}}

{{- define "eve-bundle.image" -}}
{{- $tag := .Values.runtimeImage.tag -}}
{{- if .Values.spec.deployment.runtimeImageTag -}}
{{- $tag = .Values.spec.deployment.runtimeImageTag -}}
{{- end -}}
{{- printf "%s:%s" .Values.runtimeImage.repository $tag -}}
{{- end -}}

{{/*
eve-bundle.memberPort - (dict "index" i "profile" p): the member's listen
port, apiServerPort when declared else 3000 + index.
*/}}
{{- define "eve-bundle.memberPort" -}}
{{- if .profile.apiServerPort -}}{{- .profile.apiServerPort -}}{{- else -}}{{- add 3000 .index -}}{{- end -}}
{{- end -}}

{{/*
eve-bundle.routeAuthSecretName - (dict "root" $ "member" name):
ag-eve-<bundle>-<member>-route-auth, one minted credential per member.
*/}}
{{- define "eve-bundle.routeAuthSecretName" -}}
{{- printf "%s-%s-route-auth" (include "eve-bundle.fullname" .root) .member -}}
{{- end -}}

{{- define "eve-bundle.workspaceEnvName" -}}
{{- printf "EVE_WORKSPACE_%s" (regexReplaceAll "[^A-Z0-9]+" (upper .) "_") -}}
{{- end -}}

{{- define "eve-bundle.cloneURLOf" -}}
{{- $src := . | toString -}}
{{- if or (hasPrefix "http://" $src) (hasPrefix "https://" $src) (hasPrefix "git@" $src) (hasPrefix "ssh://" $src) -}}
{{- $src -}}
{{- else if regexMatch "^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(/|$)" $src -}}
{{- printf "https://%s" $src -}}
{{- else -}}
{{- fail (printf "source %q does not look like a git URL (https://, git@, ssh://, or a bare \"host.tld/path\")" $src) -}}
{{- end -}}
{{- end -}}

{{- define "eve-bundle.workspaceBindings" -}}
{{- $lines := list -}}
{{- range . -}}
{{- $lines = append $lines (printf "%s %s %s %s" .name (include "eve-bundle.cloneURLOf" .source) (.sha | toString) (.access | default "read-write")) -}}
{{- end -}}
{{- join "\n" $lines -}}
{{- end -}}

{{/*
eve-bundle.guard - the whole-record checks, run from every template:
  - spec.runtime must be eve (a Hermes bundle record routed here by mistake
    would build nothing and serve nothing);
  - the Hermes dashboard container has no Eve realization (refused, not
    silently dropped);
  - member names unique, DNS labels; full shas; unique ports; every
    repositoryRef names a declared repository; repository names unique and
    no two map to one EVE_WORKSPACE_ variable;
  - at least one enabled member.
*/}}
{{- define "eve-bundle.guard" -}}
{{- if ne (.Values.spec.runtime | default "hermes" | toString) "eve" -}}
{{- fail (printf "eve-bundle: spec.runtime is %q - this chart realizes Eve bundles only; a Hermes bundle record carries chart: hermes-bundle" (.Values.spec.runtime | default "hermes" | toString)) -}}
{{- end -}}
{{- if and .Values.spec.dashboard .Values.spec.dashboard.enabled -}}
{{- fail "eve-bundle: spec.dashboard.enabled is a Hermes dashboard knob with no Eve realization (ADR-150 cost) - disable it for an Eve bundle" -}}
{{- end -}}
{{- $names := dict -}}
{{- $ports := dict -}}
{{- $repos := dict -}}
{{- $envs := dict -}}
{{- $enabled := 0 -}}
{{- range .Values.spec.repositories -}}
{{- if hasKey $repos .name -}}{{- fail (printf "eve-bundle: repository %q declared twice" .name) -}}{{- end -}}
{{- $_ := set $repos .name . -}}
{{- $env := include "eve-bundle.workspaceEnvName" .name -}}
{{- if hasKey $envs $env -}}{{- fail (printf "eve-bundle: repositories %q and %q both map to %s" .name (get $envs $env) $env) -}}{{- end -}}
{{- $_ := set $envs $env .name -}}
{{- if not (regexMatch "^[0-9a-f]{40}$" (.sha | toString)) -}}{{- fail (printf "eve-bundle: repository %q sha must be a full 40-hex commit" .name) -}}{{- end -}}
{{- end -}}
{{- range $i, $p := .Values.spec.profiles -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" ($p.name | toString)) -}}{{- fail (printf "eve-bundle: member name %q must be a DNS-1123 label" ($p.name | toString)) -}}{{- end -}}
{{- if hasKey $names $p.name -}}{{- fail (printf "eve-bundle: member %q declared twice" $p.name) -}}{{- end -}}
{{- $_ := set $names $p.name true -}}
{{- if not (regexMatch "^[0-9a-f]{40}$" ($p.sha | toString)) -}}{{- fail (printf "eve-bundle: member %q sha must be a full 40-hex commit" $p.name) -}}{{- end -}}
{{- if ne ($p.gatewayEnabled | default true | toString) "false" -}}
{{- $enabled = add $enabled 1 -}}
{{- $port := include "eve-bundle.memberPort" (dict "index" $i "profile" $p) -}}
{{- if hasKey $ports $port -}}{{- fail (printf "eve-bundle: port %s is used by members %q and %q" $port (get $ports $port) $p.name) -}}{{- end -}}
{{- $_ := set $ports $port $p.name -}}
{{- end -}}
{{- range $p.repositoryRefs -}}
{{- if not (hasKey $repos .) -}}{{- fail (printf "eve-bundle: member %q repositoryRef %q does not name a declared repository" $p.name .) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- if eq $enabled 0 -}}{{- fail "eve-bundle: at least one member must be enabled" -}}{{- end -}}
{{- end -}}

{{- define "eve-bundle.ingressGuard" -}}
{{- $ingress := .Values.providers.ingress -}}
{{- if or (eq $ingress "ingress") (eq $ingress "none") -}}
{{- else if eq $ingress "cloudflare" -}}
{{- fail "providers.ingress=cloudflare: the eve-bundle chart has no Cloudflare Tunnel realization (ADR-149 cost) - use ingress or none" -}}
{{- else -}}
{{- fail (printf "providers.ingress=%s: not a recognized ingress provider" $ingress) -}}
{{- end -}}
{{- end -}}

{{/*
eve-bundle.runtimeManifest - the runtime manifest (ADR-153) for ONE member
of a bundle. Same object as eve-agent's, and it must stay the same object:
`hg agent prove` EVE022 compares a member's mounted manifest with what
cli/src/harness/manifest.ts computes for it. A member's workspaces are the
bundle-level repositories its repositoryRefs names, at the bundle's shared
claim; its apps are empty by design (a bundled member's apps deploy from
deployments/apps, not from this chart - EVE020).

Takes (dict "root" $ "member" <the spec.profiles[] entry>).
*/}}
{{- define "eve-bundle.runtimeManifest" -}}
{{- $root := .root -}}
{{- $m := .member -}}
{{- $refs := $m.repositoryRefs | default list -}}
{{- $wsByName := dict -}}
{{- range ($root.Values.spec.repositories | default list) -}}
{{- if has .name $refs -}}
{{- $_ := set $wsByName .name (dict
      "name" .name
      "path" (.mountPath | default (printf "/workspaces/%s" .name))
      "access" (.access | default "read-write")
      "repository" (.source | default "")
      "revision" (.sha | default "" | toString)) -}}
{{- end -}}
{{- end -}}
{{- $workspaces := list -}}
{{- range $n := (keys $wsByName | sortAlpha) -}}
{{- $workspaces = append $workspaces (get $wsByName $n) -}}
{{- end -}}
{{- $connByName := dict -}}
{{- range ($m.connections | default list) -}}
{{- $_ := set $connByName .name (dict "name" .name "provider" .provider) -}}
{{- end -}}
{{- $connections := list -}}
{{- range $n := (keys $connByName | sortAlpha) -}}
{{- $connections = append $connections (get $connByName $n) -}}
{{- end -}}
{{- $source := dict "repository" ($m.source | default "") "revision" ($m.sha | default "" | toString) -}}
{{- if $m.sourceSubdir -}}
{{- $_ := set $source "subdir" $m.sourceSubdir -}}
{{- end -}}
{{- $spec := dict
      "name" $m.name
      "engine" ($root.Values.spec.runtime | default "eve")
      "instance" (printf "%s-%s" (include "eve-bundle.fullname" $root) $m.name)
      "namespace" $root.Release.Namespace
      "bundle" $root.Values.spec.name
      "runtimeImage" (include "eve-bundle.image" $root)
      "source" $source
      "workspaces" $workspaces
      "requiredSecrets" (sortAlpha ($m.envRequires | default list) | uniq)
      "connections" $connections
      "apps" (list) -}}
{{- dict "contract" "agent-runtime/v1alpha1" "spec" $spec | toJson -}}
{{- end -}}
