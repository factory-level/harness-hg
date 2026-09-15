"""The emitter refuses stale locks even when invoked independently of hg."""
import hashlib
from pathlib import Path
import sys

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).parents[1]))
from gitops_emitter.skills import fingerprint, verify_skills

API = "hermes-gitops.factorylevel.dev/agent-skills/v1alpha1"


def test_emitter_checks_locked_content(tmp_path):
    contract, project = tmp_path / "harness-hg", tmp_path / "src"
    contract.mkdir()
    package = project / "agent/skills/research"
    package.mkdir(parents=True)
    content = b"---\nname: research\ndescription: Research workshops.\n---\n"
    (package / "SKILL.md").write_bytes(content)
    source = {"repository": "https://github.com/example/skills", "root": ".",
              "entrypoint": "SKILL.md", "ref": {"commit": "a" * 40}}
    manifest = {"apiVersion": API, "kind": "AgentSkills", "skills": [{"name": "research",
                "source": source, "resources": [], "tools": [], "executables": [],
                "writes": [], "scenario": "research"}]}
    lock = {"apiVersion": API, "kind": "AgentSkillsLock", "manifest": fingerprint(manifest),
            "skills": [{"name": "research", "source": source, "commit": "a" * 40,
                        "hash": hashlib.sha256(b"SKILL.md\0" + content + b"\0").hexdigest()}]}
    (contract / "skills.yaml").write_text(yaml.safe_dump(manifest))
    (contract / "skills.lock.yaml").write_text(yaml.safe_dump(lock))
    verify_skills(project, contract, "eve")
    (package / "SKILL.md").write_text("modified")
    with pytest.raises(ValueError, match="SHA-256"):
        verify_skills(project, contract, "eve")
    manifest["skills"][0]["tools"] = ["send_email"]
    (contract / "skills.yaml").write_text(yaml.safe_dump(manifest))
    with pytest.raises(ValueError, match="stale"):
        verify_skills(project, contract, "eve")
    lock["skills"][0]["name"] = "../outside"
    (contract / "skills.lock.yaml").write_text(yaml.safe_dump(lock))
    with pytest.raises(ValueError, match="schema"):
        verify_skills(project, contract, "eve")
