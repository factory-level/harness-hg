# Install the tools

**Outcome:** `hg` on your PATH and the platform checkout. That is everything the loops need.

## Prerequisites

On your PATH: `bun`, `docker`, `git`, `k3d`, `kubectl`, `helm`, `uv` and `python3`. `hg`
checks them and names every missing one at once. Nothing here needs sudo or a cloud account.

## 1. Clone the platform

```bash
git clone https://github.com/factory-level/harness-hg
```

## 2. Put `hg` on your PATH

`hg` is the operator CLI for everything that follows. See the
[CLI reference](../reference/cli/index.md).

```bash
cd harness-hg/cli
bun install --frozen-lockfile
bun link
```

## Proof

From the `harness-hg` checkout:

```bash
cd ..
hg onboard examples/agent-team   # the demo team: manager + research
hg validate
```

**Done when** `hg validate` reports the catalogue clean. Next, pick your loop on
[Get Started](index.md). Most people start with [Build an agent team](dev-quickstart.md).
