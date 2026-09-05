// hg nexus emit: materialize the compiled Nexus plan as the generated
// dashboard tree (design 11, ADR-42) - deployments/control-plane/nexus-plan.json.
// The ONLY file-writing module in cli/src/nexus/, and it reuses the
// topology emitter's whole write discipline (writeTree): build in memory,
// refuse before any write on plan errors, byte-compare, prune only the
// nexus-managed tree, symlink refusal. Its inputs hash is its OWN -
// independent of the topology plan's - so dashboard staleness is
// detectable without implying topology staleness.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { inputsHash as topologyInputsHash } from "../topology/emit.ts";
import { discoverDashboardFiles } from "./contract.ts";
import type { IconAsset } from "./contract.ts";
import type { NexusPlanDoc } from "./compile.ts";

export const NEXUS_MANAGED_TREES = ["deployments/dashboard"];
export const NEXUS_PLAN_PATH = "deployments/control-plane/nexus-plan.json";
export const NEXUS_ICONS_DIR = "deployments/dashboard/assets/icons";
export const NEXUS_AVATARS_DIR = "deployments/dashboard/assets/avatars";
export const NEXUS_FONTS_DIR = "deployments/dashboard/assets/fonts";

/** One brand face (#435, ADR-105): a woff2 file the stylesheet references
 * by absolute route. Same ride as the avatar inventory - the chart cannot
 * carry binaries. */
export interface FontAsset {
  name: string;
  bytes: Buffer;
}

/** The platform's font inventory. Shape gates only, like
 * loadAvatarInventory: woff2 extension, id-shaped stem, symlink refusal;
 * bytes are validated by the pytest sweep and font_asset_error at serve. */
export function loadFontInventory(dir: string): FontAsset[] {
  if (!fs.existsSync(dir)) return [];
  const out: FontAsset[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (path.extname(name) !== ".woff2") continue;
    if (!AVATAR_ID_RE.test(path.basename(name, ".woff2"))) continue;
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isSymbolicLink() || !fs.statSync(p).isFile()) continue;
    out.push({ name, bytes: fs.readFileSync(p) });
  }
  return out;
}

/** One platform avatar (#426), keyed by the id an agent's display.icon
 * declaration selects. */
export interface AvatarAsset {
  id: string;
  ext: string;
  bytes: Buffer;
}

const AVATAR_ID_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The platform's avatar inventory, read from the given directory. Shape
 * gates only (extension, id pattern, symlink refusal): the BYTES are
 * platform-owned and validated twice elsewhere - the pytest inventory
 * sweep at commit time and plugin_api's avatar_asset_error at serve
 * time - so a third parser here would be drift surface, not safety. */
export function loadAvatarInventory(dir: string): AvatarAsset[] {
  if (!fs.existsSync(dir)) return [];
  const out: AvatarAsset[] = [];
  const seen = new Set<string>();
  for (const name of fs.readdirSync(dir).sort()) {
    const ext = path.extname(name);
    if (ext !== ".gif" && ext !== ".webp") continue;
    const id = path.basename(name, ext);
    // One id, one asset - .gif sorts first, matching the serve route's
    // preference, so a stray sibling .webp never forks the identity.
    if (!AVATAR_ID_RE.test(id) || seen.has(id)) continue;
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isSymbolicLink() || !fs.statSync(p).isFile()) continue;
    seen.add(id);
    out.push({ id, ext, bytes: fs.readFileSync(p) });
  }
  return out;
}

/** The ids an agent may actually choose (#426 beta pass, spec §15/16).
 * `<bot>-still` rides the SAME inventory directory - it must, so the
 * emitted tree carries it - but it is reduced-motion machinery, not a
 * selectable identity: AgentAvatar derives it by appending "-still" to
 * a chosen code, so letting someone pick "bot-nova-still" itself would
 * have reduced motion request "bot-nova-still-still" and 404. */
