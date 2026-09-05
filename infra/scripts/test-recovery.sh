#!/usr/bin/env bash
# The destructive recovery rehearsal — design 13's release gate, mocked
# locally against the hg loop's k3d cluster with a local directory
# standing in for the GCS sink:
#
#   seed markers (agent volume + Nexus host overlay)
#   → hg platform backup create        (fresh archives + manifest scaffold)
#   → hg reset --nuclear               (the WHOLE cluster: Argo CD, Grafana,
#     + wipe the Nexus overlay          Prometheus, router, agent, PVCs)
#   → hg up                            (control plane rebuilt from declared state)
#   → hg platform restore              (volumes + host overlay back; declaratives
#                                       verified Synced+Healthy)
#   → hg platform backup prove         (design-16 ProofResult; ADR-52
#                                       available→restorable transition)
#   → assert both markers byte-identical + smoke tier green
#
# Prereqs: an onboarded hg loop (`hg onboard <persona> && hg up`) with at
# least one profile whose chart ships a backup routine. Everything this
# script destroys, it rebuilds; the backup directory is left behind for
# inspection.
#
# Usage: infra/scripts/test-recovery.sh
# Env:   PROFILE  (default marketing-sre)  the guinea-pig profile
#        DR_DIR   (default mktemp -d)      where the backup scaffold lands

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HG=(bun "$REPO_ROOT/cli/src/main.ts")
PROFILE="${PROFILE:-marketing-sre}"
DR_DIR="${DR_DIR:-$(mktemp -d /tmp/hg-recovery.XXXXXX)}"
NS="hermes-${PROFILE}"
KCTL=(kubectl --context k3d-hermes-gitops-cli -n "$NS")
NEXUS_STATE="$HOME/.hermes/plugins/hermes-gitops/state"
NONCE="recovery-$(date +%s)"

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "== a. seed markers ($NONCE) =="
"${KCTL[@]}" exec "hermes-${PROFILE}-0" -c hermes-agent -- \
  sh -c "echo '$NONCE' > /opt/data/recovery-marker.txt" || fail "could not seed agent volume"
mkdir -p "$NEXUS_STATE"
echo "$NONCE" > "$NEXUS_STATE/recovery-marker.txt"
pass "markers seeded in agent volume and Nexus overlay"

echo "== b. platform backup =="
# --sink: the objects, not the scaffold, are what survives losing this
# host - so the rehearsal takes the cloud path (emulated locally, #297)
# and then DELETES the scaffold before restoring. Restoring from the
# directory the backup just wrote proves the archives are readable; it
# does not prove the server is disposable.
"${HG[@]}" platform backup create --to "$DR_DIR" --sink "${DR_SINK:-emulated}"
BACKUP_DIR="$(ls -1dt "$DR_DIR"/hg-* | head -1)"
BACKUP_ID="$(basename "$BACKUP_DIR")"
[ -f "$BACKUP_DIR/manifest.json" ] || fail "no manifest in $BACKUP_DIR"
grep -q '"state": "available"' "$BACKUP_DIR/manifest.json" || fail "manifest not 'available'"
pass "backup scaffolded at $BACKUP_DIR"

echo "== c. destroy EVERYTHING =="
"${HG[@]}" reset --nuclear
rm -rf "$NEXUS_STATE"
# The local scaffold goes too. This is the line that turns a restore
# rehearsal into a RECOVERY rehearsal: everything the restore uses from
# here has to come back out of the sink.
rm -rf "$DR_DIR"
pass "cluster deleted, Nexus overlay wiped, local backup scaffold deleted"

echo "== d. rebuild from declared state =="
"${HG[@]}" up
FRESH="$("${KCTL[@]}" exec "hermes-${PROFILE}-0" -c hermes-agent -- \
  sh -c 'cat /opt/data/recovery-marker.txt 2>/dev/null || echo ABSENT')"
[ "$FRESH" = "ABSENT" ] || fail "marker survived the destroy - the destroy is not honest"
pass "control plane rebuilt; fresh volume is empty, as a destroy must leave it"

echo "== e. fetch from the sink =="
# A clean server has a bucket and no directory. Selecting the backup id
# EXPLICITLY rather than "latest" is design 13's requirement - defaulting
# silently is how a recovery restores something nobody chose.
"${HG[@]}" platform fetch "$BACKUP_ID" --sink "${DR_SINK:-emulated}" --to "$DR_DIR"
[ -f "$BACKUP_DIR/manifest.json" ] || fail "manifest did not come back from the sink"
pass "backup $BACKUP_ID rehydrated from the sink"

echo "== f. restore =="
"${HG[@]}" platform restore --from "$BACKUP_DIR"
grep -q '"state": "restorable"' "$BACKUP_DIR/manifest.json" || fail "manifest never became 'restorable' (ADR-52)"
pass "restore complete; backup is now restorable"

echo "== g. prove =="
"${HG[@]}" platform backup prove --from "$BACKUP_DIR" --json > "$BACKUP_DIR/proof.json"
grep -q '"ok": true' "$BACKUP_DIR/proof.json" || fail "backup prove reported failures"
pass "ProofResult ok"

echo "== h. state retention =="
"${KCTL[@]}" wait --for=condition=Ready "pod/hermes-${PROFILE}-0" --timeout=300s >/dev/null
AGENT="$("${KCTL[@]}" exec "hermes-${PROFILE}-0" -c hermes-agent -- cat /opt/data/recovery-marker.txt)"
NEXUS="$(cat "$NEXUS_STATE/recovery-marker.txt")"
[ "$AGENT" = "$NONCE" ] || fail "agent volume lost its marker ($AGENT != $NONCE)"
[ "$NEXUS" = "$NONCE" ] || fail "Nexus overlay lost its marker ($NEXUS != $NONCE)"
"${HG[@]}" test --tier smoke --profile "$PROFILE"
pass "both markers byte-identical, smoke green"

echo "OK: destructive recovery rehearsal passed (backup left at $BACKUP_DIR)"
