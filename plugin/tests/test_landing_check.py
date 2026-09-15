"""Negative cases for the launch page gate."""
import importlib.util
from pathlib import Path
import shutil

SOURCE = Path(__file__).resolve().parents[2] / 'infra/scripts/check-landing.py'
spec = importlib.util.spec_from_file_location('landing_check', SOURCE)
landing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(landing)


def test_scene_commands_reject_unknown_verbs_flags_and_missing_arguments():
    commands = [
        {'name': 'dev', 'subs': [{'name': '', 'args': '<repo>'}]},
        {'name': 'backup', 'subs': [{'name': 'restore', 'flags': [{'name': '--from', 'value': '<file>'}]}]},
    ]
    assert not landing.validate_commands("{ verb: 'dev', target: 'examples/agent-team'", commands)
    for source in ("{ verb: 'deploy', target: 'team'", "{ verb: 'dev', target: ''",
                   "{ verb: 'backup', target: 'unknown'", "{ verb: 'backup', target: 'restore --fake'",
                   "{ verb: 'backup', target: 'restore --from'"):
        assert landing.validate_commands(source, commands)


def test_missing_asset_anchor_metadata_and_cache_token_are_detected(tmp_path, monkeypatch):
    shutil.copytree(landing.ROOT / 'landing', tmp_path / 'landing')
    monkeypatch.setattr(landing, 'ROOT', tmp_path)
    monkeypatch.setattr(landing.subprocess, 'check_output', lambda *a, **k: '[{"name":"dev","subs":[{"name":"","args":"[<repo>]"}]},{"name":"status","subs":[{"name":""}]},{"name":"backup","subs":[{"name":"list"}]}]')
    assert not landing.check()
    index = tmp_path / 'landing/index.html'
    text = index.read_text().replace('property="og:image"', 'property="missing-image"')
    text += '<a href="#absent">Missing anchor</a><img src="assets/absent.png"><script src="theme.js"></script>'
    index.write_text(text)
    errors = landing.check()
    assert any('incorrect og:image' in error for error in errors)
    assert any('missing anchor' in error for error in errors)
    assert any('missing link/asset' in error for error in errors)
    assert any('missing asset cache token' in error for error in errors)
