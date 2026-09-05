.PHONY: schema-validate gitops-template-validate lint chart-test pytest wheel-smoke test drift-test verify-git-side docs docs-drift wiki-serve wiki-build

# Validates every agent-bundle-contracts/**/examples/* fixture against its schema; invalid-* fixtures
# must fail, everything else must pass. See infra/scripts/validate-schemas.sh for details.
schema-validate:
	bash infra/scripts/validate-schemas.sh

# Validates infra/gitops-template/bootstrap/values/cluster-values.yaml against the
# cluster-values schema, and infra/gitops-template/bootstrap/{project,applicationset}.yaml
# after dummy token substitution (YAML sanity + best-effort kubeconform).
# See infra/scripts/validate-gitops-template.sh for details.
gitops-template-validate:
	bash infra/scripts/validate-gitops-template.sh

# Placeholder: no linters wired up yet. Will grow to cover yamllint/helm lint etc.
# in later milestones.
lint:
	@echo "lint: no linters configured yet (placeholder)"

# harness/hermes/charts/hermes-profile: helm lint, golden `helm template` renders (byte-diffed
# against tests/chart/golden/), negative-render assertions, best-effort
# kubeconform. The shared-runtime hermes-bundle chart is also linted against its
# standalone defaults; its production values are generated under deployments/bundles/.
# See infra/scripts/render-test.sh for the full hermes-profile description. Run with
# `infra/scripts/render-test.sh --update` directly to regenerate the goldens after
# an intentional template change.
chart-test:
	bash infra/scripts/sync-nexus-chart.sh --check
	bash infra/scripts/render-test.sh
	@HELM_BIN="$$(command -v helm 2>/dev/null || true)"; \
	if [ -x "$$HOME/.local/bin/helm" ]; then HELM_BIN="$$HOME/.local/bin/helm"; fi; \
	if [ -z "$$HELM_BIN" ]; then echo "helm unavailable after render-test" >&2; exit 1; fi; \
	"$$HELM_BIN" lint harness/hermes/charts/hermes-bundle; \
	"$$HELM_BIN" lint harness/eve/charts/eve-agent; \
	"$$HELM_BIN" lint harness/eve/charts/eve-bundle; \
	"$$HELM_BIN" lint control-plane/nexus/chart; \
	"$$HELM_BIN" lint control-plane/loki/chart; \
	"$$HELM_BIN" lint control-plane/wiki/chart
	@# control-plane/nexus/chart/files is a COMMITTED projection of control-plane/nexus. The
	@# drift gate existed but ran nowhere, so a rebuilt dist could ship a
	@# chart serving the previous UI. It is cheap - run it with the charts.
	bash infra/scripts/sync-nexus-chart.sh --check

# gitops-emitter's own unit tests (render pipeline + plugin handler contract).
pytest:
	uv run --group dev pytest -q

# Builds the gitops-emitter wheel and proves the packaged resources work from
# an INSTALLED wheel (not a source checkout): the canonical infra/gitops-template/
# + schema are force-included at build time (see pyproject.toml, issue #28
# [L1]) and the plugin must still validate a record and scaffold a repo with
# them. See infra/scripts/wheel-smoke.sh.
wheel-smoke:
	bash infra/scripts/wheel-smoke.sh

# The dashboard's bun suite (#623). Gated because a red suite went unnoticed
# for as long as it did precisely because nothing ran it - the fonts assertion
# had been failing, and worse, had been unable to catch a real broken face.
#
# `bun install --frozen-lockfile` first because node_modules is gitignored
# repo-wide and a fresh clone has none; the lockfile makes that reproducible.
# It is needed even though the browser acceptance suite self-gates on
# NX_BROWSER, because that file imports playwright-core at module scope.
#
# Hermetic and fast: no network, no cluster, ~0.6s. The browser suite stays
# opt-in (`bun run browser-test`), so this adds no browser dependency.
.PHONY: dashboard-test
dashboard-test:
	cd nexus-ui && bun install --frozen-lockfile && bun test

