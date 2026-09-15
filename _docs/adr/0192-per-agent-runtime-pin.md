# 0192 — Per-agent runtime pin

**Status:** Accepted
**Changes:** `_docs/design/platform.md`

## Decision

An installation plan may pin one agent to a runtime image digest and Eve version other than the
plan default. `versions.json` lists every allowed image and version pair beside the default;
nothing outside that list may be pinned. Team compilation, production startup, deployment
readiness and the build container all use the agent's effective runtime. The build container
refuses a project whose resolved Eve differs from the effective version it was rendered with.

A runtime canary is one agent pinned ahead of the default. Promotion changes the default and
removes the pin.

## Reason

Team compilation writes one image digest into every agent, and the record's tag override is
ignored whenever a digest is set. A runtime upgrade therefore moves every agent at once, and
readiness rejects any agent running anything else. There is no staged path.

## Cost

- The platform builds, publishes and retains every allowed image until no plan pins it.
- A pinned agent's source lockfile must still resolve the pinned Eve version.
- Promotion is manual. Nothing advances a canary automatically.
- Eve's persisted workflow data has no migration or compatibility check across versions.
