// Operator overlays (ADR 0194): the ONE merge implementation. The eve charts'
// build container runs it before `eve build` (files/boot.sh); `hg team` imports
// the same file to preflight the merged tree. Dependency-free Node, because it
// runs from the boot ConfigMap on the eve-runtime image.
//
//   node overlay-apply.mjs <project-dir> <content-root>
//
// Reads EVE_OVERLAYS - one "id kind mode target repository commit path
// contentHash" line per overlay, "-" for the fields a removal does not carry -
// plus EVE_OVERLAY_TREE_HASH and, when set, EVE_OVERLAY_DIGEST. The content of
// overlay <id> is <content-root>/<id>/<path>. Any refusal exits non-zero with
// the reason; the caller discards the partially merged tree.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DISABLE_TOOL_STUB = 'import { disableTool } from "eve/tools";\n\nexport default disableTool();\n';
const KINDS = new Set(["skill", "tool", "connection", "instructions", "file"]);
const MODES = new Set(["append", "override", "remove"]);
const PROTECTED_PARTS = new Set(["package.json", "package-lock.json", "node_modules", ".eve", ".output", ".git"]);
const KIND_TARGETS = {
  skill: /^agent\/skills\/[A-Za-z0-9_-]+(\.md)?$/,
  tool: /^agent\/tools\/[A-Za-z0-9._-]+\.(ts|js|mjs)$/,
  connection: /^agent\/connections\/[A-Za-z0-9._-]+\.(ts|js|mjs)$/,
  instructions: /^agent\/instructions\.md$/,
};

export class OverlayError extends Error {}
const fail = (message) => { throw new OverlayError(message); };
const exists = (target) => { try { fs.lstatSync(target); return true; } catch { return false; } };