# Regenerates _docs/wiki/reference/profile-record.md from the CURRENT profile record
# schema under agent-bundle-contracts/hermesprofile/ (the canonical, frozen contract).
# The version is resolved, not hardcoded: this generator spent three releases
# documenting v1alpha2 while the emitter had moved to v1alpha3, and the drift
# check could not see it. Run this (and commit the result) whenever that schema
# changes. See infra/scripts/generate-schema-docs.py's header comment.
docs:
	python3 infra/scripts/generate-schema-docs.py

# Fails if _docs/wiki/reference/profile-record.md or any _docs/wiki/reference/contracts/
# page has drifted from the schemas they're generated from (generate-then-diff),
# doesn't need `uv run` since the generator has no third-party dependencies.
# Fix with `make docs`.
docs-drift:
	@python3 infra/scripts/generate-schema-docs.py --check

# The CLI reference, rendered from the CLI itself (needs bun). Also fails if a
# command is dispatched in main.ts but missing from USAGE, or if cli/src reads an
# environment variable the generator has no description for.
cli-docs:
	python3 infra/scripts/generate-cli-docs.py

# Fails if _docs/wiki/reference/cli/index.md has drifted from the CLI. Fix with `make cli-docs`.
cli-docs-drift:
	@python3 infra/scripts/generate-cli-docs.py --check

# The platform version, DERIVED from conventional commits (feat -> minor,
# fix/perf -> patch, breaking -> minor while the major is 0). There are no tags
# and every package is 0.1.0, so a hand-written version would be a lie within a
# week. The docs badge computes this at BUILD time via a mkdocs hook - nothing is
# committed, because the value embeds the HEAD sha and would be stale
# immediately. This target just prints it.
.PHONY: version
version:
	@python3 infra/scripts/derive-version.py --print

# control-plane/{monitoring,fleet-dashboard}/chart/charts/hermes-alerting/ are COMMITTED
# copies of the control-plane/alert-router/lib library chart (#619). Committed rather
# than fetched because `helm dependency update` runs nowhere here - Argo syncs
# both consumers from bare Git paths. Regenerate after changing the library.
.PHONY: alerting-lib alerting-lib-drift
alerting-lib:
	bash infra/scripts/sync-alerting-lib.sh

# Fails if a consumer's copy has drifted. Fix with `make alerting-lib`.
alerting-lib-drift:
	@bash infra/scripts/sync-alerting-lib.sh --check

# Documentation screenshots of the real Nexus canvas, captured by driving the
# committed browser-acceptance harness under Playwright. Needs Chrome on the
# machine (playwright-core drives it; no browser download). Re-run after a UI
# change that the docs show. NOT in `make test`: it needs a browser, and a
# screenshot diff is not a useful gate.
.PHONY: nexus-screenshots
# Screenshot pairs now ride nexus-ui's review loop (browser/capture.ts
# takes explicit old/new URLs); the doc-capture target retired with
# dashboard/browser (its _docs/assets consumers re-point under #671).

# The wiki's brand mark and favicon, traced from the live mark in
# the mark algorithm (nexus-ui/src/primitives/HermesMark.tsx) at its canonical
# still frame. Regenerate after any
# change to that mark's field, constants or tracer, so the docs and the product
# never show two different marks.
mark:
	node infra/scripts/generate-mark-svg.mjs

# Fails if _docs/wiki/assets/{mark,favicon}.svg have drifted from the live mark.
# Fix with `make mark`.
mark-drift:
	@node infra/scripts/generate-mark-svg.mjs --check

# The rendered wiki (MkDocs Material over _docs/ — see mkdocs.yml). `wiki-*`
# not `docs-*`: the `docs`/`docs-drift` names above are taken by the schema
# reference generator. --strict promotes broken internal links and nav/file
# mismatches to build errors, so wiki-build doubles as the link checker in
# `make test` and CI. Bad *anchors* are only caught because mkdocs.yml raises
# validation.links.anchors to `warn` — they are `info` by default and --strict
# does not promote `info`.
# Live preview with rebuild on save. (The one-origin `dev-site` preview from
# ADR-136 retired with dashboard/ in #732; the Nexus demo is now the browser
# harness, nexus-ui/browser/serve.ts.)
wiki-serve:
	uv run --group docs mkdocs serve -f _docs/mkdocs.yml

