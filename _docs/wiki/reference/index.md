# Reference

**What this page tells you:** where to look up an exact command, field, file or value.

Where a conceptual page and this section disagree, this section is right.

| Page | Answers |
|---|---|
| [CLI](cli/index.md) | the exact command and flag. One page per command, generated from the CLI's own manifest |
| [Contract files](contracts/index.md) | what a file is, who writes it, who reads it. One generated field reference per contract |
| [Repository scaffolds](repo-scaffolds.md) | what should exist where, and who owns it |
| [Configuration](configuration.md) | where to set a value, and which value wins |
| [Profile record](profile-record.md) | the legacy harness's record, generated from its schema |

## Generated pages

The CLI pages, the contract field references and the profile record are rendered from their
sources and byte-compared in `make test`. They cannot drift from the code.

| Page | Regenerate | Gate |
|---|---|---|
| `reference/cli/` | `make cli-docs` | `make cli-docs-drift` |
| `reference/contracts/` (all but the overview) | `make docs` | `make docs-drift` |
| `reference/profile-record.md` | `make docs` | `make docs-drift` |

Never hand-edit them. If one is wrong, the source is wrong.
