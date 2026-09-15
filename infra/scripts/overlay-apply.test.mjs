// Merge rules of harness/eve/charts/eve-agent/files/overlay-apply.mjs (ADR 0194), the one
// implementation the build container and `hg team` share. Run: node --test (render-test.sh 6).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { applyOverlays, contentHash, contentPath, overlayDigest, overlayLines, parseOverlayLines, DISABLE_TOOL_STUB } =
  await import(path.join(here, "../../harness/eve/charts/eve-agent/files/overlay-apply.mjs"));

const COMMIT = "9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const temporary = [];
process.on("exit", () => { for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-apply-")); temporary.push(dir); return dir; }
function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function project() {
  const root = temp();
  write(root, "agent/instructions.md", "You are echo.");
  write(root, "agent/tools/lookup.ts", "export default {};\n");
  write(root, "agent/skills/drafting/SKILL.md", "---\ndescription: draft\n---\n");
  write(root, "agent/connections/crm.ts", "export default 1;\n");
  return root;
}
const file = (name, text) => write(temp(), name, text);
function directory(files) { const root = temp(); for (const [relative, text] of Object.entries(files)) write(root, relative, text); return root; }
function overlay(id, kind, mode, target, content) {
  if (mode === "remove") return { id, kind, mode, target };
  return { id, kind, mode, target, source: { repository: "https://github.com/example/overlays.git", commit: COMMIT, path: "x" }, contentHash: contentHash(content), content };
}
const apply = (root, overlays, treeHash, protectedSkills) => applyOverlays({ project: root, overlays, treeHash, protectedSkills, contentFor: o => o.content });

test("every kind and mode merges in order, and the merged tree hash is reproducible", () => {
  const rules = file("rules.md", "Always cite sources.");
  const overlays = [
    overlay("brand-voice", "skill", "append", "agent/skills/brand-voice", directory({ "SKILL.md": "---\ndescription: voice\n---\n" })),
    overlay("disable-bash", "tool", "remove", "agent/tools/bash.ts"),
    overlay("retire-lookup", "file", "remove", "agent/tools/lookup.ts"),
    overlay("crm", "connection", "override", "agent/connections/crm.ts", file("crm.ts", "export default 2;\n")),
    overlay("rules", "instructions", "append", "agent/instructions.md", rules),
  ];
  const root = project();
  const { treeHash } = apply(root, overlays);
  assert.equal(fs.readFileSync(path.join(root, "agent/skills/brand-voice/SKILL.md"), "utf8"), "---\ndescription: voice\n---\n");
  assert.equal(fs.readFileSync(path.join(root, "agent/tools/bash.ts"), "utf8"), DISABLE_TOOL_STUB);
  assert.equal(fs.existsSync(path.join(root, "agent/tools/lookup.ts")), false);
  assert.equal(fs.readFileSync(path.join(root, "agent/connections/crm.ts"), "utf8"), "export default 2;\n");
  assert.equal(fs.readFileSync(path.join(root, "agent/instructions.md"), "utf8"),
    `You are echo.\n\n<!-- harness-hg overlay rules ${COMMIT} sha256:${overlays[4].contentHash} -->\nAlways cite sources.\n`);
  assert.equal(apply(project(), overlays, treeHash).treeHash, treeHash);
  assert.throws(() => apply(project(), overlays, "0".repeat(64)), /merged agent\/ tree hashes/);
});

test("append needs an absent resource in every form; override and remove need the target", () => {
  const skill = directory({ "SKILL.md": "---\ndescription: x\n---\n" });
  assert.throws(() => apply(project(), [overlay("d", "skill", "append", "agent/skills/drafting", skill)]), /append needs/);
  const flat = project();
  write(flat, "agent/skills/voice.md", "flat");
  assert.throws(() => apply(flat, [overlay("v", "skill", "append", "agent/skills/voice", skill)]), /append needs/);
  const twoForms = project();
  write(twoForms, "agent/skills/drafting.md", "flat twin");
  assert.throws(() => apply(twoForms, [overlay("d", "skill", "override", "agent/skills/drafting", skill)]), /another form/);
  assert.throws(() => apply(project(), [overlay("m", "connection", "override", "agent/connections/missing.ts", file("m.ts", "1"))]), /override needs/);
  assert.throws(() => apply(project(), [overlay("m", "file", "remove", "agent/hooks/none.ts")]), /remove needs/);
  assert.throws(() => apply(project(), [overlay("f", "skill", "append", "agent/skills/flat.md", skill)]), /takes one file/);
  assert.throws(() => apply(project(), [overlay("p", "skill", "append", "agent/skills/bare", directory({ "README.md": "no entry" }))]), /needs SKILL.md/);
});

test("tool removal disables the framework tool and replaces any authored form of the slug", () => {
  const root = project();
  write(root, "agent/tools/bash.js", "authored");
  apply(root, [overlay("b", "tool", "remove", "agent/tools/bash.ts")]);
  assert.equal(fs.existsSync(path.join(root, "agent/tools/bash.js")), false);
  assert.equal(fs.readFileSync(path.join(root, "agent/tools/bash.ts"), "utf8"), DISABLE_TOOL_STUB);
});

test("instructions stack as an optional override first, then appends; everything else has one writer", () => {
  const base = file("base.md", "A"), more = file("more.md", "B\n");
  const root = project();
  apply(root, [overlay("base", "instructions", "override", "agent/instructions.md", base), overlay("more", "instructions", "append", "agent/instructions.md", more)]);
  assert.match(fs.readFileSync(path.join(root, "agent/instructions.md"), "utf8"), /^A\n\n<!-- harness-hg overlay more [0-9a-f]{40} sha256:[0-9a-f]{64} -->\nB\n$/);
  assert.throws(() => apply(project(), [overlay("more", "instructions", "append", "agent/instructions.md", more), overlay("base", "instructions", "override", "agent/instructions.md", base)]), /one overlay per target/);
  assert.throws(() => apply(project(), [overlay("x", "tool", "remove", "agent/tools/a.ts"), overlay("y", "file", "remove", "agent/tools/a.ts")]), /one overlay per target/);
  assert.throws(() => apply(project(), [overlay("x", "tool", "remove", "agent/tools/a.ts"), overlay("x", "tool", "remove", "agent/tools/b.ts")]), /appears twice/);
  const typed = project();
  fs.rmSync(path.join(typed, "agent/instructions.md"));
  write(typed, "agent/instructions.ts", "export default 'x';\n");
  assert.throws(() => apply(typed, [overlay("more", "instructions", "append", "agent/instructions.md", more)]), /instructions\.ts agent/);
});

test("forbidden targets, kind mismatches and unsafe content refuse", () => {
  const code = file("x.ts", "export default 1;\n");
  for (const [candidate, reason] of [
    [overlay("a", "file", "override", "agent/agent.ts", code), /never overlay targets/],
    [overlay("c", "file", "override", "agent/channels/eve.ts", code), /never overlay targets/],
    [overlay("p", "file", "override", "agent/../package.json", code), /normalized path/],
    [overlay("pj", "file", "override", "agent/package.json", code), /package files/],
    [overlay("nm", "file", "append", "agent/lib/node_modules/x.js", code), /package files/],
    [overlay("i", "file", "remove", "agent/instructions.md"), /never target skills or instructions/],
    [overlay("s", "file", "override", "agent/skills/drafting/SKILL.md", code), /never target skills or instructions/],
    [overlay("t", "file", "override", "agent/tools/lookup.ts", code), /may only remove/],
    [overlay("tr", "file", "override", "agent/tools", directory({ "evil.ts": "1" })), /may only remove/],
    [overlay("cr", "file", "append", "agent/connections", directory({ "evil.ts": "1" })), /may only remove/],
    [overlay("k", "skill", "append", "agent/tools/k.ts", code), /cannot target/],
    [overlay("r", "instructions", "remove", "agent/instructions.md"), /never removed/],
  ]) assert.throws(() => apply(project(), [candidate]), reason);
  const tampered = { ...overlay("rules", "instructions", "append", "agent/instructions.md", file("r.md", "x")), contentHash: "a".repeat(64) };
  assert.throws(() => apply(project(), [tampered]), /the record pins/);
  const withPackage = directory({ "helpers.js": "export default 1;\n", "package.json": "{}" });
  assert.throws(() => apply(project(), [overlay("lib", "file", "append", "agent/lib", withPackage)]), /never arrive through an overlay/);
  const withDependencies = directory({ "helpers.js": "export default 1;\n", "node_modules/evil/index.js": "1" });
  assert.throws(() => apply(project(), [overlay("lib", "file", "append", "agent/lib", withDependencies)]), /never arrive through an overlay/);
  const linked = directory({ "SKILL.md": "---\ndescription: x\n---\n" });
  fs.symlinkSync("/etc/hostname", path.join(linked, "leak"));
  assert.throws(() => contentHash(linked), /never symlinks/);
  const escape = project();
  fs.rmSync(path.join(escape, "agent/tools"), { recursive: true });
  fs.symlinkSync(temp(), path.join(escape, "agent/tools"));
  assert.throws(() => apply(escape, [overlay("b", "tool", "remove", "agent/tools/bash.ts")]), /symlink on the overlay path/);
});

test("the content hash is an unambiguous encoding: different trees never share a hash", () => {
  assert.notEqual(contentHash(directory({ a: "X\0b\0Y" })), contentHash(directory({ a: "X", b: "Y" })));
  assert.equal(contentHash(directory({ "x/y.md": "same" })), contentHash(directory({ "x/y.md": "same" })));
});

test("fetched content never passes through a symlink in its repository", () => {
  const checkout = temp();
  fs.symlinkSync(directory({ "payload/SKILL.md": "---\ndescription: x\n---\n" }), path.join(checkout, "link"));
  const o = { id: "s", kind: "skill", mode: "append", target: "agent/skills/s", source: { repository: "https://github.com/example/overlays.git", commit: COMMIT, path: "link/payload" }, contentHash: "e".repeat(64) };
  assert.throws(() => contentPath(checkout, o), /passes through a symlink/);
  assert.throws(() => contentPath(checkout, { ...o, source: { ...o.source, path: "missing" } }), /is absent/);
  write(checkout, "real/SKILL.md", "x");
  assert.equal(contentPath(checkout, { ...o, source: { ...o.source, path: "real" } }), path.join(checkout, "real"));
  assert.equal(contentPath(checkout, { ...o, source: { ...o.source, path: "." } }), checkout);
});

test("skills owned by the source's skill manifest cannot be overridden or removed", () => {
  const skill = directory({ "SKILL.md": "---\ndescription: x\n---\n" });
  assert.throws(() => apply(project(), [overlay("d", "skill", "override", "agent/skills/drafting", skill)], undefined, ["drafting"]), /skill manifest/);
  assert.throws(() => apply(project(), [overlay("d", "skill", "remove", "agent/skills/drafting")], undefined, ["drafting"]), /skill manifest/);
  apply(project(), [overlay("d", "skill", "remove", "agent/skills/drafting")], undefined, ["another"]);
});

test("the line format round-trips, refuses malformed lines, and the digest binds every field", () => {
  const overlays = [
    { id: "b", kind: "tool", mode: "remove", target: "agent/tools/bash.ts" },
    { id: "s", kind: "skill", mode: "append", target: "agent/skills/s", source: { repository: "https://github.com/example/overlays.git", commit: COMMIT, path: "." }, contentHash: "e".repeat(64) },
  ];
  const lines = overlayLines(overlays);
  assert.equal(lines, `b tool remove agent/tools/bash.ts - - - -\ns skill append agent/skills/s https://github.com/example/overlays.git ${COMMIT} . ${"e".repeat(64)}`);
  assert.deepEqual(parseOverlayLines(lines), overlays);
  const digest = overlayDigest(overlays, "f".repeat(64));
  assert.notEqual(overlayDigest([{ ...overlays[0], target: "agent/tools/sh.ts" }, overlays[1]], "f".repeat(64)), digest);
  assert.notEqual(overlayDigest(overlays, "0".repeat(64)), digest);
  assert.throws(() => parseOverlayLines("b tool remove agent/tools/bash.ts"), /exactly/);
  assert.throws(() => parseOverlayLines("b tool remove agent/tools/bash.ts x - - -"), /removal carries no source/);
  assert.throws(() => parseOverlayLines("s skill append agent/skills/s repo - . hash"), /needs a source commit/);
});