export function selectableAvatarIds(inventory: AvatarAsset[]): string[] {
  return inventory.filter((a) => !a.id.endsWith("-still")).map((a) => a.id);
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** The nexus plan's staleness hash: every authored dashboard file, the
 * optional workload-endpoints file, and the topology inputs hash (the
 * plan is a join - a topology change changes the join). */
export function nexusInputsHash(
  root: string,
  opts: {
    environmentSource?: string;
    workloadEndpointsFile?: string;
    avatarAssets?: AvatarAsset[];
    fontAssets?: FontAsset[];
  } = {},
): string {
  const parts: string[] = [];
  const found = discoverDashboardFiles(root);
  for (const rel of [...found.contributions, ...found.views].sort()) {
    parts.push(`${rel}\n${fs.readFileSync(path.join(root, rel), "utf8")}`);
  }
  for (const rel of [...found.icons].sort()) {
    // Hash of the bytes, not the bytes: assets are binary and only their
    // identity matters to staleness.
    parts.push(`${rel}\n${crypto.createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex")}`);
  }
  if (opts.workloadEndpointsFile && fs.existsSync(opts.workloadEndpointsFile)) {
    parts.push(`workload-endpoints\n${fs.readFileSync(opts.workloadEndpointsFile, "utf8")}`);
  }
  for (const a of opts.avatarAssets ?? []) {
    // Platform inventory, not repo content - but it rides the emitted
    // tree, so a swapped asset must read as stale.
    parts.push(`avatar:${a.id}${a.ext}\n${crypto.createHash("sha256").update(a.bytes).digest("hex")}`);
  }
  for (const f of opts.fontAssets ?? []) {
    parts.push(`font:${f.name}\n${crypto.createHash("sha256").update(f.bytes).digest("hex")}`);
  }
  parts.push(`topology\n${topologyInputsHash(root, opts.environmentSource)}`);
  return sha256(parts.sort().join("\x00"));
}

/** Stable JSON for the generated plan: the compiler already sorts every
 * list; two-space indent + trailing newline is the whole serialization.
 * Icon assets ride beside it as `assets/icons/<id>.<ext>` - files, not
 * plan fields, so the frozen dashboard-plan schemas stay untouched. */
export function renderNexusTree(
  plan: NexusPlanDoc,
  icons: IconAsset[] = [],
  avatars: AvatarAsset[] = [],
  fonts: FontAsset[] = [],
): Map<string, string | Buffer> {
  const tree = new Map<string, string | Buffer>([[NEXUS_PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`]]);
  for (const icon of icons) {
    tree.set(`${NEXUS_ICONS_DIR}/${icon.stem}${icon.ext}`, icon.bytes);
  }
  // Referenced-ids-only (the ADR-104 deferral, executed): brand art took
  // the per-avatar weight from ~3KB to ~200KB, so the full inventory would
  // put megabytes in every emit. Only ids that an agent component actually
  // wears ride the tree, plus their `-still` twins (reduced-motion and the
  // still-surface prop derive the twin name client-side). Switching an
  // avatar already requires a re-emit - the plan carries the code - so
  // this narrows bytes, not workflows. The emitted gallery lists the
  // referenced set only.
  const worn = new Set<string>();
  for (const c of plan.components) {
    // Agents AND applications wear inventory art (tool tiles, ADR-146
    // follow-up); human/group components never render an avatar.
    if ((c.kind === "agent" || c.kind === "application") && c.icon) {
      worn.add(c.icon);
      worn.add(`${c.icon}-still`);
    }
  }
  for (const a of avatars) {
    if (!worn.has(a.id)) continue;
    tree.set(`${NEXUS_AVATARS_DIR}/${a.id}${a.ext}`, a.bytes);
  }
  for (const f of fonts) {
    // The brand faces (#435): the stylesheet references these by absolute
    // route, so the pod (and the host) serve them from the same repo the
    // plan rides in - the chart's release Secret never grows.
    tree.set(`${NEXUS_FONTS_DIR}/${f.name}`, f.bytes);
  }
  return tree;
}

/** True when the repository authors any dashboard file - an emit against
 * a repo with none would only ever produce an empty canvas, which is a
 * usage error, not a plan. */
export function hasDashboardFiles(root: string): boolean {
  const found = discoverDashboardFiles(root);
  return found.contributions.length > 0 || found.views.length > 0;
}

/** Load the ADR-40 workload-endpoints join input: a YAML/JSON map of
 * "<profile>/<app>" -> { hostname }. Operator/stack data supplied as a
 * file - never read from the repository being compiled. */
export function loadWorkloadEndpoints(file: string): Record<string, { hostname: string }> {
  const doc = parseYaml(fs.readFileSync(file, "utf8")) as Record<string, { hostname?: string } | string>;
  const out: Record<string, { hostname: string }> = {};
  for (const [key, value] of Object.entries(doc ?? {})) {
    const hostname = typeof value === "string" ? value : value?.hostname;
    if (typeof hostname === "string") out[key] = { hostname };
  }
  return out;
}
