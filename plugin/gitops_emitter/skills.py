"""Offline verification of committed external skill packages before emission."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

import jsonschema
import yaml

from .render import load_vendored_schema


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":")).encode()).hexdigest()


def safe_path(root: Path, value: str, allow_root: bool = False) -> Path:
    if not isinstance(value, str) or not value or "\\" in value or "\0" in value:
        raise ValueError("Invalid skill path")
    if value != "." or not allow_root:
        if Path(value).is_absolute() or any(p in ("", ".", "..", ".git") for p in value.split("/")):
            raise ValueError("Skill path escapes package")
    target = root / value
    if any(p.is_symlink() for p in [target, *target.parents]):
        raise ValueError("Skill paths must not contain symlinks")
    if not target.exists():
        raise ValueError("Missing skill resource")
    return target


def document(contract: Path, stem: str) -> dict:
    filename = "skills.yaml" if stem == "manifest" else "skills.lock.yaml"
    doc = yaml.safe_load(safe_path(contract, filename).read_text())
    schema = load_vendored_schema(f"agent-skills-{stem}-v1alpha1.schema.json",
                                  "agent-skills", "v1alpha1", f"{stem}.schema.json")
    try:
        jsonschema.validate(doc, schema)
    except jsonschema.ValidationError as exc:
        raise ValueError(f"Invalid skill {stem} schema") from exc
    return doc


def verify_skills(project: Path, contract: Path, harness: str) -> None:
    if (contract / ".skills-install.json").exists():
        raise ValueError("Interrupted skill installation must be recovered before emission")
    if not (contract / "skills.yaml").exists():
        if (contract / "skills.lock.yaml").exists():
            raise ValueError("Skill lock has no manifest")
        return
    if harness != "eve":
        raise ValueError("External skill installation supports Eve agents only")
    manifest, lock = document(contract, "manifest"), document(contract, "lock")
    names = [s["name"] for s in manifest["skills"]]
    locks = {s["name"]: s for s in lock["skills"]}
    if (len(set(names)) != len(names) or len(locks) != len(lock["skills"])
            or set(names) != set(locks) or lock["manifest"] != fingerprint(manifest)):
        raise ValueError("Skill lock is stale or has duplicate entries")
    for skill in manifest["skills"]:
        source, pinned = skill["source"], locks[skill["name"]]
        if source != pinned["source"] or source["ref"].get("commit", pinned["commit"]) != pinned["commit"]:
            raise ValueError("Skill lock source differs from manifest")
        tag = source["ref"].get("tag")
        if tag and (not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/-]*", tag)
                    or ".." in tag or "//" in tag or tag.split("/")[-1] in ("latest", "HEAD")):
            raise ValueError("Skill version must be an exact tag or commit")
        root = safe_path(project, f"agent/skills/{skill['name']}")
        files = []
        for file in root.rglob("*"):
            safe_path(root, file.relative_to(root).as_posix())
            if not file.is_file() and not file.is_dir():
                raise ValueError("Skill packages require regular files")
            if file.is_file():
                files.append(file.relative_to(root).as_posix())
        entries = [f for f in files if Path(f).name == "SKILL.md"]
        if entries != [source["entrypoint"]]:
            raise ValueError("Skill entrypoint differs from manifest")
        for resource in skill["resources"]:
            safe_path(root, resource)
        digest = hashlib.sha256()
        for file in sorted(files):
            digest.update(file.encode() + b"\0" + (root / file).read_bytes() + b"\0")
        if digest.hexdigest() != pinned["hash"]:
            raise ValueError("Installed skill differs from locked SHA-256")