wiki-build:
	uv run --group docs mkdocs build --strict -f _docs/mkdocs.yml
	@test -s _docs/site/llms.txt && test -s _docs/site/index.md \
	  || { echo 'wiki: the markdown endpoints are missing - mkdocs_llms_hook did not run'; exit 1; }

# The published wiki never cites an ADR (#825): the manual carries the claim,
# the internal ledger carries the history.
.PHONY: wiki-adr
wiki-adr:
	@bash infra/scripts/check-wiki-adr.sh

# The public tree carries no operator identifiers (the OSS gate); the ops
# overlay files are excluded here and absent from the public snapshot.
.PHONY: public-clean
public-clean:
	@bash infra/scripts/check-public-clean.sh

# The whole published site in ./site/: landing at /, the wiki at /docs/, the
# Nexus UI demo at /demo/ (infra/scripts/build-site.sh). This is what the
# Pages workflow uploads. Preview: python3 -m http.server -d site
.PHONY: site
site: wiki-build
	bash infra/scripts/build-site.sh

test: schema-validate gitops-template-validate chart-test pytest dashboard-test wheel-smoke docs-drift cli-docs-drift mark-drift alerting-lib-drift wiki-build wiki-adr public-clean site doc-links source-repos contract-types-drift chart-boundary retired-paths env-drift quickstart-drift e2e-offline

# The chart-boundary gate (#659, ADR 0163): every Chart.yaml declared in
# infra/scripts/chart-boundary.yaml with a homed class; application charts
# forbidden; cross-component references need a declared dependsOn. The
# rules are the manifest, not the validator. --self-test proves the gate
# bites (examples/invalid-chart-boundary).
.PHONY: chart-boundary
chart-boundary:
	@python3 infra/scripts/check-chart-boundary.py --self-test
	@python3 infra/scripts/check-chart-boundary.py

# The Argo CD sourceRepos allowlist is enforced twice by design; this
# proves the two enforcement points cannot silently enforce DIFFERENT
# policies (#133). `--json` exports the required set for an external Argo
# CD instance (#177), which must have it registered rather than assumed.
.PHONY: source-repos
source-repos:
	bash infra/scripts/check-source-repos.sh

# Every repo-local documentation reference resolves (#137). `mkdocs
# --strict` cannot catch these: it only sees markdown links inside the
# built site, so an in-CODE doc path in a chart comment, a values file or
# a Pulumi program rots silently - ~85 of them had.
.PHONY: doc-links
doc-links:
	bash infra/scripts/check-doc-links.sh

# The #675 docs-vs-runs gate: every hg command a loop script asserts
# appears, in order, in its quickstart's fenced blocks (ADR 0170: the
# scripts are the acceptance surface; the prose defers to them).
.PHONY: quickstart-drift
quickstart-drift:
	@bash infra/scripts/check-quickstart-drift.sh

