#!/usr/bin/env bash
# Validates infra/gitops-template/:
#   1. bootstrap/values/cluster-values.yaml against
#      schemas/cluster-values/v1alpha1/cluster-values.schema.json (same
#      validator machinery as infra/scripts/validate-schemas.sh).
#   2. Bootstrap manifests and every ApplicationSet: substitute every
#      __DOUBLE_UNDERSCORE__ scaffold token with a dummy value, then confirm
#      the result still parses as YAML (proves the scaffold substitution step
#      cannot corrupt a file while Argo CD Go-template `{{ }}` syntax remains
#      untouched).
#   3. Best-effort: if kubeconform is available (or can be installed to
#      ~/.local/bin without sudo), schema-validate the substituted manifests
#      against Kubernetes and Argo CD CRD schemas.
#
# Usage: infra/scripts/validate-gitops-template.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

TEMPLATE_DIR="$REPO_ROOT/infra/gitops-template"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

FAIL_COUNT=0

echo "== 1. cluster-values.yaml against schemas/cluster-values/v1alpha1 =="
CLUSTER_VALUES="$TEMPLATE_DIR/bootstrap/values/cluster-values.yaml"
SCHEMA="$REPO_ROOT/agent-bundle-contracts/cluster-values/v1alpha1/cluster-values.schema.json"
if uv run --with check-jsonschema check-jsonschema --version >/dev/null 2>&1; then
  if uv run --with check-jsonschema check-jsonschema --schemafile "$SCHEMA" "$CLUSTER_VALUES"; then
    echo "OK   $CLUSTER_VALUES"
  else
    echo "FAIL $CLUSTER_VALUES"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  if uv run --with pyyaml --with jsonschema "$REPO_ROOT/infra/scripts/validate_with_jsonschema.py" "$SCHEMA" "$CLUSTER_VALUES"; then
    echo "OK   $CLUSTER_VALUES"
  else
    echo "FAIL $CLUSTER_VALUES"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

echo
echo "== 2. token substitution + YAML sanity =="

substitute_and_parse() {
  local src="$1" out="$2"
  sed \
    -e 's/__GITOPS_REPO_URL__/https:\/\/git.example.com\/dummy\/gitops.git/g' \
    -e 's/__GITOPS_BRANCH__/main/g' \
    -e 's/__HERMES_GITOPS_REPO_URL__/https:\/\/git.example.com\/dummy\/harness-hg.git/g' \
    -e 's/__CHART_REVISION__/main/g' \
    -e 's/__IMAGE_REPOSITORY__/ghcr.io\/dummy\/hermes-agent/g' \
    -e 's/__IMAGE_TAG__/latest/g' \
    -e 's/^__OPERATOR_SOURCE_REPOS__$/    - oci:\/\/registry.example\/charts/' \
    "$src" > "$out"

  local known_tokens=(
    __GITOPS_REPO_URL__ __GITOPS_BRANCH__ __HERMES_GITOPS_REPO_URL__
    __CHART_REVISION__ __IMAGE_REPOSITORY__ __IMAGE_TAG__ __OPERATOR_SOURCE_REPOS__
  )
  local tok
  for tok in "${known_tokens[@]}"; do
    if grep -qF "$tok" "$out"; then
      echo "FAIL $src: unsubstituted token $tok remains:"
      grep -nF "$tok" "$out" | sed 's/^/       /'
      return 1
    fi
  done

  uv run --with pyyaml python3 -c "
import yaml
with open('$out') as f:
    docs = list(yaml.safe_load_all(f))
assert docs, 'no YAML documents parsed'
for doc in docs:
    assert isinstance(doc, dict), f'expected a mapping, got {type(doc)}'
print(f'  parsed {len(docs)} document(s) OK')
"
}

# EVERY bootstrap manifest, discovered rather than listed. The hand-kept
# list this replaced was its own drift hazard: a manifest added to the
# template but not to the list was never token-substituted or parsed here,
# and would fail for the first environment that scaffolded it (#173).
while IFS= read -r src; do
  f="${src#"$TEMPLATE_DIR"/bootstrap/}"
  out="$WORKDIR/$(basename "$f")"
  echo "-- $f --"
  if substitute_and_parse "$src" "$out"; then
    echo "OK   $f (substituted + parsed)"
  else
    echo "FAIL $f"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done < <(find "$TEMPLATE_DIR/bootstrap" -name '*.yaml' ! -path '*/values/*' | sort)

echo
echo "== 3. kubeconform (best-effort) =="

LOCAL_BIN="${HOME}/.local/bin"
KUBECONFORM_VERSION="v0.8.0"
KUBECONFORM_BIN=""

if command -v kubeconform >/dev/null 2>&1; then
  KUBECONFORM_BIN="kubeconform"
elif [[ -x "$LOCAL_BIN/kubeconform" ]]; then
  KUBECONFORM_BIN="$LOCAL_BIN/kubeconform"
