{{/*
hermes.name - the bare instance name, derived from the Helm release name by
stripping the "hermes-" prefix. The profile record is plain Helm values with
no metadata (there is no HermesProfile CRD); identity comes from the
record's directory name, which the ApplicationSet passes here as
releaseName "hermes-{{.path.basename}}" (see
infra/gitops-template/bootstrap/applicationset.yaml). The name is a DNS-1123
label, maxLength 40 (enforced by the emitter, gitops_emitter/render.py's
validate_name), so "hermes-" + name stays well under the 63-char DNS label
limit even for derived names (e.g. PVC "data-hermes-<name>-0"). A release
name without the prefix passes through unchanged (trimPrefix no-ops), so a
standalone `helm template my-agent .` still renders.
*/}}
{{- define "hermes.name" -}}
{{- trimPrefix "hermes-" .Release.Name -}}
{{- end -}}

{{/*
hermes.fullname - "hermes-<name>" (equal to .Release.Name under the
ApplicationSet's releaseName convention).
*/}}
{{- define "hermes.fullname" -}}
{{- printf "hermes-%s" (include "hermes.name" .) -}}
{{- end -}}

{{/*
hermes.labels - standard recommended labels plus the persona label the
ApplicationSet itself sets on the parent Application (see applicationset.yaml).
*/}}
{{- define "hermes.labels" -}}
app.kubernetes.io/name: hermes-profile
app.kubernetes.io/instance: {{ include "hermes.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
hermes-gitops.factorylevel.dev/persona: {{ .Values.spec.persona | quote }}
hermes-gitops.factorylevel.dev/managed: "true"
{{- end -}}

{{/*
hermes.selectorLabels - the stable subset used in matchLabels/selectors (must
never gain fields across releases, unlike hermes.labels).
*/}}
{{- define "hermes.selectorLabels" -}}
app.kubernetes.io/name: hermes-profile
app.kubernetes.io/instance: {{ include "hermes.fullname" . }}
{{- end -}}

{{/*
hermes.kebab - ENV_VAR (UPPER_SNAKE_CASE) -> env-var (lower-kebab-case), used
to derive the per-secret remote key name external secrets look up
(hermes-<name>-<kebab>). Usage: {{ include "hermes.kebab" "DISCORD_BOT_TOKEN" }}

IMPORTANT: MUST byte-match the cloudflare-tunnel program's secret_name()
(infra/pulumi/programs/cloudflare-tunnel/cloudflare_tunnel/secrets.py) — shared
secret-naming contract for tunnel-path write-backs (see schemas/README).
Changes to this function require coordinated updates there and vice versa.
*/}}
{{- define "hermes.kebab" -}}
{{- . | lower | replace "_" "-" -}}
{{- end -}}

{{/*
hermes.envSecretName - the per-instance env Secret the workload's envFrom
references (templates/pod/statefulset.yaml). Materialized by the infra
program from stack-encrypted config (agentSecrets - issue #38 [K6]), NOT
rendered by this chart.
*/}}
{{- define "hermes.envSecretName" -}}
{{- printf "%s-env" (include "hermes.fullname" .) -}}
{{- end -}}

{{/*
hermes.apiKeySecretName - target Secret name for the minted API_SERVER_KEY
(templates/apikey-secret.yaml).
*/}}
{{- define "hermes.apiKeySecretName" -}}
{{- printf "%s-api-key" (include "hermes.fullname" .) -}}
{{- end -}}

{{/*
hermes.computeGuard - fail cleanly for providers.compute values that aren't
recognized. pod (templates/pod/*.yaml, StatefulSet) is the ONLY compute
provider: the per-agent VM compute path (gce/libvirt) was removed outright
(issue #27 [G8]) - agents are pod workloads, period. Called at the top of
every provider-specific template file so an unrecognized value (typo,
schema drift, a legacy gce/libvirt cluster-values) fails the whole
`helm template`/install loudly instead of silently rendering nothing.
*/}}
{{- define "hermes.computeGuard" -}}
{{- $compute := .Values.providers.compute -}}
{{- if eq $compute "pod" -}}
{{- else -}}
{{- fail (printf "providers.compute=%s: not a recognized compute provider (pod is the only compute provider; the per-agent VM path was removed)" $compute) -}}
{{- end -}}
{{- end -}}

{{/*
hermes.backupGuard - fail cleanly when a profile declares backup INTENT
(spec.backup) that the platform cannot implement. Intent is application-side
(schedule + retention in profile.yaml); the destination is platform-side
(providers.backup in cluster-values). Declared intent with providers.backup
unset/"none" must fail the whole render loudly - silently deploying an
instance that believes it is backed up when nothing archives it is the one
outcome this guard exists to prevent. Called from templates/pod/backup.yaml.
*/}}
{{- define "hermes.backupGuard" -}}
{{- $backend := .Values.providers.backup | default "none" -}}
{{- if and .Values.spec.backup (eq $backend "none") -}}
{{- fail (printf "profile %q declares spec.backup but providers.backup is \"none\": the platform has no backup destination configured (set providers.backup=pvc in cluster-values)" (include "hermes.name" .)) -}}
{{- else if and (ne $backend "pvc") (ne $backend "none") -}}
{{- fail (printf "providers.backup=%s: not a recognized backup provider (pvc, none)" $backend) -}}
{{- end -}}
{{- end -}}

{{/*
hermes.ingressGuard - fail cleanly for providers.ingress values that don't
have an implementation. "ingress" (a plain Kubernetes Ingress resource,
templates/pod/ingress.yaml), "none" (no ingress rendered) and "cloudflare"
(templates/tunnel/stack-cloudflare.yaml, a Pulumi Kubernetes Operator Stack
CR - Task 12) are implemented; anything else fails as unrecognized.

"tailscale" was the fourth, removed per ADR-9: its status was described
three contradictory ways in-tree and nothing tested it. It now fails here
like any other unrecognized value, which is the point - a half-implemented
provider that renders is worse than one that refuses.
*/}}
{{- define "hermes.ingressGuard" -}}
{{- $ingress := .Values.providers.ingress -}}
{{- if or (eq $ingress "ingress") (eq $ingress "none") (eq $ingress "cloudflare") -}}
{{- else -}}
{{- fail (printf "providers.ingress=%s: not a recognized ingress provider" $ingress) -}}
{{- end -}}
{{- end -}}

{{/*
hermes.cloudflareConfigGuard - fail cleanly, with an actionable message,
when providers.ingress == "cloudflare" but the cluster-values/profile
config the tunnel Stack CR (templates/tunnel/stack-cloudflare.yaml) needs
isn't fully set. (The `cloudflare:` block is schema-legal in the
canonical cluster-values schema since issue #20 [G2]; this guard remains
the enforcement point for which keys are REQUIRED once the cloudflare
ingress provider is actually selected - the schema keeps them optional so
a non-cloudflare fleet needs no cloudflare config at all.)
Checks FOUR independent things:
  1. cloudflare.{accountId,zoneId,zoneName} - required for any cloudflare
     tunnel to exist at all.
  2. spec.expose.services - a tunnel with nothing exposed has no ingress
     rule to create beyond the mandatory catch-all; fail at helm-template
     time rather than silently produce a Stack CR that does nothing
     useful.
  3. cloudflare.access.idpId - required only when spec.expose.access.policy
     is "idp" or "mixed" (an existing Cloudflare Access Identity Provider
     integration id - this program never creates one, see
     _docs/wiki/platform/tunneling.md).
  4. cloudflare.pulumiBackend.mode and its mode-specific fields
     (pulumi-cloud needs nothing extra; self-managed needs backendUrl).
Called only from templates/tunnel/*.yaml, after hermes.ingressGuard.
*/}}
{{- define "hermes.cloudflareConfigGuard" -}}
{{- $cf := .Values.cloudflare | default dict -}}
{{- $missing := list -}}
{{- if not $cf.accountId -}}{{- $missing = append $missing "cloudflare.accountId" -}}{{- end -}}
{{- if not $cf.zoneId -}}{{- $missing = append $missing "cloudflare.zoneId" -}}{{- end -}}
{{- if not $cf.zoneName -}}{{- $missing = append $missing "cloudflare.zoneName" -}}{{- end -}}
{{- if $missing -}}
{{- fail (printf "providers.ingress=cloudflare requires cluster-values %s to be set (see values.yaml's cloudflare{} block / _docs/wiki/platform/tunneling.md)" (join ", " $missing)) -}}
{{- end -}}
{{- if not .Values.spec.expose -}}
{{- fail "providers.ingress=cloudflare requires spec.expose.services to be set (a tunnel with nothing exposed has no ingress rule to create beyond the mandatory catch-all - see _docs/wiki/platform/tunneling.md)" -}}
{{- end -}}
{{- $access := .Values.spec.expose.access | default dict -}}
{{- $policy := $access.policy | default "service-token" -}}
{{- $accessCfg := $cf.access | default dict -}}
{{- if or (eq $policy "idp") (eq $policy "mixed") -}}
{{- if not $accessCfg.idpId -}}
{{- fail (printf "spec.expose.access.policy=%s requires cluster-values cloudflare.access.idpId (an existing Cloudflare Access Identity Provider integration id) to be set" $policy) -}}
{{- end -}}
{{- end -}}
{{- $backend := $cf.pulumiBackend | default dict -}}
{{- $mode := $backend.mode | default "" -}}
{{- if eq $mode "pulumi-cloud" -}}
{{- else if eq $mode "self-managed" -}}
{{- $selfManaged := $backend.selfManaged | default dict -}}
{{- if not $selfManaged.backendUrl -}}
{{- fail "providers.ingress=cloudflare with cloudflare.pulumiBackend.mode=self-managed requires cloudflare.pulumiBackend.selfManaged.backendUrl (e.g. gs://<bucket>/hermes-gitops)" -}}
{{- end -}}
{{- else -}}
{{- fail (printf "providers.ingress=cloudflare requires cloudflare.pulumiBackend.mode to be 'pulumi-cloud' or 'self-managed' (got %q)" $mode) -}}
{{- end -}}
{{- end -}}

{{/*
hermes.exposeServiceNamesGuard - fail cleanly if spec.expose.services[] uses
a reserved port name. "http" is reserved for the agent API port (port 8642,
hardcoded in templates/pod/service.yaml); duplicate port names in a Kubernetes
Service spec are rejected. This guard must run before rendering any service
port entries to catch the conflict early.
*/}}
{{- define "hermes.exposeServiceNamesGuard" -}}
{{- if .Values.spec.expose -}}
{{- range $svc := .Values.spec.expose.services -}}
{{- if eq $svc.name "http" -}}
{{- fail (printf "spec.expose.services[].name='http' is reserved for the agent API port (8642); choose a different name") -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
hermes.envGuard - fail cleanly when a COMPILED environment variable
(spec.env, the topology compiler's capability injection - ADR-36, ADR-97)
would collide with a variable something else already owns.

spec.env arrives from deployments/agents/<id>/values.yaml, layered by the
hermes-gitops-agents ApplicationSet AFTER the profile record. It is the
materialized half of `requires[]`: the compiler resolved a capability name
to a URL and named the variable to put it in.

A collision must be an ERROR, never a precedence rule. The two ways THIS
GUARD can catch have opposite runtime outcomes, and neither is acceptable
silently:

  - against spec.envRequires: that variable comes from the per-instance
    env Secret via envFrom. Explicit `env` beats `envFrom` in Kubernetes,
    so the injected URL would SHADOW the operator's secret value - a
    credential silently replaced by a URL.
  - against a chart-owned variable (the API server's address and key, the
    observer's metrics settings): the injection would override the
    chart's own contract with its pod.

The compiler already refuses this at compile time (TOPO014 for a collision
with a declared envRequires, TOPO015 for an undeclared app). This guard is
the second half of the same rule, enforced where the values actually meet:
the compiler sees one profile's declarations, the render sees every layer.

WHAT THIS GUARD CANNOT SEE (Codex catch): the env Secret carries every
configured agentSecrets.<instance> key, including ones the profile never
declared in envRequires - and Secret contents are invisible at render
time. That residual collision class is closed by the Pulumi preview
gate's reserved-env check (topology-preview.ts), which holds both the
plan's injections and the agentSecrets names.
*/}}
{{- define "hermes.envGuard" -}}
{{- $env := .Values.spec.env | default dict -}}
{{- if $env -}}
{{/* Chart-owned variables, set explicitly in pod/statefulset.yaml. Listed
     here rather than derived because the template sets them literally;
     if that list changes, this one changes with it. */}}
{{- $owned := list "API_SERVER_HOST" "API_SERVER_PORT" "API_SERVER_KEY" "HERMES_OBSERVER_METRICS" "HERMES_OBSERVER_METRICS_PORT" "HERMES_OBSERVER_URL" -}}
{{/* envRequires accepts both shapes (v1alpha3): a bare string is a name,
     an object carries the name plus its metadata. */}}
{{- $declared := list -}}
{{- range .Values.spec.envRequires | default list -}}
{{- if kindIs "string" . -}}
{{- $declared = append $declared . -}}
{{- else -}}
{{- $declared = append $declared .name -}}
{{- end -}}
{{- end -}}
{{- range $name, $value := $env -}}
{{- if has $name $owned -}}
{{- fail (printf "spec.env[%s] collides with a variable the chart sets itself (%s) - a capability injection cannot override the agent's own runtime contract. Rename the requires[].inject.env target in the profile's hermes-gitops.yaml (convention: HERMES_CAP_<NAME>_URL)" $name (join ", " $owned)) -}}
{{- end -}}
{{- if has $name $declared -}}
{{- fail (printf "spec.env[%s] collides with a declared spec.envRequires entry of the same name - the injected capability URL would SHADOW the secret value delivered by envFrom, because explicit env beats envFrom in Kubernetes. Rename the requires[].inject.env target, or drop the envRequires entry if the capability now supplies it" $name) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
hermes.appsGuard - fail cleanly, with an actionable message, for spec.apps[]
declarations the platform cannot deliver (templates/apps.yaml renders one
Argo CD Application per entry). The values schema already enforces per-entry
SHAPE (name/chart/repo keys, dns-label names); this guard enforces the
CROSS-CONFIG rules that need cluster-values in hand:
  1. apps[].name unique within the record (a duplicate would render two
     Applications with the same metadata.name and last-write-wins silently).
  2. remote repos: `version` required (deterministic deploys); the repo URL
     must be in the appProject.sourceRepos allowlist (cluster-values) or the
     child Application would be created and then permanently refused by the
     AppProject's sourceRepos gate - fail at render time instead, naming
     both places to fix (cluster-values AND the scaffolded repo's
     bootstrap/project.yaml, which must stay in sync).
  3. repo `local`: `version` forbidden (local charts version with the
     platform repo); platformRepo.url/revision must be set (they are the
     Application source) - always allowed, no allowlist entry needed.
*/}}
{{- define "hermes.appsGuard" -}}
{{- $seen := dict -}}
{{- $allowed := list -}}
{{- with .Values.appProject -}}{{- $allowed = .sourceRepos | default list -}}{{- end -}}
{{- $platform := .Values.platformRepo | default dict -}}
{{- range .Values.spec.apps -}}
{{- if hasKey $seen .name -}}
{{- fail (printf "spec.apps: app name %q is declared twice (names must be unique within the record)" .name) -}}
{{- end -}}
{{- $_ := set $seen .name true -}}
{{- if eq .repo "local" -}}
{{- if .version -}}
{{- fail (printf "spec.apps[%s].version is forbidden for repo: local (local charts version with the platform repo via platformRepo.revision)" .name) -}}
{{- end -}}
{{- if or (not $platform.url) (not $platform.revision) -}}
{{- fail (printf "spec.apps[%s] uses repo: local but cluster-values platformRepo.url/platformRepo.revision are not set (the platform repo is the Application source for local charts)" .name) -}}
{{- end -}}
{{- else -}}
{{- if not .version -}}
{{- fail (printf "spec.apps[%s].version is required for remote helm repo %s (deterministic deploys)" .name .repo) -}}
{{- end -}}
{{- if not (has .repo $allowed) -}}
{{- fail (printf "spec.apps[%s].repo %s is not in the platform's allow-list. Add it to cluster-values appProject.sourceRepos AND to the AppProject's sourceRepos in the GitOps repo's bootstrap/project.yaml (repo: local needs no entry)" .name .repo) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
hermes.appName - "hermes-<name>-<app>", the child Application's
metadata.name. Flat namespace in argocd: prefixing with the instance
fullname keeps two profiles' same-named apps from colliding.
*/}}
{{- define "hermes.appName" -}}
{{- printf "%s-%s" (include "hermes.fullname" .root) .app -}}
{{- end -}}

{{/*
hermes.gitCloneURL - validates spec.source looks git-clonable and normalizes
it to a URL the bootstrap initContainer can `git clone`. Accepts explicit
http(s)://, git@, ssh:// sources as-is; a bare "host.tld/path" form (the
convention used throughout schemas/hermesprofile/v1alpha2/examples/, e.g.
"github.com/factorylevel/support-agent") is prefixed with "https://". Any
other shape (e.g. a local filesystem path) fails: the pod compute path
requires a git-URL source (see Chart.yaml / Task 8 brief) - local-dir
sources are a dev-only convenience of the CLI's `hermes profile install`,
not supported by this StatefulSet's initContainer.
*/}}
{{- define "hermes.gitCloneURL" -}}
{{- $src := .Values.spec.source -}}
{{- if or (hasPrefix "http://" $src) (hasPrefix "https://" $src) (hasPrefix "git@" $src) (hasPrefix "ssh://" $src) -}}
{{- $src -}}
{{- else if regexMatch "^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(/|$)" $src -}}
{{- printf "https://%s" $src -}}
{{- else -}}
{{- fail (printf "spec.source %q does not look like a git URL. Pod compute requires a git-clonable source (https://, git@, ssh://, or a bare \"host.tld/path\"); local filesystem paths are a dev-only hermes CLI convenience and are not supported here." $src) -}}
{{- end -}}
{{- end -}}

{{/*
hermes.tunnelStackName - "hermes-<metadata.name>-tunnel", the Stack CR name
templates/tunnel/stack-cloudflare.yaml renders. Deliberately a DIFFERENT
name from hermes.fullname - this is an independent Stack (own Pulumi
program, own state, own lifecycle) that coexists with the pod workload,
not a variant of it - see stack-cloudflare.yaml's header comment.
*/}}
{{- define "hermes.tunnelStackName" -}}
{{- printf "%s-tunnel" (include "hermes.fullname" .) -}}
{{- end -}}

{{/*
hermes.tunnelPulumiBackendSecretName - target Secret name for the
ExternalSecret that materializes the tunnel Stack's OWN Pulumi
state-backend credential (templates/tunnel/pulumi-backend-cloudflare.yaml),
consumed by templates/tunnel/stack-cloudflare.yaml's Stack CR envRefs.
*/}}
{{- define "hermes.tunnelPulumiBackendSecretName" -}}
{{- printf "%s-tunnel-pulumi-backend" (include "hermes.fullname" .) -}}
{{- end -}}

{{/*
hermes.cloudflareApiTokenSecretName - target Secret name for the
ExternalSecret that materializes the CLOUDFLARE_API_TOKEN the tunnel
Stack's workspace pod authenticates the pulumi_cloudflare provider with
(templates/tunnel/cloudflare-api-token.yaml). Same "renders once PER
instance namespace, reads a SHARED fleet-wide remote key" shape as
hermes.tunnelPulumiBackendSecretName above - see values.yaml's
cloudflare.apiToken.remoteSecretKey.
*/}}
{{- define "hermes.cloudflareApiTokenSecretName" -}}
{{- printf "%s-cloudflare-api-token" (include "hermes.fullname" .) -}}
{{- end -}}

{{/*
hermes.cfTunnelTokenSecretName - "hermes-<name>-cf-tunnel-token", the LOCAL
Secret name templates/tunnel/cf-tunnel-token-secret.yaml's ExternalSecret
targets AND the REMOTE key it reads (both the same string - see that
file's header comment). Computed via hermes.kebab the same way every other
per-instance secret name in this chart is (_helpers.tpl's own docstring on
hermes.kebab) - "CF_TUNNEL_TOKEN" is not a
literal spec.envRequires entry, but reusing the exact same derivation
keeps "what secret backs X" one mental model.
*/}}
{{- define "hermes.cfTunnelTokenSecretName" -}}
{{- printf "hermes-%s-%s" (include "hermes.name" .) (include "hermes.kebab" "CF_TUNNEL_TOKEN") -}}
{{- end -}}

{{/*
hermes.profileChecksum - sha256 of the profile spec, used as a pod annotation
so a profile.yaml change (new sha, new envRequires, etc.) rolls the pod even
though nothing in the chart's own templates changed.
*/}}
{{- define "hermes.profileChecksum" -}}
{{- .Values.spec | toJson | sha256sum -}}
{{- end -}}
