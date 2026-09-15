# 0194 — Operator overlays

**Status:** Accepted
**Changes:** `_docs/design/platform.md`, `_docs/design/cli.md`, `_docs/design/vocabulary.md`

## Decision

A bootstrap installation plan may declare **operator overlays** for a source or for one agent.
An overlay names a kind (`skill`, `tool`, `connection`, `instructions`, `file`), a mode
(`append`, `override`, `remove`), a target inside the agent directory, and a Git source pinned
to a commit. Source overlays apply before agent overlays, each in declared order.

- `append` requires an absent target, `override` and `remove` an existing one. Removing a
  framework tool writes Eve's disable stub, because deleting the file would restore the tool.
- Appending instructions adds provenance-marked text to `instructions.md`.
- The agent definition, sandbox, channels and package files cannot be targeted. Overlay code
  may import only packages already in the source lockfile.
- Skills owned by the source's skill manifest cannot be overridden or removed by an overlay.

Compilation fetches each overlay, records its content hash, builds the merged agent tree and
runs production startup against that tree. Every overlay requires human approval of its entries,
content hashes and skill capabilities under the source's approval policy. Changed overlay content
invalidates approval; a new source commit does not.

The record carries the overlays and the merged tree hash in a new EveAgent schema version,
emitted only when overlays exist. The build container fetches the same commits, verifies each
hash, applies them with the merge implementation the CLI uses, verifies the tree hash, and then
builds. The build stamp covers the source commit and the overlay digest, so an overlay change
alone rebuilds the agent.

This supersedes ADR 0186's "Deployment never downloads skills" for approved overlay content
only. Deployment fetches exact approved commits and refuses any other content.

## Reason

Consumers must tailor team-authored agents without forking them. Skills, tools and instructions
are source compiled by `eve build`: nothing mounted after the build is visible, list values
replace wholesale, and the record rejects fields it does not declare.

## Cost

- Rebuilds depend on overlay hosts continuing to serve the pinned commits.
- Overlays cannot add npm dependencies, replace the agent definition, sandbox or channels, or
  append to `instructions.ts`.
- Bundled agents are not supported.
- Every overlay content change needs human re-approval.
- A tool removal disables framework tools only; removing an authored tool is a file removal.
- One merge implementation runs in two places and needs a conformance gate between them.