else
  echo "kubeconform not found; attempting install to $LOCAL_BIN (no sudo)..."
  mkdir -p "$LOCAL_BIN"
  TARBALL="$WORKDIR/kubeconform.tar.gz"
  URL="https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz"
  if curl -fsSL --max-time 20 -o "$TARBALL" "$URL" 2>/dev/null \
      && tar -xzf "$TARBALL" -C "$LOCAL_BIN" kubeconform 2>/dev/null; then
    chmod +x "$LOCAL_BIN/kubeconform"
    KUBECONFORM_BIN="$LOCAL_BIN/kubeconform"
    echo "installed kubeconform $KUBECONFORM_VERSION"
  else
    echo "SKIPPED: kubeconform unavailable (no network or download failed)."
  fi
fi

if [[ -n "$KUBECONFORM_BIN" ]]; then
  if "$KUBECONFORM_BIN" -strict -summary \
      -schema-location default \
      -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
      "$WORKDIR/project.yaml" "$WORKDIR/applicationset.yaml" \
      "$WORKDIR/monitoring-stack.yaml" \
      "$WORKDIR/fleet-dashboard.yaml" \
      "$WORKDIR/control-plane-observability.yaml" \
      "$WORKDIR/agents.yaml" "$WORKDIR/apps.yaml" "$WORKDIR/endpoints.yaml" \
      "$WORKDIR/bundles.yaml"; then
    echo "OK   kubeconform"
  else
    echo "FAIL kubeconform"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

echo
echo "== 4. ADR-19 ownership: the manifest agrees with the template =="

# The scaffold reconciler (ADR-37) manages a NAMED set of files
# (`scaffold.py` `_MANAGED_FILES`), hash-gated: it adds one new in a
# release, updates one it wrote, refuses one an operator edited. That list
# and the template are two descriptions of the same thing, and #173 is
# about them not being allowed to disagree.
#
# Two directions, both checked:
#   * a managed path missing from the template  -> the reconciler would
#     try to render a file that does not exist
#   * an operator tree missing its Application  -> `platform/` would exist
#     in the scaffold and never reach a cluster

MANAGED=$(python3 - <<'PYEOF'
import re, pathlib
src = pathlib.Path("plugin/gitops_emitter/scaffold.py").read_text(encoding="utf-8")
block = re.search(r"_MANAGED_FILES = \((.*?)\n\)", src, re.S).group(1)
for rel in re.findall(r'"([^"]+)"', block):
    print(rel)
PYEOF
)

for rel in $MANAGED; do
  if [ -f "$TEMPLATE_DIR/$rel" ]; then
    echo "OK   managed $rel exists in the template"
  else
    echo "FAIL scaffold.py manages $rel but the template does not ship it - the reconciler would render a file that does not exist"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
done

# The operator tree, and the Application that syncs it (ADR-19).
if [ -f "$TEMPLATE_DIR/platform/README.md" ]; then
  echo "OK   platform/ ships with a README stating no tool touches it"
else
  echo "FAIL infra/gitops-template/platform/README.md is missing - ADR-19's operator tree must be scaffolded, not assumed"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

PLATFORM_APP="$TEMPLATE_DIR/bootstrap/platform-extras.yaml"
if [ -f "$PLATFORM_APP" ]; then
  # `project: hermes-gitops`, never `default`. Every OTHER bootstrap
  # Application uses `default` to avoid a deadlock with the AppProject
  # created by that same sync - an operator tree must not inherit that
  # exemption, or it becomes the one way to bypass the sourceRepos
  # allowlist entirely.
  if grep -qE '^\s*project:\s*hermes-gitops\s*$' "$PLATFORM_APP"; then
    echo "OK   platform-extras runs under the hermes-gitops AppProject, not default"
  else
    echo "FAIL $PLATFORM_APP must use 'project: hermes-gitops' - 'default' permits any repo and any destination, which makes platform/ a bypass of the allowlist"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  if grep -qE '^\s*path:\s*platform\s*$' "$PLATFORM_APP"; then
    echo "OK   platform-extras syncs the platform/ tree"
  else
    echo "FAIL $PLATFORM_APP no longer points at source.path: platform"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "FAIL bootstrap/platform-extras.yaml is missing - platform/ would exist in the scaffold and never reach a cluster"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# The emitter's structural half: it must refuse to write outside its own
# trees. A convention that lives only in a comment is what #173 replaces.
if grep -q "_assert_within" plugin/gitops_emitter/gitrepo.py; then
  echo "OK   the emitter enforces a write allowlist (gitrepo._assert_within)"
else
  echo "FAIL gitrepo.py no longer confines writes to the generated trees - nothing structurally keeps generated content out of an operator tree"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

echo
echo "== Summary: $FAIL_COUNT failure(s) =="
exit $((FAIL_COUNT > 0 ? 1 : 0))
