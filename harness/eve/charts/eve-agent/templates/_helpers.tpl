{{/*
Helper partials for the eve-agent chart (ADR-149). Naming, labels and the
guards are COPIES of harness/hermes/charts/hermes-profile/templates/_helpers.tpl's
partials under the `eve.` prefix - Helm has no cross-chart include without a
library chart, and the two charts must stay independently renderable. An
Eve instance is named `ag-eve-<name>` (ADR-151): namespace, Application,
Service, StatefulSet and every derived Secret (ag-eve-<name>-env,
ag-eve-<name>-route-auth). The topology compiler, the secret delivery, the
bootstrap ApplicationSets and `hg` all derive the same prefix from the
runtime; the hermes-gitops.factorylevel.dev labels stay platform-wide.
*/}}

{{/*
eve.name - the bare instance name: the release name minus "ag-eve-".
*/}}
{{- define "eve.name" -}}
{{- trimPrefix "ag-eve-" .Release.Name -}}
{{- end -}}

{{/*
eve.fullname - "ag-eve-<name>" (equal to .Release.Name under the
ApplicationSet's releaseName convention).
*/}}
{{- define "eve.fullname" -}}
{{- printf "ag-eve-%s" (include "eve.name" .) -}}
{{- end -}}

{{/*
eve.labels - standard recommended labels plus the platform's persona/runtime
labels.
*/}}
{{- define "eve.labels" -}}
app.kubernetes.io/name: eve-agent
app.kubernetes.io/instance: {{ include "eve.fullname" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
hermes-gitops.factorylevel.dev/persona: {{ .Values.spec.persona | quote }}
hermes-gitops.factorylevel.dev/runtime: eve
hermes-gitops.factorylevel.dev/managed: "true"
{{- end -}}

{{/*
eve.selectorLabels - the stable subset used in matchLabels/selectors (must
never gain fields across releases).
*/}}
{{- define "eve.selectorLabels" -}}
app.kubernetes.io/name: eve-agent
app.kubernetes.io/instance: {{ include "eve.fullname" . }}
{{- end -}}

{{/*
eve.envSecretName - the per-instance env Secret the workload's envFrom
references. Materialized by the infra program from stack-encrypted config
(agentSecrets), NOT rendered by this chart - the same Secret name the
hermes-profile chart uses, so secret delivery is runtime-agnostic.
*/}}
{{- define "eve.envSecretName" -}}
{{- printf "%s-env" (include "eve.fullname" .) -}}
{{- end -}}

{{/*
eve.routeAuthSecretName - target Secret of the minted route-auth password
(templates/route-auth-secret.yaml); `hg` reads the same Secret to
authenticate its smoke turn.
*/}}
{{- define "eve.routeAuthSecretName" -}}
{{- printf "%s-route-auth" (include "eve.fullname" .) -}}
{{- end -}}

{{/*
eve.runtimeGuard - the record must be an Eve record. The ApplicationSet
routes on spec.chart; a Hermes record reaching this chart (a hand-edited
record, a wrong path) must fail the render, not boot a Hermes profile on
Node.
*/}}
{{- define "eve.runtimeGuard" -}}
{{- if ne (.Values.spec.runtime | default "") "eve" -}}
{{- fail (printf "spec.runtime=%q: the eve-agent chart renders EveAgent records only (spec.runtime: eve); a HermesProfile record belongs to harness/hermes/charts/hermes-profile" (.Values.spec.runtime | default "")) -}}
{{- end -}}
{{- end -}}

{{/*
eve.computeGuard - pod is the only compute provider (same invariant as
hermes-profile).
*/}}
{{- define "eve.computeGuard" -}}
{{- $compute := .Values.providers.compute -}}
{{- if eq $compute "pod" -}}
{{- else -}}
{{- fail (printf "providers.compute=%s: not a recognized compute provider (pod is the only compute provider)" $compute) -}}
{{- end -}}
{{- end -}}

{{/*
eve.ingressGuard - "ingress" and "cloudflare" both render the SAME plain
Kubernetes Ingress (templates/ingress.yaml); "none" renders nothing.

"cloudflare" does NOT mean a per-agent tunnel here. An Eve agent reaches the
edge over the environment's ONE shared control-plane tunnel: cloudflare-ingress
publishes "<name>.<zoneName>" for every agents[] entry regardless of runtime
and routes it to services.traefik with the host header rewritten to
"<name>.<agentHostHeaderDomain>" (infra/src/components/cloudflare-ingress/,
controlPlaneHostnames) - which is exactly the host this chart's Ingress
carries, so keep ingress.baseDomain equal to agentHostHeaderDomain.

What Eve does not get, and hermes-profile does: a per-instance cloudflared
sidecar and tunnel Stack CR (hermes-profile's templates/tunnel/), and with
them any author-declared exposure - an Eve agent cannot opt out of publishing,
choose its own Access policy, or expose a second service. Those are the
environment's decisions (controlPlaneIngress.access.groups), not the persona's.
*/}}
{{- define "eve.ingressGuard" -}}
{{- $ingress := .Values.providers.ingress -}}
{{- if or (eq $ingress "ingress") (eq $ingress "cloudflare") (eq $ingress "none") -}}
{{- else -}}
{{- fail (printf "providers.ingress=%s: not a recognized ingress provider" $ingress) -}}
{{- end -}}
{{- end -}}

{{/*
eve.envGuard - fail when a compiled injection (spec.env, the topology
compiler's overlay) or a declared requirement (spec.envRequires) names a
variable this chart itself sets on the main container. `env` beats
`envFrom` in Kubernetes, so an injected ROUTE_AUTH_BASIC_PASSWORD would
silently replace the minted credential - the one outcome this guard
exists to prevent. $owned is a hand-maintained mirror of statefulset.yaml's
env block; keep the two in step.
*/}}
{{- define "eve.envGuard" -}}
{{- $owned := list "PORT" "HOST" "HOME" "NODE_ENV" "ROUTE_AUTH_BASIC_USERNAME" "ROUTE_AUTH_BASIC_PASSWORD" "ROUTE_AUTH_BASIC_PASSWORD_FILE" "EVE_DIST_SOURCE" "EVE_DIST_SHA" "EVE_DIST_SUBDIR" "EVE_PROJECT_DIR" "EVE_WORKSPACES_ROOT" "EVE_PUBLIC_ROUTE_PREFIX" "EXPECTED_EVE_VERSION" "HG_RUNTIME_DIGEST" "HG_BUILD_RECEIPT" "HG_EXPECTED_SOURCE_SHA" "HG_EXPECTED_OVERLAY_DIGEST" "HG_EXPECTED_BUILD_KEY" "HG_EXPECTED_RUNTIME_DIGEST" "HG_EXPECTED_EVE_VERSION" -}}
{{- with .Values.spec.workspace -}}{{- range .repositories -}}{{- $owned = append $owned (include "eve.workspaceEnvName" .name) -}}{{- end -}}{{- end -}}
{{- range $k, $_ := (.Values.spec.env | default dict) -}}
{{- if has $k $owned -}}
{{- fail (printf "spec.env.%s collides with a chart-owned variable (%s); the compiled overlay may not shadow it" $k (join ", " $owned)) -}}
{{- end -}}
{{- end -}}
{{- range $e := (.Values.spec.envRequires | default list) -}}
{{- $n := $e -}}
{{- if kindIs "map" $e -}}{{- $n = $e.name -}}{{- end -}}
{{- if has $n $owned -}}
{{- fail (printf "spec.envRequires names %s, a chart-owned variable (%s); declare a different name" $n (join ", " $owned)) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
eve.gitCloneURL - http(s)://, git@, ssh:// sources as-is; a bare
"host.tld/path" is prefixed with https://; anything else fails (the pod
needs a git-clonable source).
*/}}
{{- define "eve.gitCloneURL" -}}
{{- $src := .Values.spec.source -}}
{{- if or (hasPrefix "http://" $src) (hasPrefix "https://" $src) (hasPrefix "git@" $src) (hasPrefix "ssh://" $src) -}}
{{- $src -}}
{{- else if regexMatch "^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(/|$)" $src -}}
{{- printf "https://%s" $src -}}
{{- else -}}
{{- fail (printf "spec.source %q does not look like a git URL. Pod compute requires a git-clonable source (https://, git@, ssh://, or a bare \"host.tld/path\")." $src) -}}
{{- end -}}
{{- end -}}

{{/*
eve.shaGuard - spec.sha must be a full 40-hex commit: the boot script
checks out exactly this and stamps it, so a short or empty sha can never
converge.
*/}}
{{- define "eve.shaGuard" -}}
{{- $sha := .Values.spec.sha | default "" | toString -}}
{{- if not (regexMatch "^[0-9a-f]{40}$" $sha) -}}
{{- fail (printf "spec.sha %q must be a full 40-character lowercase commit sha" $sha) -}}
{{- end -}}
{{- end -}}

{{/*
eve.subdirGuard - spec.sourceSubdir must be a normalized relative path: no
leading slash, no empty, "." or ".." component, no trailing slash. The
record schema already says so, but this chart ships no strict
values.schema.json (cluster-values lands under it), so the trust boundary
is re-checked here before the value becomes PROJECT_DIR and workingDir.
*/}}
{{- define "eve.subdirGuard" -}}
{{- $subdir := .Values.spec.sourceSubdir | default "" | toString -}}
{{- if ne $subdir "" -}}
{{- if or (hasPrefix "/" $subdir) (hasSuffix "/" $subdir) (contains "\\" $subdir) -}}
{{- fail (printf "spec.sourceSubdir %q must be a relative path with no leading or trailing slash" $subdir) -}}
{{- end -}}
{{- range $part := splitList "/" $subdir -}}
{{- if or (eq $part "") (eq $part ".") (eq $part "..") -}}
{{- fail (printf "spec.sourceSubdir %q contains an empty, '.' or '..' path component" $subdir) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
eve.recordChecksum - sha256 of the record spec; a pod annotation so a
record change (new sha, envRequires, ...) rolls the pod even when no chart
template byte changed.
*/}}
{{- define "eve.recordChecksum" -}}
{{- .Values.spec | toJson | sha256sum -}}
{{- end -}}

{{/*
eve.backupGuard - COPY of hermes.backupGuard (ADR-150): declared intent
(spec.backup) with providers.backup unset/"none" fails the whole render
loudly - an instance that believes it is backed up when nothing archives
it is the one outcome this guard exists to prevent.
*/}}
{{- define "eve.backupGuard" -}}
{{- $backend := .Values.providers.backup | default "none" -}}
{{- if and .Values.spec.backup (eq $backend "none") -}}
{{- fail (printf "eve agent %q declares spec.backup but providers.backup is \"none\": the platform has no backup destination configured (set providers.backup=pvc in cluster-values)" (include "eve.name" .)) -}}
{{- else if and (ne $backend "pvc") (ne $backend "none") -}}
{{- fail (printf "providers.backup=%s: not a recognized backup provider (pvc, none)" $backend) -}}
{{- end -}}
{{- end -}}

{{/*
eve.appsGuard - COPY of hermes.appsGuard (ADR-150): the cross-config rules
for spec.apps[] that need cluster-values in hand - unique names, remote
repos versioned and allow-listed, local charts unversioned with the
platform repo coordinates set. See hermes-profile's helper for the why.
*/}}
{{- define "eve.appsGuard" -}}
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
eve.appName - "ag-eve-<name>-<app>", the child Application's metadata.name
(flat namespace in argocd; the instance prefix keeps two agents' same-named
apps apart). Same shape as hermes.appName so `hg` addresses both alike.
*/}}
{{- define "eve.appName" -}}
{{- printf "%s-%s" (include "eve.fullname" .root) .app -}}
{{- end -}}

