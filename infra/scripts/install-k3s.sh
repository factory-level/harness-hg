#!/usr/bin/env bash
# Host k3s installer - run by the OPERATOR on the machine that will host the
# cluster, NOT by CI/dev tooling (infra/scripts/dev-cluster.sh is the k3d-based
# throwaway alternative used for local dev and verification; see this repo's
# root README.md for when to use which).
#
# Requires sudo (the k3s install script installs a systemd service and
# writes to /etc, /usr/local/bin, /var/lib/rancher). This script does NOT
# elevate itself - run it as a user with sudo access, or as root.
#
# Usage: infra/scripts/install-k3s.sh
#
# Idempotent: re-running this script against an already-installed k3s just
# re-applies the same install (get.k3s.io's installer detects an existing
# install and upgrades/no-ops in place; it does not create a second
# instance or duplicate the systemd unit).

set -euo pipefail

if [[ "${EUID}" -ne 0 ]] && ! sudo -n true 2>/dev/null; then
  echo "This script installs a systemd service and needs root privileges." >&2
  echo "Run it as root, or as a user with passwordless (or interactive) sudo." >&2
fi

echo "== Installing k3s (single-node, kubeconfig mode 0644) ==" >&2

curl -sfL https://get.k3s.io | sh -s - \
  --write-kubeconfig-mode 644

echo >&2
echo "== k3s install finished ==" >&2
echo >&2
echo "Kubeconfig was written to /etc/rancher/k3s/k3s.yaml (world-readable," >&2
echo "per --write-kubeconfig-mode 644 above). To use it as a normal user:" >&2
echo >&2
echo "    mkdir -p ~/.kube" >&2
echo "    sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config" >&2
echo "    sudo chown \$(id -u):\$(id -g) ~/.kube/config" >&2
echo >&2
echo "  ...or point KUBECONFIG at it directly without copying:" >&2
echo >&2
echo "    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml" >&2
echo >&2
echo "Then point infra/Pulumi.<stack>.yaml's kubeconfigPath at whichever" >&2
echo "of those you used (see infra/Pulumi.local.yaml.example)." >&2
echo >&2
echo "To uninstall: run /usr/local/bin/k3s-uninstall.sh (installed alongside" >&2
echo "k3s itself) - this stops the service and removes all k3s state." >&2
