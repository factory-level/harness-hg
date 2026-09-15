# plugin/

`gitops_emitter`, the Python package that renders an agent's declaration into the plain Helm
values record the GitOps repository carries. `harness/` holds one driver per runtime;
`emit_cli.py` is the entrypoint Pulumi and `hg` call. The schemas it validates against live in
`agent-bundle-contracts/`, not here.

Gate: `make pytest` (`uv run --group dev pytest -q`) and `make wheel-smoke`, which proves the
packaged wheel imports. `tests/chart/` carries the golden renders.

Manual: https://factory-level.github.io/harness-hg/docs/reference/profile-record/
