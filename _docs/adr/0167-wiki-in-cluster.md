# ADR 0167 — The manual ships in-cluster, version-matched

2026-08-25 · executes [#664](https://github.com/factory-level/harness-hg/issues/664), part of
the final-pass epic [#646](https://github.com/factory-level/harness-hg/issues/646).

## Decision

- **The build artifact ships in the image** (the in-issue decision): `control-plane/wiki/
  image/` builds from the **repo root** (the only image that does — the root
  `.dockerignore` exists for it), running `make wiki-build --strict`'s exact command and
  baking `derive-version.py --print` into `/version`. Version correspondence is therefore
  mechanical: the served version string embeds the HEAD sha the site was built from —
  no committed projection, no hand-editable artifact.
- `control-plane/wiki/chart` is a 2-template nginx chart (plane-labeled, tiny limits);
  `bootstrap/wiki.yaml` joins the seed; the image pin lives in `versions.json` (`wiki`
  block, chart default asserted equal by `versions.test.ts`). Locally, `hg up` builds the
  image at the current checkout, imports it, installs the chart (`ensureWiki`) — the
  layer cache makes reruns cheap.
- **URL scheme is the mkdocs tree** (`/platform/…`, `/reference/…`, `/version`) — stable,
  deep-linkable; proven live in this ADR's smoke (image served the site, `/version`
  answered `v0.191.0-dev+<sha>`, `/platform/` answered 200).
- **Edge exposure and the Nexus SSO deep-link ride the factory follow-up**
  ([#703](https://github.com/factory-level/harness-hg/issues/703)): the hostname/Access
  wiring is live-environment work, and the onboarding content lands via
  [#675](https://github.com/factory-level/harness-hg/issues/675) into this vehicle.

## Reason

The published docs and the running platform drift the moment they deploy separately; a
site baked at the revision that built the platform cannot. `make wiki-build --strict`
stays the single build entry point — the Dockerfile calls it, not a copy of it.

## Cost

- Publishing the wiki image is a real registry push per release (build.sh `--push`), a new
  step the release path must remember — factory converges only on pushed tags (#703).
- The image build copies the repo (minus `.dockerignore`) — heavier context than any other
  image; acceptable at ~1 min cold, seconds cached.
- `/version` proves what was BUILT, not what the cluster's platform is mid-upgrade: during
  a rollout the wiki and the platform can be one revision apart until both sync.
