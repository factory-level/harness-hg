# harness/

The agent runtimes the platform can run, one directory each. `eve/` is the default: its
image, chart and identity. `hermes/` is frozen legacy, kept renderable until its retirement
lands (#933); do not build on it. `index.md` is the harness contract every runtime meets.

Gate: `make chart-test` renders each harness chart against the frozen contract examples.

Manual: https://factory-level.github.io/harness-hg/docs/platform/runtime/
