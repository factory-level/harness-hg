#!/usr/bin/env bash
# Destination-server preflight fact collector (design 18, run by
# `hg server preflight` over ssh as `bash -s`). Emits KEY=VALUE lines on
# stdout and NOTHING else; the CLI evaluates them into SRV00x findings.
# Read-only: this script must not modify the server.
set -u
SYNC_ROOT="${SYNC_ROOT:-/mnt/ssd/hermes-gitops}"

emit() { printf '%s=%s\n' "$1" "$2"; }

. /etc/os-release 2>/dev/null || true
emit os_id "${ID:-unknown}"
emit os_version "${VERSION_ID:-unknown}"
emit arch "$(uname -m)"
emit nproc "$(nproc 2>/dev/null || echo 0)"
emit mem_kb "$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"

root_dev="$(df --output=source / 2>/dev/null | tail -1)"
emit root_dev "${root_dev:-unknown}"
if [ -d "$(dirname "$SYNC_ROOT")" ]; then
  sync_dev="$(df --output=source "$(dirname "$SYNC_ROOT")" 2>/dev/null | tail -1)"
  sync_avail="$(df --output=avail -k "$(dirname "$SYNC_ROOT")" 2>/dev/null | tail -1 | tr -d ' ')"
  emit sync_parent_exists yes
  emit sync_dev "${sync_dev:-unknown}"
  emit sync_avail_kb "${sync_avail:-0}"
else
  emit sync_parent_exists no
  emit sync_dev unknown
  emit sync_avail_kb 0
fi

emit dns_ok "$(getent hosts github.com >/dev/null 2>&1 && echo yes || echo no)"
for pair in "reach_github https://github.com" \
            "reach_gcs https://storage.googleapis.com" \
            "reach_slack https://slack.com/api/api.test"; do
  key="${pair%% *}"; url="${pair#* }"
  code="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null || echo 000)"
  emit "$key" "$code"
done

emit ntp_synced "$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"

if command -v ss >/dev/null 2>&1 && ss -tln 2>/dev/null | awk '{print $4}' | grep -q ':6443$'; then
  emit port_6443 busy
else
  emit port_6443 free
fi

for tool in k3s kubeadm minikube; do
  if command -v "$tool" >/dev/null 2>&1; then
    emit "present_$tool" yes
  else
    emit "present_$tool" no
  fi
done
emit k3s_version "$(k3s --version 2>/dev/null | head -1 | awk '{print $3}' || true)"

emit sudo_nopasswd "$(sudo -n true 2>/dev/null && echo yes || echo no)"
emit home_dir "$HOME"
