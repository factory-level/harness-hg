"""Keeps .hermes/examples/rendered/profile-echo.yaml in lockstep with
.hermes/examples/persona-echo/distribution.yaml (see
tests/render_persona_echo_example.py's module docstring for the full
rationale — same "golden render, diffed every run" pattern
infra/scripts/render-test.sh uses for the Helm chart, applied to the persona-echo
documentation example instead).

Set PERSONA_ECHO_UPDATE=1 to regenerate the golden file in place instead of
asserting against it — mirrors infra/scripts/render-test.sh's own --update flag.
"""

from __future__ import annotations

import os

from render_persona_echo_example import OUT_PATH, render_example


def test_profile_echo_rendered_matches_source():
    text = render_example()

    if os.environ.get("PERSONA_ECHO_UPDATE") == "1":
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(text, encoding="utf-8")
        return

    assert OUT_PATH.is_file(), (
        f"{OUT_PATH} does not exist — run with PERSONA_ECHO_UPDATE=1 to generate it"
    )
    assert OUT_PATH.read_text(encoding="utf-8") == text, (
        f"{OUT_PATH} is out of date with .hermes/examples/persona-echo/distribution.yaml — "
        "rerun with PERSONA_ECHO_UPDATE=1 to regenerate"
    )
