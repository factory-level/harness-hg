#!/usr/bin/env bash
# Per-agent backend selection for the infra/ stacks (spec §23): each
# agent's stack lives in ITS OWN bucket (created by state/) and deploys
# under ITS OWN service account, so operating a stack starts with a
# mechanical login-per-agent step - this wrapper is that step.
#
#   source infra/scripts/agent-backend.sh <agent> [project-id]
#
# SOURCE it (don't execute): it exports
# PULUMI_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT into your shell, logs Pulumi
# into gs://<project>-<agent>-state, and selects (or initializes) the
# agent's stack. Project defaults to the active gcloud project. Stack
# init uses the shared root key as the secrets provider; pass
# HG_SECRETS_PROVIDER to point at a per-agent key instead (the state/
# stack's `agentSecretsProviders` output has the exact value).
#
# Prereqs: `gcloud auth application-default login` as a member of the
# deployer group (impersonation happens via serviceAccountTokenCreator -
# no SA key files, ever).

_hg_agent="${1:-}"
if [[ -z "$_hg_agent" ]]; then
  echo "usage: source infra/scripts/agent-backend.sh <agent> [project-id]" >&2
  return 1 2>/dev/null || exit 1
fi
_hg_project="${2:-$(gcloud config get-value project 2>/dev/null)}"
if [[ -z "$_hg_project" ]]; then
  echo "agent-backend: no project-id given and no active gcloud project" >&2
  return 1 2>/dev/null || exit 1
fi

_hg_bucket="gs://${_hg_project}-${_hg_agent}-state"
_hg_sa="${_hg_agent}-deployer@${_hg_project}.iam.gserviceaccount.com"
_hg_secrets="${HG_SECRETS_PROVIDER:-gcpkms://projects/${_hg_project}/locations/us/keyRings/pulumi/cryptoKeys/pulumi-root}"

echo "agent-backend: ${_hg_agent} -> ${_hg_bucket} (as ${_hg_sa})" >&2
pulumi login "$_hg_bucket" || { return 1 2>/dev/null || exit 1; }
export PULUMI_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT="$_hg_sa"
pulumi stack select "$_hg_agent" 2>/dev/null || \
  pulumi stack init "$_hg_agent" --secrets-provider "$_hg_secrets"
