# Install the tools

**Outcome:** `hg` on your PATH and the platform checkout. That is everything the loops need.

## Prerequisites

A Linux x86-64 host (the local loop, the bootstrap and CI all assume it; macOS is untested).
On your PATH: `bun`, `docker`, `git`, `k3d`, `kubectl`, `helm`, `uv` and `python3`. `hg`
checks them and names every missing one at once. Nothing here needs a cloud account.

Known-good versions are the ones the platform pins for its own hosts in `versions.json`:
bun 1.3, helm 3.16, kubectl 1.36, k3d 5.9. Older minors usually work; these are proven.

One host setting, Linux only, needs sudo once. k3s inside Docker opens many inotify
watchers, and the default limit of 128 makes its container runtime fail to start with
`too many open files`, so nothing schedules:

```bash
sudo sysctl -w fs.inotify.max_user_instances=1024
echo fs.inotify.max_user_instances=1024 | sudo tee /etc/sysctl.d/99-inotify.conf
```

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
export PATH="$HOME/.bun/bin:$PATH"   # where `bun link` puts hg; add it to your shell rc
```

`hg --help` now prints the command tree. If it says `command not found`, the PATH line above
did not reach the shell you are in.

## Proof

From the `harness-hg` checkout:

```bash
cd ..
hg onboard examples/agent-team   # the demo team: manager + research
hg validate
```

**Done when** `hg validate` reports the catalogue clean. Next, pick your loop on
[Get Started](index.md). Most people start with [Build an agent team](dev-quickstart.md).
