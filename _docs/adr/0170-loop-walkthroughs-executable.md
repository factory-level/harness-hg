# 0170 — The loop walkthroughs are executable runs, not prose

**Decision.** The three operator-loop walkthroughs in `_docs/design/cli.md` are executed by
scripts under `cli/loops/` — `dev-loop.sh` (delegating to `cli/e2e-local.sh`),
`agent-bundle-loop.sh`, `ops-loop.sh` — each a sequence of real `hg` invocations with
asserted outcomes and make front doors (`loop-dev` / `loop-agent-bundle` / `loop-ops`).
The design page's walkthrough section names its executable run per loop; ADR 0159's
admission that "the walkthroughs are prose until #670 executes them" is thereby resolved.
The ops run covers the post-day-0 **prove segment only**, and against a non-local
environment it runs the environment-portable subset — `reconcile status`,
`connection prove`, `backup verify`, `observability prove`, `edge prove` — while
`auth prove`, `grafana prove`, and `launch prove` remain local-loop-shaped (#740) and are
skipped with a stated reason, never silently. The page's loop table also stops implying a
live `bundle` command: `hg bundle init` is the **phase-5 front door #673 builds**; the
former `bundle` verb died unmapped in the loop census.

**Reason.** Prose walkthroughs rot against reality with nothing to catch them — that was
the stated risk in ADR 0159, and the #670 acceptance run proved it by finding a factory
backup artifact that did not contain what its routine claimed to protect
(social-media.harness-hg#53) and three prove verbs that could not run outside the local
loop at all (#740). A walkthrough that executes is a walkthrough whose rot blocks a merge.

**Cost.** The scripts are a second copy of each sequence and can drift from the prose; the
mitigation is directional — the scripts are the acceptance surface, so the prose defers to
them, and the page links each walkthrough to its script rather than restating steps. The
ops loop's off-loop coverage is honestly partial until #740 closes: three of its eight SOP
steps assert nothing against a real environment today. `loop-dev` costs a k3d cluster and
10–20 minutes, so it gates nightly (live-loop.yaml), not per-PR.
