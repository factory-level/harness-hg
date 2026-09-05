{{/*
Git credentials for the clone initContainer and the repo-sync sidecar.

The local loop clones an unauthenticated git:// URL from the host daemon,
so this renders to nothing. A real deployment reads a PRIVATE GitOps repo
over https and needs credentials in both containers -- they run the same
`git` against the same working copy, so a helper only the initContainer
had would clone once and then fail every pull.

The token is passed through a credential helper reading environment
variables, never interpolated into the URL: a URL-embedded token lands in
`git remote -v`, in the .git/config on the repo volume, and in any error
message that echoes the remote. Values never carry the secret either --
`gitopsAuth.secretName` names a Secret, and the platform provisions it
(ADR-53), exactly as the event router's signing secrets work.
*/}}
Callers guard on gitopsAuth.secretName themselves, so an anonymous clone
renders no line at all rather than one of trailing spaces.
*/}}
{{- define "nexus.gitCredentialHelper" -}}
git config --global credential.helper '!f() { echo "username=${GIT_USERNAME}"; echo "password=${GIT_TOKEN}"; }; f'
{{- end -}}