# The #674 drift gate: every declared environment's generated Pulumi
# stack config matches its spec (hg env plan exits 1 on drift). Specs
# live at infra/environments/<name>.yaml.
.PHONY: env-drift
env-drift:
	@for spec in infra/environments/*.yaml; do \
		name=$$(basename $$spec .yaml); \
		bun cli/src/main.ts env plan $$name >/dev/null || exit 1; \
		echo "OK   env $$name: spec == generated config"; \
	done

# The #672 grep-gate: no living reference to a retired tree
# (plugin/schemas, infra/charts, dashboard/*) or a deleted CLI alias.
# The exemption list and its reasons live in the script header.
.PHONY: retired-paths
retired-paths:
	@bash infra/scripts/check-retired-paths.sh

# End-to-end scaffold validation, the cluster-free half (#669): validate
# -> topology plan -> emitter scaffold -> emit -> gitops doctor -> nexus
# validate -> the persona repo's own acceptance, chained without
# docker/k3d. The persona legs skip loudly when the sibling checkout is
# absent, so a lone clone of this repo still gates on the example repos.
# PR gate: part of `make test`.
.PHONY: e2e-offline
e2e-offline:
	bash infra/scripts/e2e-offline.sh

# The cluster-bearing half (#669) and the dev loop's executable
# walkthrough (#670): cli/e2e-local.sh's 12-step onboard -> up -> test ->
# dev -> reset -> eval -> reconcile chain against a throwaway k3d
# cluster. NOT part of `make test`: needs docker + the
# hermes-agent:hermes-gitops-dev image and takes 10-20 minutes. Runs
# nightly via .github/workflows/live-loop.yaml.
.PHONY: e2e
e2e:
	bash cli/e2e-local.sh

# The three loop walkthroughs as executable runs (#670, ADR 0170).
# loop-dev needs docker/k3d (nightly, = e2e); loop-agent-bundle is
# cluster-free; loop-ops runs against a live environment (set
# HG_KUBE_CONTEXT/HG_STACK on an operator host, or nothing for the
# local loop after `hg up`).
.PHONY: loop-dev loop-agent-bundle loop-ops
loop-dev:
	bash cli/loops/dev-loop.sh
loop-agent-bundle:
	bash cli/loops/agent-bundle-loop.sh
loop-ops:
	bash cli/loops/ops-loop.sh

# Deployment-neutrality proof (#669): render every persona profile's
# record from two platform refs and byte-compare. The final-pass
# baseline is 7a3fefbd (the commit before #678).
#   make record-cmp REF_A=7a3fefbd REF_B=main
.PHONY: record-cmp
record-cmp:
	bash infra/scripts/record-cmp.sh $(REF_A) $(REF_B)

# Day-2 hardening (Task 10): drift + decommission acceptance test against a
# real (throwaway) k3d cluster — see infra/scripts/test-drift-and-decommission.sh
# for the full scenario list (Service/Pod/StatefulSet drift, an
# ExternalSecret-backed Secret deletion, an out-of-band HermesProfile CR
# patch, decommission + PVC lifecycle, and re-install). NOT part of `make
# test`: requires a local docker daemon (k3d runs k3s-in-docker) and
# takes on the order of 10-20 minutes end to end. Runs nightly in CI via
# .github/workflows/live-loop.yaml (issue #15 [I1]), not as a PR gate.
drift-test:
	bash infra/scripts/test-drift-and-decommission.sh

# The eve-agent chart's process-start contract, proven in Docker without a
# cluster (ADR-149): the eve-runtime image builds from versions.json's pin,
# the chart's rendered boot.sh converges the example Eve project from a git
# source (clone, npm ci, pin check, eve build, stamp; a second boot skips),
# and `eve start` answers health 200 / anonymous 401 + Basic challenge /
# minted credential accepted. NOT part of `make test`: needs Docker and the
# npm registry, a few minutes. A real model turn is `hg test`'s job.
.PHONY: eve-boot-test
eve-boot-test:
	bash infra/scripts/eve-boot-test.sh

# Git-side bootstrap verify (stages 1-2, no cluster/docker) - the PR gate
# wired into CI (.github/workflows/ci.yaml bootstrap-git-side-verify,
# issue #15 [I1]). Needs a hermes-agent-gitops checkout; point
# HERMES_FORK_PATH at it if it isn't ../hermes-agent-gitops.
verify-git-side:
	bash infra/scripts/verify-bootstrap-git-side.sh

# TypeScript contract types are GENERATED from the canonical JSON Schema
# (ADR-7, #139). `contract-types` regenerates; `contract-types-drift` is
# the gate - it fails if the committed file no longer matches the schema,
# the same shape as docs-drift.
.PHONY: contract-types
contract-types:
	node infra/scripts/generate-contract-types.mjs

.PHONY: contract-types-drift
contract-types-drift:
	node infra/scripts/generate-contract-types.mjs --check