/** Every regular file under root as sorted relative paths; symlinks, special files and .git refuse. */
export function packageFiles(root) {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail(`${path.relative(root, full)}: overlay content and agent trees hold regular files only, never symlinks`);
      if (entry.name === ".git") fail("Git metadata is never overlay content");
      if (entry.isDirectory()) visit(full);
      else files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

function hashFile(hash, name, bytes) {
  const nameBytes = Buffer.from(name, "utf8");
  hash.update(`${nameBytes.length}:`).update(nameBytes).update(`${bytes.length}:`).update(bytes);
}

/** The overlay content hash: SHA-256 over every regular file in sorted relative-path order, each
 * as the byte length and bytes of its path, then the byte length and bytes of its contents - an
 * unambiguous encoding. A single file is a package of one file named by its basename. */
export function contentHash(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail("overlay content must be a regular file or directory, never symlinks");
  const hash = createHash("sha256");
  if (stat.isFile()) {
    hashFile(hash, path.basename(target), fs.readFileSync(target));
    return hash.digest("hex");
  }
  if (!stat.isDirectory()) fail("overlay content must be a regular file or a directory");
  for (const file of packageFiles(target)) hashFile(hash, file, fs.readFileSync(path.join(target, file)));
  return hash.digest("hex");
}

/** Where an overlay's fetched content lives inside its checkout, refusing any symlink on the way:
 * the pinned commit must bind where the bytes came from, not only what they are. */
export function contentPath(checkout, o) {
  if (o.source.path === ".") return checkout;
  let at = checkout;
  for (const part of o.source.path.split("/")) {
    at = path.join(at, part);
    if (!exists(at)) fail(`overlay ${o.id}: ${o.source.path} is absent at ${o.source.commit.slice(0, 12)}`);
    if (fs.lstatSync(at).isSymbolicLink()) fail(`overlay ${o.id}: ${o.source.path} passes through a symlink in its repository`);
  }
  return at;
}

export function overlayLines(overlays) {
  return overlays.map(o => [o.id, o.kind, o.mode, o.target, o.source?.repository ?? "-", o.source?.commit ?? "-", o.source?.path ?? "-", o.contentHash ?? "-"].join(" ")).join("\n");
}

/** What the chart renders as EVE_OVERLAY_DIGEST: sha256 of the lines, a newline, the tree hash. */
export function overlayDigest(overlays, treeHash) {
  return createHash("sha256").update(`${overlayLines(overlays)}\n${treeHash}`).digest("hex");
}

export function parseOverlayLines(text) {
  const overlays = [];
  for (const line of (text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split(" ");
    if (fields.length !== 8 || fields.some(field => !field)) fail("EVE_OVERLAYS lines carry exactly: id kind mode target repository commit path contentHash");
    const [id, kind, mode, target, repository, commit, sourcePath, hash] = fields;
    const sourceFields = [repository, commit, sourcePath, hash];
    if (mode === "remove") {
      if (sourceFields.some(field => field !== "-")) fail(`overlay ${id}: a removal carries no source`);
      overlays.push({ id, kind, mode, target });
    } else {
      if (sourceFields.includes("-")) fail(`overlay ${id}: needs a source commit and content hash`);
      overlays.push({ id, kind, mode, target, source: { repository, commit, path: sourcePath }, contentHash: hash });
    }
  }
  return overlays;
}

function validateEntry(o, seen) {
  if (typeof o.id !== "string" || !/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(o.id) || o.id.length > 40) fail(`overlay id ${JSON.stringify(o.id)} must be a DNS label`);
  if (seen.has(o.id)) fail(`overlay ${o.id} appears twice`);
  seen.add(o.id);
  if (!KINDS.has(o.kind)) fail(`overlay ${o.id}: unknown kind ${JSON.stringify(o.kind)}`);
  if (!MODES.has(o.mode)) fail(`overlay ${o.id}: unknown mode ${JSON.stringify(o.mode)}`);
  const target = o.target;
  const parts = typeof target === "string" ? target.split("/") : [];
  if (parts[0] !== "agent" || parts.length < 2 || parts.some(part => !part || part === "." || part === "..") || /[\s\\\0]/.test(target)) fail(`overlay ${o.id}: target must be a normalized path under agent/`);
  if (parts.some(part => PROTECTED_PARTS.has(part))) fail(`overlay ${o.id}: package files, node_modules, .eve, .output and .git are never overlay targets`);
  if (/^agent\/(agent|sandbox)\.(ts|js|mjs)$/.test(target) || /^agent\/channels(\/|$)/.test(target)) fail(`overlay ${o.id}: the agent definition, sandbox and channels are never overlay targets`);
  if (KIND_TARGETS[o.kind] && !KIND_TARGETS[o.kind].test(target)) fail(`overlay ${o.id}: a ${o.kind} overlay cannot target ${target}`);
  if (o.kind === "file") {
    if (/^agent\/(instructions\.md$|skills(\/|$))/.test(target)) fail(`overlay ${o.id}: file overlays never target skills or instructions`);
    if (/^agent\/(tools|connections)(\/|$)/.test(target) && o.mode !== "remove") fail(`overlay ${o.id}: at or below tools/ and connections/ a file overlay may only remove`);
  }
  if (o.kind === "instructions" && o.mode === "remove") fail(`overlay ${o.id}: instructions are never removed`);
  if (o.mode === "remove") {
    if (o.source || o.contentHash) fail(`overlay ${o.id}: a removal carries no source`);
    return;
  }
  if (!o.source || !/^[0-9a-f]{40}$/.test(o.source.commit ?? "") || !/^[a-f0-9]{64}$/.test(o.contentHash ?? "")) fail(`overlay ${o.id}: needs a source commit and content hash`);
  const sourcePath = o.source.path;
  if (sourcePath !== "." && (typeof sourcePath !== "string" || sourcePath.startsWith("/") || sourcePath.split("/").some(part => !part || part === "." || part === ".." || part === ".git"))) fail(`overlay ${o.id}: source path must stay inside its repository`);
}

/** One writer per target; only instructions stack, as an optional override first, then appends. */
function validateWriters(overlays) {
  const writers = new Map();
  for (const o of overlays) writers.set(o.target, [...(writers.get(o.target) ?? []), o]);
  for (const [target, group] of writers) {
    if (group.length < 2) continue;
    const stacked = group.every(o => o.kind === "instructions") && group.slice(1).every(o => o.mode === "append");
    if (!stacked) fail(`target ${target} is written by overlays ${group.map(o => o.id).join(", ")} - one overlay per target; only instructions stack (an optional override first, then appends)`);
  }
}

/** Existing files that are the same Eve resource as the target, in any form it can take. */
function sameResource(project, o) {
  if (o.kind === "skill") {
    const base = o.target.replace(/\.md$/, "");
    return [base, `${base}.md`, `${base}.ts`, `${base}.js`, `${base}.mjs`].filter(candidate => exists(path.join(project, candidate)));
  }
  if (o.kind === "tool" || o.kind === "connection") {
    const base = o.target.replace(/\.(ts|js|mjs)$/, "");
    return [`${base}.ts`, `${base}.js`, `${base}.mjs`].filter(candidate => exists(path.join(project, candidate)));
  }
  return exists(path.join(project, o.target)) ? [o.target] : [];
}

/**
 * Apply overlays to an Eve project in order. `contentFor(overlay)` names the fetched content for
 * every non-removal. `protectedSkills` names skills the source's skill manifest owns, which an
 * overlay may not override or remove. Returns the merged agent/ tree hash; when `treeHash` is
 * given, a different merged tree refuses.
 *
 * No symlink is followed on a target path: it is checked before content is read and again right
 * before every write. The checks and writes are separate pathname operations, so a process that
 * can change the agent tree while this runs can still misdirect a write outside it; the trust
 * boundary is whoever can write the data volume during the build.
 */
export function applyOverlays({ project, overlays, contentFor, treeHash, protectedSkills = [] }) {
  const agentRoot = path.join(project, "agent");
  if (!exists(agentRoot) || fs.lstatSync(agentRoot).isSymbolicLink() || !fs.lstatSync(agentRoot).isDirectory()) fail("the project has no agent/ directory, or it is a symlink");
  const agentReal = fs.realpathSync(agentRoot);
  const guard = (o) => {
    let at = project;
    for (const part of o.target.split("/")) {
      at = path.join(at, part);
      if (!exists(at)) break;
      if (fs.lstatSync(at).isSymbolicLink()) fail(`${o.target}: the agent tree has a symlink on the overlay path`);
    }
    const parent = path.dirname(path.join(project, o.target));
    if (exists(parent)) {
      const real = fs.realpathSync(parent);
      if (real !== agentReal && !real.startsWith(`${agentReal}${path.sep}`)) fail(`${o.target}: resolves outside agent/`);
    }
  };
  const seen = new Set();
  for (const o of overlays) validateEntry(o, seen);
  validateWriters(overlays);
  for (const o of overlays) {
    guard(o);
    const destination = path.join(project, o.target);
    const skillName = o.kind === "skill" ? path.basename(o.target).replace(/\.md$/, "") : undefined;
    if (skillName && o.mode !== "append" && protectedSkills.includes(skillName)) fail(`overlay ${o.id}: skill ${skillName} is owned by the source's skill manifest; change it in source with hg skills update`);
    let content;
    if (o.mode !== "remove") {
      content = contentFor(o);
      if (!content || !exists(content)) fail(`overlay ${o.id}: ${o.source.path} is absent at ${o.source.commit.slice(0, 12)}`);
      const actual = contentHash(content);
      if (actual !== o.contentHash) fail(`overlay ${o.id}: ${o.source.path} at ${o.source.commit.slice(0, 12)} hashes ${actual.slice(0, 12)}, the record pins ${o.contentHash.slice(0, 12)}; the upstream was rewritten or the record is stale - plan again and re-approve`);
    }
    if (o.kind === "instructions") {
      if (!exists(destination) || !fs.lstatSync(destination).isFile()) fail(`overlay ${o.id}: agent/instructions.md must exist - an instructions.ts agent takes no instruction overlays`);
      if (!fs.lstatSync(content).isFile()) fail(`overlay ${o.id}: instructions content must be one markdown file`);
      const text = fs.readFileSync(content, "utf8");
      guard(o);
      if (o.mode === "override") {
        fs.writeFileSync(destination, text);
      } else {
        let base = fs.readFileSync(destination, "utf8");
        if (base && !base.endsWith("\n")) base += "\n";
        const body = !text || text.endsWith("\n") ? text : `${text}\n`;
        fs.writeFileSync(destination, `${base}\n<!-- harness-hg overlay ${o.id} ${o.source.commit} sha256:${o.contentHash} -->\n${body}`);
      }
      continue;
    }
    const present = sameResource(project, o);
    if (o.kind === "tool" && o.mode === "remove") {
      // Deleting the file would bring the framework tool back: disable it instead, replacing any
      // authored form of the same slug.
      guard(o);
      for (const existing of present) fs.rmSync(path.join(project, existing), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      guard(o);
      fs.writeFileSync(destination, DISABLE_TOOL_STUB);
      continue;
    }
    if (o.mode === "append" && present.length) fail(`overlay ${o.id}: append needs ${o.target} to be absent, found ${present.join(", ")}`);
    if (o.mode !== "append") {
      if (!exists(destination)) fail(`overlay ${o.id}: ${o.mode} needs ${o.target} to exist`);
      const others = present.filter(existing => existing !== o.target);
      if (others.length) fail(`overlay ${o.id}: ${o.target} also exists in another form (${others.join(", ")})`);
    }
    let isDirectory = false;
    if (o.mode !== "remove") {
      isDirectory = fs.lstatSync(content).isDirectory();
      if (o.kind === "skill" && o.target.endsWith(".md") === isDirectory) fail(`overlay ${o.id}: a skills/<name>.md target takes one file, a skills/<name> target a package directory`);
      if (o.kind === "skill" && isDirectory && !exists(path.join(content, "SKILL.md"))) fail(`overlay ${o.id}: a skill package needs SKILL.md at its root`);
      if ((o.kind === "tool" || o.kind === "connection") && isDirectory) fail(`overlay ${o.id}: a ${o.kind} overlay takes one file`);
      if (isDirectory) {
        const forbidden = packageFiles(content).find(entry => entry.split("/").some(part => PROTECTED_PARTS.has(part)));
        if (forbidden) fail(`overlay ${o.id}: its content carries ${forbidden}; package files, node_modules, .eve, .output and .git never arrive through an overlay`);
      }
    }
    guard(o);
    if (o.mode !== "append") fs.rmSync(destination, { recursive: true, force: true });
    if (o.mode === "remove") continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    guard(o);
    if (isDirectory) fs.cpSync(content, destination, { recursive: true, errorOnExist: true, force: false });
    else fs.copyFileSync(content, destination, fs.constants.COPYFILE_EXCL);
  }
  const merged = contentHash(agentRoot);
  if (treeHash && merged !== treeHash) fail(`merged agent/ tree hashes ${merged.slice(0, 12)}, the record pins ${treeHash.slice(0, 12)}; the source or overlays changed after planning - plan again`);
  return { treeHash: merged };
}

function main() {
  const [project, contentRoot] = process.argv.slice(2);
  if (!project || !contentRoot) fail("usage: node overlay-apply.mjs <project-dir> <content-root>");
  const overlays = parseOverlayLines(process.env.EVE_OVERLAYS);
  const treeHash = process.env.EVE_OVERLAY_TREE_HASH ?? "";
  if (!overlays.length) fail("EVE_OVERLAYS names no overlays");
  if (!/^[a-f0-9]{64}$/.test(treeHash)) fail("EVE_OVERLAY_TREE_HASH must be a SHA-256");
  if (process.env.EVE_OVERLAY_DIGEST && process.env.EVE_OVERLAY_DIGEST !== overlayDigest(overlays, treeHash)) fail("EVE_OVERLAY_DIGEST does not match the overlays it names");
  applyOverlays({ project, overlays, treeHash, contentFor: o => contentPath(path.join(contentRoot, o.id), o) });
  for (const o of overlays) console.log(`[build-agent] overlay ${o.id}: ${o.mode} ${o.target}`);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) {
    console.error(`[build-agent] ${error instanceof OverlayError ? error.message : `overlay apply failed (${error?.code ?? error?.constructor?.name ?? "error"})`}`);
    process.exit(1);
  }
}
