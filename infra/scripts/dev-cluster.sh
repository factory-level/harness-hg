#!/usr/bin/env bash
# k3d-based throwaway cluster for local development and CI/dev verification
# of the bootstrap Pulumi program - the counterpart to infra/scripts/install-k3s.sh
# (which is the real, host-level, sudo-requiring production path). Use this
# script when you want a disposable cluster in a couple of seconds and don't
# care about it surviving a reboot; use install-k3s.sh when you're standing
# up an actual host.
#
# Installs k3d (and kubectl, if missing) to ~/.local/bin - no sudo required
# for either. Requires: docker (k3d runs k3s-in-docker).
#
# Usage:
#   infra/scripts/dev-cluster.sh up          # create (or reuse) the cluster, merge kubeconfig
#   infra/scripts/dev-cluster.sh down        # delete the cluster
#   infra/scripts/dev-cluster.sh status      # show whether the cluster exists
#   infra/scripts/dev-cluster.sh kubeconfig  # print the cluster's kubeconfig to stdout
#
# `kubeconfig` exists for non-interactive consumers — the infra program's
# k3s-local clusterProvider strategy (infra/src/components/cluster, issue
# #4 [A2]) runs `up` then captures `kubeconfig` as the k8s provider's
# input, keeping this script the single source of truth for the k3d
# incantation. Everything else this script logs goes to stderr, so stdout
# is exactly the kubeconfig document.

set -euo pipefail

CLUSTER_NAME="hermes-gitops-dev"
LOCAL_BIN="${HOME}/.local/bin"
K3D_VERSION="${K3D_VERSION:-v5.9.0}"
KUBECTL_VERSION="${KUBECTL_VERSION:-v1.36.2}"

mkdir -p "$LOCAL_BIN"
export PATH="$LOCAL_BIN:$PATH"

log() { echo "[dev-cluster] $*" >&2; }

ensure_k3d() {
  if command -v k3d >/dev/null 2>&1; then
    return
  fi
  log "k3d not found; installing ${K3D_VERSION} into ${LOCAL_BIN} (no sudo)"
  curl -fsSL https://raw.githubusercontent.com/k3d-io/k3d/main/install.sh \
    | TAG="${K3D_VERSION}" K3D_INSTALL_DIR="${LOCAL_BIN}" bash -s -- --no-sudo
}

ensure_kubectl() {
  if command -v kubectl >/dev/null 2>&1; then
    return
  fi
  log "kubectl not found; installing ${KUBECTL_VERSION} into ${LOCAL_BIN} (no sudo)"
  curl -fsSL -o "${LOCAL_BIN}/kubectl" \
    "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl"
  chmod +x "${LOCAL_BIN}/kubectl"
}

cluster_exists() {
  k3d cluster list --no-headers 2>/dev/null | awk '{print $1}' | grep -qx "${CLUSTER_NAME}"
}

cmd_up() {
  ensure_k3d
  ensure_kubectl
  if cluster_exists; then
    log "cluster '${CLUSTER_NAME}' already exists; reusing it"
  else
    log "creating cluster '${CLUSTER_NAME}'"
    k3d cluster create "${CLUSTER_NAME}" --wait
  fi
  k3d kubeconfig merge "${CLUSTER_NAME}" --kubeconfig-switch-context \
    --output "${KUBECONFIG:-${HOME}/.kube/config}"
  log "kubeconfig merged; context is 'k3d-${CLUSTER_NAME}'"
  log "verify with: kubectl --context k3d-${CLUSTER_NAME} get nodes"
}

cmd_down() {
  if ! command -v k3d >/dev/null 2>&1; then
    log "k3d not installed; nothing to delete"
    return
  fi
  if cluster_exists; then
    log "deleting cluster '${CLUSTER_NAME}'"
    k3d cluster delete "${CLUSTER_NAME}"
  else
    log "cluster '${CLUSTER_NAME}' does not exist; nothing to delete"
  fi
}

cmd_kubeconfig() {
  ensure_k3d
  if ! cluster_exists; then
    log "cluster '${CLUSTER_NAME}' does not exist; run '$0 up' first"
    exit 1
  fi
  # A standalone kubeconfig document for this cluster only (NOT the merged
  # ~/.kube/config): safe to hand to a k8s provider without inheriting
  # unrelated contexts.
  k3d kubeconfig get "${CLUSTER_NAME}"
}

cmd_status() {
  if ! command -v k3d >/dev/null 2>&1; then
    echo "k3d not installed"
    return
  fi
  if cluster_exists; then
    k3d cluster list "${CLUSTER_NAME}"
  else
    echo "cluster '${CLUSTER_NAME}' does not exist"
  fi
}

case "${1:-}" in
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  kubeconfig) cmd_kubeconfig ;;
  *)
    echo "usage: $0 {up|down|status|kubeconfig}" >&2
    exit 2
    ;;
esac