{{/*
eve.workspaceEnvName - EVE_WORKSPACE_<NAME>: the repository name upper-
cased with every non-alphanumeric run collapsed to "_" (doc-sync -> DOC_SYNC).
The main container exports one per bound workspace repository, pointing at
its checkout under /app/workspaces/<name>.
*/}}
{{- define "eve.workspaceEnvName" -}}
{{- printf "EVE_WORKSPACE_%s" (regexReplaceAll "[^A-Z0-9]+" (upper .) "_") -}}
{{- end -}}

{{/*
eve.workspaceGuard - spec.workspace.repositories[] must have unique names,
DNS-label names (they become directory names and env suffixes), 40-hex
shas, and no two may map to the same EVE_WORKSPACE_ variable ("a-b" and
"a_b" both become A_B). Mirrors the bundle chart's posture: a malformed
binding fails the render, a clone that fails at runtime degrades.
*/}}
{{- define "eve.workspaceGuard" -}}
{{- $seen := dict -}}
{{- $envs := dict -}}
{{- with .Values.spec.workspace -}}
{{- range .repositories -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" (.name | toString)) -}}
{{- fail (printf "spec.workspace.repositories[].name %q must be a DNS-1123 label" (.name | toString)) -}}
{{- end -}}
{{- if hasKey $seen .name -}}
{{- fail (printf "spec.workspace.repositories: %q is bound twice" .name) -}}
{{- end -}}
{{- $_ := set $seen .name true -}}
{{- $env := include "eve.workspaceEnvName" .name -}}
{{- if hasKey $envs $env -}}
{{- fail (printf "spec.workspace.repositories %q and %q both map to %s" .name (get $envs $env) $env) -}}
{{- end -}}
{{- $_ := set $envs $env .name -}}
{{- if .tracking -}}
{{- /* A tracked binding (ADR 0197): a branch and an interval, never a sha.
     The branch becomes a shell word and a git refspec, so the contract's
     rules are re-checked here, at the trust boundary. */ -}}
{{- if .sha -}}
{{- fail (printf "spec.workspace.repositories[%s] tracks a branch and must not also carry a sha" .name) -}}
{{- end -}}
{{- $branch := .tracking.branch | default "" | toString -}}
{{- if or (not (regexMatch "^[A-Za-z0-9._/-]{1,200}$" $branch)) (hasPrefix "refs/" $branch) (eq $branch "HEAD") (regexMatch "^[-./]" $branch) (regexMatch "[/.]$" $branch) (contains ".." $branch) (contains "//" $branch) (regexMatch "/[.-]" $branch) (regexMatch "\\.lock(/|$)" $branch) (regexMatch "^[0-9a-f]{40}$" $branch) -}}
{{- fail (printf "spec.workspace.repositories[%s].tracking.branch %q is not a trackable branch name (letters, digits, . _ - /; no refs/ prefix, '..', '//', leading '-', '.' or '/', trailing '/' or '.', '.lock' component, HEAD or 40-hex commit)" .name $branch) -}}
{{- end -}}
{{- $interval := .tracking.refreshInterval | default "" | toString -}}
{{- if not (regexMatch "^(([5-9]|[1-9][0-9]+)m|[1-9][0-9]*h)$" $interval) -}}
{{- fail (printf "spec.workspace.repositories[%s].tracking.refreshInterval %q must be whole minutes (at least 5m) or hours, e.g. 30m" .name $interval) -}}
{{- end -}}
{{- else if not (regexMatch "^[0-9a-f]{40}$" (.sha | toString)) -}}
{{- fail (printf "spec.workspace.repositories[%s].sha %q must be a full 40-character lowercase commit sha" .name (.sha | toString)) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
eve.hasTrackedWorkspaces - non-empty when any spec.workspace.repositories[]
entry tracks a branch (ADR 0197): the workspace-sync container, its metrics
annotations, the NetworkPolicy port and the WorkspaceStale rule render only then.
*/}}
{{- define "eve.hasTrackedWorkspaces" -}}
{{- with .Values.spec.workspace -}}
{{- range .repositories -}}
{{- if .tracking -}}true{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
eve.refreshSeconds - a guarded refreshInterval ("30m", "1h") in seconds.
*/}}
{{- define "eve.refreshSeconds" -}}
{{- $v := . | toString -}}
{{- $n := regexReplaceAll "[mh]$" $v "" | atoi -}}
{{- if hasSuffix "h" $v -}}{{- mul $n 3600 -}}{{- else -}}{{- mul $n 60 -}}{{- end -}}
{{- end -}}

{{/*
eve.cloneURLOf - eve.gitCloneURL's rule applied to an arbitrary string
(workspace repository sources): explicit schemes as-is, a bare
"host.tld/path" gets https://, anything else fails.
*/}}
{{- define "eve.cloneURLOf" -}}
{{- $src := . | toString -}}
{{- if or (hasPrefix "http://" $src) (hasPrefix "https://" $src) (hasPrefix "git@" $src) (hasPrefix "ssh://" $src) -}}
{{- $src -}}
{{- else if regexMatch "^[A-Za-z0-9.-]+\\.[A-Za-z]{2,}(/|$)" $src -}}
{{- printf "https://%s" $src -}}
{{- else -}}
{{- fail (printf "workspace source %q does not look like a git URL (https://, git@, ssh://, or a bare \"host.tld/path\")" $src) -}}
{{- end -}}
{{- end -}}

{{/*
eve.workspaceBindings - the EVE_WORKSPACE_BINDINGS value boot.sh and
files/workspace-sync.sh read: one line per repository (source normalized by
eve.cloneURLOf). A pinned line is "name source sha access"; a tracked one
(ADR 0197) is "name source branch access tracked intervalSeconds". Takes the
repositories list.
*/}}
{{- define "eve.workspaceBindings" -}}
{{- $lines := list -}}
{{- range . -}}
{{- if .tracking -}}
{{- $lines = append $lines (printf "%s %s %s %s tracked %s" .name (include "eve.cloneURLOf" .source) (.tracking.branch | toString) (.access | default "read-write") (include "eve.refreshSeconds" .tracking.refreshInterval)) -}}
{{- else -}}
{{- $lines = append $lines (printf "%s %s %s %s" .name (include "eve.cloneURLOf" .source) (.sha | toString) (.access | default "read-write")) -}}
{{- end -}}
{{- end -}}
{{- join "\n" $lines -}}
{{- end -}}

{{/*
eve.runtimeImageRef - the image both containers run, record override first
(the same two lines statefulset.yaml computes inline).
*/}}
{{- define "eve.runtimeImageRef" -}}
{{- $tag := .Values.runtimeImage.tag -}}
{{- if and .Values.spec.deployment .Values.spec.deployment.runtimeImageTag -}}
{{- $tag = .Values.spec.deployment.runtimeImageTag -}}
{{- end -}}
{{- printf "%s:%s" .Values.runtimeImage.repository ($tag | toString) -}}
{{- end -}}

{{/*
eve.runtimeManifest - the agent runtime manifest (ADR-153), the descriptive
record of WHAT THIS POD GOT: engine, resolved source revision, every code
workspace with the path it is mounted at, the env names the record requires
and the connections bound to it. Rendered into a ConfigMap and mounted at
/hg/runtime-manifest.json; `hg agent inspect|render` computes the same
object offline from the same values, and `hg agent prove` EVE022 compares the
two. Keep this helper and cli/src/harness/manifest.ts in step - EVE022 is
what notices when they drift.

NAMES ONLY, never values: this is a ConfigMap in the agent's namespace.
Every list is sorted by name, for the same reason - the two producers must
not depend on the order their inputs happened to arrive in.
*/}}
{{- define "eve.runtimeManifest" -}}
{{- $wsByName := dict -}}
{{- with .Values.spec.workspace -}}
{{- range .repositories -}}
{{- /* A tracked workspace (ADR 0197) names its channel, never a commit, so
     this manifest - and the runtime digest the startup gate compares - is
     the same before and after an in-pod refresh. */ -}}
{{- $revision := .sha | default "" | toString -}}
{{- if .tracking -}}{{- $revision = printf "tracked:%s" (.tracking.branch | toString) -}}{{- end -}}
{{- $_ := set $wsByName .name (dict
      "name" .name
      "path" (printf "/app/workspaces/%s" .name)
      "access" (.access | default "read-write")
      "repository" (.source | default "")
      "revision" $revision) -}}
{{- end -}}
{{- end -}}
{{- $workspaces := list -}}
{{- range $n := (keys $wsByName | sortAlpha) -}}
{{- $workspaces = append $workspaces (get $wsByName $n) -}}
{{- end -}}
{{- $connByName := dict -}}
{{- range (.Values.spec.connections | default list) -}}
{{- $_ := set $connByName .name (dict "name" .name "provider" .provider) -}}
{{- end -}}
{{- $connections := list -}}
{{- range $n := (keys $connByName | sortAlpha) -}}
{{- $connections = append $connections (get $connByName $n) -}}
{{- end -}}
{{- $required := list -}}
{{- range (.Values.spec.envRequires | default list) -}}
{{/* An entry is a bare string (required + secret) or an object - the
     record schema's oneOf, and both shapes ship in real records. */}}
{{- if kindIs "string" . -}}
{{- $required = append $required . -}}
{{- else -}}
{{- $required = append $required .name -}}
{{- end -}}
{{- end -}}
{{- $apps := list -}}
{{- range (.Values.spec.apps | default list) -}}
{{- $apps = append $apps .name -}}
{{- end -}}
{{- $source := dict "repository" (.Values.spec.source | default "") "revision" (.Values.spec.sha | default "" | toString) -}}
{{- if .Values.spec.sourceSubdir -}}
{{- $_ := set $source "subdir" .Values.spec.sourceSubdir -}}
{{- end -}}
{{- $spec := dict
      "name" (.Values.spec.persona | default (include "eve.name" .))
      "engine" (.Values.spec.runtime | default "eve")
      "instance" (include "eve.fullname" .)
      "namespace" .Release.Namespace
      "runtimeImage" (include "eve.runtimeImageRef" .)
      "source" $source
      "workspaces" $workspaces
      "requiredSecrets" (sortAlpha $required | uniq)
      "connections" $connections
      "apps" (sortAlpha $apps | uniq) -}}
{{- dict "contract" "agent-runtime/v1alpha1" "spec" $spec | toJson -}}
{{- end -}}

{{/*
eve.overlayGuard - operator overlays (ADR 0194) re-checked at the trust boundary
before they become build-container environment. The record schema says more;
this chart ships no values.schema.json, so the invariants the line format and
the build rely on are enforced here: overlays and overlayTreeHash come
together, ids are unique DNS labels, kinds and modes are known, every value is
one token (boot.sh splits on whitespace), removals carry no source, and every
other overlay carries a 40-hex commit and a SHA-256 content hash.
*/}}
{{/*
The rebuild key files/boot.sh computes: spec.sha alone, or sha256 of the sha and
the overlay digest when operator overlays exist (ADR 0194). The chart has to
agree with the script for the startup gate to mean anything.
*/}}
{{- define "eve.buildKey" -}}
{{- $overlays := .Values.spec.overlays | default list -}}
{{- if $overlays -}}
{{- printf "%s\n%s" (.Values.spec.sha | toString) (include "eve.overlayDigest" .) | sha256sum -}}
{{- else -}}
{{- .Values.spec.sha | toString -}}
{{- end -}}
{{- end -}}

{{/*
Desired versions as workload metadata (ADR 0195). Labels carry what is safe to
select and query on; annotations carry the long digests. Neither ever reaches a
selector - a selector change would orphan the StatefulSet.
*/}}
{{- define "eve.versionLabels" -}}
harness-hg.factorylevel.dev/source-sha: {{ .Values.spec.sha | toString | trunc 63 | quote }}
harness-hg.factorylevel.dev/eve-version: {{ include "eve.expectedEveVersion" . | trunc 63 | quote }}
{{- end -}}

{{- define "eve.expectedEveVersion" -}}
{{- $deployment := .Values.spec.deployment | default dict -}}
{{- .Values.runtimeImage.eveVersion | default $deployment.runtimeImageTag | default .Values.runtimeImage.tag | toString -}}
{{- end -}}

{{- define "eve.versionAnnotations" -}}
harness-hg.factorylevel.dev/build-key: {{ include "eve.buildKey" . | quote }}
harness-hg.factorylevel.dev/runtime-digest: {{ include "eve.runtimeManifest" . | sha256sum | quote }}
{{- if .Values.spec.overlays }}
harness-hg.factorylevel.dev/overlay-digest: {{ include "eve.overlayDigest" . | quote }}
{{- end }}
{{- end -}}

{{- define "eve.overlayGuard" -}}
{{- $overlays := .Values.spec.overlays | default list -}}
{{- $tree := .Values.spec.overlayTreeHash | default "" | toString -}}
{{- if and $overlays (not (regexMatch "^[a-f0-9]{64}$" $tree)) -}}
{{- fail "spec.overlays needs spec.overlayTreeHash (a SHA-256): the build container verifies the merged agent/ tree against it" -}}
{{- end -}}
{{- if and (not $overlays) (ne $tree "") -}}
{{- fail "spec.overlayTreeHash is set without spec.overlays" -}}
{{- end -}}
{{- $seen := dict -}}
{{- range $overlays -}}
{{- $id := .id | default "" | toString -}}
{{- if not (regexMatch "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$" $id) -}}{{- fail (printf "spec.overlays[].id %q must be a DNS-1123 label" $id) -}}{{- end -}}
{{- if hasKey $seen $id -}}{{- fail (printf "spec.overlays: %q appears twice" $id) -}}{{- end -}}
{{- $_ := set $seen $id true -}}
{{- if not (has (.kind | default "" | toString) (list "skill" "tool" "connection" "instructions" "file")) -}}{{- fail (printf "spec.overlays[%s].kind %q is not an overlay kind" $id (.kind | default "" | toString)) -}}{{- end -}}
{{- $mode := .mode | default "" | toString -}}
{{- if not (has $mode (list "append" "override" "remove")) -}}{{- fail (printf "spec.overlays[%s].mode %q is not an overlay mode" $id $mode) -}}{{- end -}}
{{- if not (regexMatch "^agent/[^\\s]+$" (.target | default "" | toString)) -}}{{- fail (printf "spec.overlays[%s].target must be one path under agent/" $id) -}}{{- end -}}
{{- if eq $mode "remove" -}}
{{- if or .source .contentHash .gitAuthSecretRef -}}{{- fail (printf "spec.overlays[%s]: a removal carries no source" $id) -}}{{- end -}}
{{- else -}}
{{- $src := .source | default dict -}}
{{- if not (regexMatch "^[0-9a-f]{40}$" ($src.commit | default "" | toString)) -}}{{- fail (printf "spec.overlays[%s].source.commit must be a full 40-hex commit" $id) -}}{{- end -}}
{{- if not (regexMatch "^[a-f0-9]{64}$" (.contentHash | default "" | toString)) -}}{{- fail (printf "spec.overlays[%s].contentHash must be a SHA-256" $id) -}}{{- end -}}
{{- if not (regexMatch "^(https://[^/@\\s?#]+/[^\\s?#@]+|git@[^:\\s]+:[^\\s]+)$" ($src.repository | default "" | toString)) -}}{{- fail (printf "spec.overlays[%s].source.repository must be a credential-free https:// or git@ URL" $id) -}}{{- end -}}
{{- if not (regexMatch "^[^\\s]+$" ($src.path | default "" | toString)) -}}{{- fail (printf "spec.overlays[%s].source.path must be one token" $id) -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
eve.overlayLines - the EVE_OVERLAYS value: one "id kind mode target repository
commit path contentHash" line per overlay, "-" for the source fields a removal
does not carry. files/overlay-apply.mjs overlayLines() renders the same bytes.
Takes the overlays list.
*/}}
{{- define "eve.overlayLines" -}}
{{- $lines := list -}}
{{- range . -}}
{{- $src := .source | default dict -}}
{{- $lines = append $lines (printf "%s %s %s %s %s %s %s %s" (.id | toString) (.kind | toString) (.mode | toString) (.target | toString) ($src.repository | default "-" | toString) ($src.commit | default "-" | toString) ($src.path | default "-" | toString) (.contentHash | default "-" | toString)) -}}
{{- end -}}
{{- join "\n" $lines -}}
{{- end -}}

{{/*
eve.overlayDigest - sha256 of the overlay lines, a newline and the merged tree
hash: the pod annotation and the build container's rebuild-key suffix.
files/overlay-apply.mjs overlayDigest() computes the same value.
*/}}
{{- define "eve.overlayDigest" -}}
{{- printf "%s\n%s" (include "eve.overlayLines" (.Values.spec.overlays | default list)) (.Values.spec.overlayTreeHash | default "" | toString) | sha256sum -}}
{{- end -}}
