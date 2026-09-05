#!/usr/bin/env bash
# Pinned, checksummed installs of the unprivileged host tools (design 18:
# "installed from pinned, repository-owned automation"). Run by
# `hg server bootstrap` over ssh as `bash -s` with the pins in env:
#   KUBECTL_VERSION/KUBECTL_SHA256, HELM_VERSION/HELM_SHA256,
#   BUN_VERSION/BUN_SHA256  (from versions.json - never hardcode here)
# Everything lands in ~/.local/bin; k3s (the one root step) is NOT here -
# the CLI drives the vendored installer separately.
set -euo pipefail

BIN="$HOME/.local/bin"
mkdir -p "$BIN"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

need() { # name current-version pinned-version -> 0 when install needed
  [ "$2" != "$3" ]
}

say() { echo "server-bootstrap: $*" >&2; }

check() { # file sha256
  echo "$2  $1" | sha256sum -c --quiet -
}

# kubectl ------------------------------------------------------------------
cur="$("$BIN/kubectl" version --client 2>/dev/null | sed -n 's/^Client Version: //p' || true)"
if need kubectl "$cur" "$KUBECTL_VERSION"; then
  say "installing kubectl $KUBECTL_VERSION"
  curl -fsSL "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl" -o "$work/kubectl"
  check "$work/kubectl" "$KUBECTL_SHA256"
  install -m 0755 "$work/kubectl" "$BIN/kubectl"
else
  say "kubectl $KUBECTL_VERSION already installed"
fi

# helm ---------------------------------------------------------------------
cur="$("$BIN/helm" version --template '{{.Version}}' 2>/dev/null || true)"
if need helm "$cur" "$HELM_VERSION"; then
  say "installing helm $HELM_VERSION"
  curl -fsSL "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz" -o "$work/helm.tgz"
  check "$work/helm.tgz" "$HELM_SHA256"
  tar -xzf "$work/helm.tgz" -C "$work" linux-amd64/helm
  install -m 0755 "$work/linux-amd64/helm" "$BIN/helm"
else
  say "helm $HELM_VERSION already installed"
fi

# bun ----------------------------------------------------------------------
# The standard build requires AVX2; a pre-Haswell Xeon core-dumps with
# "Illegal instruction" (found on an older Xeon (E5-2697 v2)). Bun ships
# a baseline build for exactly this - pick by /proc/cpuinfo, verify by
# the matching pin.
if grep -qw avx2 /proc/cpuinfo; then
  BUN_ARTIFACT=bun-linux-x64; BUN_PIN="$BUN_SHA256"
else
  BUN_ARTIFACT=bun-linux-x64-baseline; BUN_PIN="$BUN_BASELINE_SHA256"
fi
cur="$("$BIN/bun" --version 2>/dev/null || true)"
if need bun "$cur" "$BUN_VERSION"; then
  say "installing bun $BUN_VERSION ($BUN_ARTIFACT)"
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/$BUN_ARTIFACT.zip" -o "$work/bun.zip"
  check "$work/bun.zip" "$BUN_PIN"
  # python3 stdlib instead of unzip - the server has python3, not unzip.
  python3 -m zipfile -e "$work/bun.zip" "$work/bun"
  install -m 0755 "$work/bun/$BUN_ARTIFACT/bun" "$BIN/bun"
else
  say "bun $BUN_VERSION already installed"
fi

# uv ----------------------------------------------------------------------
# Stage 1 of the bootstrap program runs `uv tool install` on this host.
cur="$("$BIN/uv" --version 2>/dev/null | awk '{print $2}' || true)"
if need uv "$cur" "$UV_VERSION"; then
  say "installing uv $UV_VERSION"
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-x86_64-unknown-linux-gnu.tar.gz" -o "$work/uv.tgz"
  check "$work/uv.tgz" "$UV_SHA256"
  tar -xzf "$work/uv.tgz" -C "$work"
  install -m 0755 "$work/uv-x86_64-unknown-linux-gnu/uv" "$BIN/uv"
else
  say "uv $UV_VERSION already installed"
fi

# pulumi ------------------------------------------------------------------
# The reconciler's apply is `pulumi up` on this host.
cur="$("$BIN/pulumi" version 2>/dev/null || true)"
if need pulumi "$cur" "$PULUMI_VERSION"; then
  say "installing pulumi $PULUMI_VERSION"
  curl -fsSL "https://github.com/pulumi/pulumi/releases/download/$PULUMI_VERSION/pulumi-$PULUMI_VERSION-linux-x64.tar.gz" -o "$work/pulumi.tgz"
  echo "$PULUMI_SHA512  $work/pulumi.tgz" | sha512sum -c --quiet -
  tar -xzf "$work/pulumi.tgz" -C "$work"
  install -m 0755 "$work"/pulumi/pulumi* "$BIN/"
else
  say "pulumi $PULUMI_VERSION already installed"
fi

# gcloud ------------------------------------------------------------------
# The backup sink verbs drive `gcloud storage`; the SDK unpacks beside
# the home and symlinks into $BIN (a tarball, not curl|bash).
cur="$("$BIN/gcloud" version 2>/dev/null | sed -n 's/^Google Cloud SDK //p' || true)"
if need gcloud "$cur" "$GCLOUD_VERSION"; then
  say "installing google-cloud-cli $GCLOUD_VERSION"
  curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-$GCLOUD_VERSION-linux-x86_64.tar.gz" -o "$work/gcloud.tgz"
  check "$work/gcloud.tgz" "$GCLOUD_SHA256"
  rm -rf "$HOME/google-cloud-sdk"
  tar -xzf "$work/gcloud.tgz" -C "$HOME"
  ln -sf "$HOME/google-cloud-sdk/bin/gcloud" "$BIN/gcloud"
  ln -sf "$HOME/google-cloud-sdk/bin/gsutil" "$BIN/gsutil"
else
  say "gcloud $GCLOUD_VERSION already installed"
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) say "NOTE: $BIN is not on PATH for non-login shells - systemd user units get it from the unit Environment" ;;
esac
say "pinned tools ready in $BIN"
