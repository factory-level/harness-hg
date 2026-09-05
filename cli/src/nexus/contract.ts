// Loading + validation of authored Nexus dashboard declarations (design 11,
// ADR-42). Pure filesystem reads - no cluster, no state.json, and NOTHING
// from the repository is ever executed. The published schemas ARE the
// runtime validators (the topology/contract.ts pattern), and the declared
// cron/config facts extracted here are the WHOLE allowlist: name and
// schedule for crons, provider/model/platforms/counts for configuration.
// Prompts, tokens and raw documents never leave this module.

import * as fs from "node:fs";
import { agentLayout } from "../layout.ts";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv/dist/2020";
import { CONTRACTS_ROOT, PLATFORM_ROOT } from "../lib.ts";
import type { ValidationFinding } from "../platform/index.ts";
import { discoverContractDirs, schemaErrorLines } from "../topology/contract.ts";

const DASH_SCHEMA_ROOT = path.join(CONTRACTS_ROOT, "dashboard-contribution");

// strictTypes off (the topology/contract.ts precedent): the published
// schemas compose `required`/`minItems` inside if/then and anyOf branches
// without re-stating `type`, which Ajv's strict mode flags harmlessly.
// The schemas are frozen; the validator setting is ours.
const ajv = new Ajv2020({ allErrors: true, strictTypes: false });
function compileSchema(file: string): ValidateFunction {
  return ajv.compile(JSON.parse(fs.readFileSync(file, "utf8")));
}
// Version dispatch on the authored apiVersion (the contractVersion
// precedent): v1alpha1 files keep validating - and compiling - exactly
// as before; v1alpha2 adds component links (ADR-43).
const DASH_VERSIONS = ["v1alpha1", "v1alpha2"] as const;
const validators: Record<string, { contribution: ValidateFunction; view: ValidateFunction }> =
  Object.fromEntries(
    DASH_VERSIONS.map((v) => [
      v,
      {
        contribution: compileSchema(path.join(DASH_SCHEMA_ROOT, v, "contribution.schema.json")),
        view: compileSchema(path.join(DASH_SCHEMA_ROOT, v, "view.schema.json")),
      },
    ]),
  );

function versionOf(doc: unknown): (typeof DASH_VERSIONS)[number] {
  // Full-string match (never a suffix): anything that is not exactly the
  // v1alpha2 apiVersion validates as v1alpha1, whose `const` then rejects
  // wrong or foreign versions loudly - fail closed either way.
  const api = (doc as { apiVersion?: unknown } | null)?.apiVersion;
  return api === "dashboard.hermes-gitops/v1alpha2" ? "v1alpha2" : "v1alpha1";
}

// ---------------------------------------------------------------------------
// Authored shapes (mirrors of the published v1alpha1 schemas)

export interface ComponentDecl {
  id: string;
  kind: "agent" | "application";
  title: string;
  description?: string;
  bind: { profile: string; app?: string };
  links?: { repository?: string; docs?: string; runbook?: string };
  display?: { icon?: string; providerBadge?: boolean };
  details?: {
    showCrons?: boolean;
    showConfigSummary?: boolean;
    showAccessors?: boolean;
    showArgoCd?: boolean;
    endpointNames?: string[];
  };
  observability?: { grafanaDashboard?: string };
}

export interface PersonDecl {
  id: string;
  displayName: string;
  title?: string;
  cohorts?: string[];
  accessors?: string[];
}

export interface GroupDecl {
  id: string;
  title: string;
  kind?: "department" | "team" | "system";
}

export interface RelationshipDecl {
  id: string;
  from: string;
  to: string;
  label: string;
}

export interface ContributionDoc {
  apiVersion: string;
  kind: "NexusContribution";
  metadata: { id: string; title: string; description?: string };
  spec: {
    components?: ComponentDecl[];
    people?: PersonDecl[];
    groups?: GroupDecl[];
    relationships?: RelationshipDecl[];
  };
}

export interface ViewNodeDecl {
  ref: string;
  position: { x: number; y: number };
  parent?: string;
}

export interface ViewDoc {
  apiVersion: string;
  kind: "NexusView";
  metadata: { id: string; title?: string };
  spec: {
    nodes: ViewNodeDecl[];
    viewport?: { x: number; y: number; zoom: number };
  };
}

export interface DashboardFile<T> {
  relPath: string; // repository-relative, forward slashes
  doc: T;
}

/** The compile-time allowlist extracted from a profile's declared files.
 * Everything here is display-safe by construction - see module header. */
export interface DeclaredProfileFacts {
  crons: { name: string; schedule: string }[];
  config?: {
    profile: string;
    modelProvider?: string;
    model?: string;
    platforms?: string[];
    skillCount?: number;
    cronCount?: number;
  };
}

export interface DashboardLoadResult {
  contributions: DashboardFile<ContributionDoc>[];
  views: DashboardFile<ViewDoc>[];
  icons: IconAsset[];
  declared: Record<string, DeclaredProfileFacts>;
  findings: ValidationFinding[];
}

/** A repository-owned icon asset (design 12): a bounded PNG/WebP under a
 * dashboard/icons/ directory whose filename stem names the component,
 * person or group it faces. Bytes ride along so emit can copy them into
 * the generated tree without re-reading the repo. */
export interface IconAsset {
  relPath: string;
  stem: string;
  ext: ".png" | ".webp";
  bytes: Buffer;
}

const ICON_MAX_BYTES = 256 * 1024;

/** The emitter's symlink ancestor probe, mirrored for the CLI: the
 * refusal message when *rel* is (or sits under) a symlink, else null. */
function symlinkOnPath(root: string, rel: string): string | null {
  let probe = "";
  for (const segment of rel.split(path.sep)) {
    probe = probe ? path.join(probe, segment) : segment;
    if (fs.lstatSync(path.join(root, probe)).isSymbolicLink()) {
      return `${rel}: is (or sits under) a symlink - refusing to read it`;
    }
  }
  return null;
}

/** Same gate as the emitter's _validate_icon_asset (two-language parity):
 * .png/.webp extension, matching magic bytes, bounded size. Returns the
 * refusal message, or null when the asset is genuine. */
export function iconAssetError(relPath: string, bytes: Buffer): string | null {
  const ext = path.extname(relPath);
  if (ext !== ".png" && ext !== ".webp") {
    return `${relPath}: icon assets must be .png or .webp; got ${ext || "no extension"}`;
  }
  const genuine =
    ext === ".png"
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  if (!genuine) return `${relPath}: content does not match its ${ext} extension`;
  if (bytes.length > ICON_MAX_BYTES) {
    return `${relPath}: icon asset is ${bytes.length} bytes; the limit is ${ICON_MAX_BYTES}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Discovery + validation

function readYaml(file: string): unknown {
  return parseYaml(fs.readFileSync(file, "utf8"));
}

/** Every authored dashboard file of a repository, repo-relative:
 * `dashboard/contribution.yaml`, `dashboard/views/<view>.yaml`, and each
 * profile's `<subdir>/dashboard/components.yaml`. */
export function discoverDashboardFiles(root: string): {
  contributions: string[];
  views: string[];
  icons: string[];
} {
  const contributions: string[] = [];
  const views: string[] = [];
  const icons: string[] = [];
  const collectIcons = (dirRel: string) => {
    const abs = path.join(root, dirRel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs).sort()) {
      // lstat, not stat: symlinks are surfaced so the loader can refuse
      // them (emitter parity) instead of silently copying their target.
      const st = fs.lstatSync(path.join(abs, entry));
      if (st.isFile() || st.isSymbolicLink()) icons.push(path.join(dirRel, entry));
    }
  };
  if (fs.existsSync(path.join(root, "dashboard", "contribution.yaml"))) {
    contributions.push(path.join("dashboard", "contribution.yaml"));
  }
  const viewsDir = path.join(root, "dashboard", "views");
  if (fs.existsSync(viewsDir)) {
    for (const entry of fs.readdirSync(viewsDir).sort()) {
      if (entry.endsWith(".yaml")) views.push(path.join("dashboard", "views", entry));
    }
  }
  collectIcons(path.join("dashboard", "icons"));
  let profileDirs: { dir: string; subdir: string }[] = [];
  try {
    profileDirs = discoverContractDirs(root);
  } catch {
    // Not a profile catalogue - repo-level dashboard files alone are fine.
  }
  for (const { dir } of profileDirs) {
    const layout = agentLayout(dir);
    const rel = path.relative(root, layout.dashboardFile);
    if (fs.existsSync(layout.dashboardFile)) contributions.push(rel);
    collectIcons(path.relative(root, layout.iconsDir));
  }
  return { contributions, views, icons };
}

function cronFacts(dir: string): { name: string; schedule: string }[] {
  const cronDir = path.join(dir, "cron");
  if (!fs.existsSync(cronDir)) return [];
  const out: { name: string; schedule: string }[] = [];
  for (const entry of fs.readdirSync(cronDir).sort()) {
    if (!entry.endsWith(".yaml")) continue;
    const doc = readYaml(path.join(cronDir, entry)) as { name?: string; schedule?: string } | null;
    // Name and schedule are the whole allowlist - prompt/skills stay behind.
    if (doc?.name && doc?.schedule) out.push({ name: doc.name, schedule: String(doc.schedule) });
  }
  return out;
}

function configFacts(dir: string, profile: string, cronCount: number): DeclaredProfileFacts["config"] {
  const file = path.join(dir, "config.yaml");
  if (!fs.existsSync(file)) return { profile, cronCount };
  const doc = readYaml(file) as {
    model?: { provider?: string; name?: string };
    platforms?: Record<string, { enabled?: boolean } | null>;
  } | null;
  const platforms = Object.entries(doc?.platforms ?? {})
    .filter(([, v]) => v?.enabled === true)
    .map(([k]) => k)
    .sort();
  const skillsDir = path.join(dir, "skills");
  const skillCount = fs.existsSync(skillsDir)
    ? fs.readdirSync(skillsDir).filter((e) => fs.statSync(path.join(skillsDir, e)).isDirectory()).length
    : 0;
  return {
    profile,
    modelProvider: doc?.model?.provider,
    model: doc?.model?.name,
    platforms: platforms.length > 0 ? platforms : undefined,
    skillCount,
    cronCount,
  };
}

/** Load and validate every authored dashboard file plus the declared
 * cron/config allowlist facts per profile. Schema violations become
 * findings, not throws - every broken file reports at once. */
export function loadDashboard(root: string): DashboardLoadResult {
  const findings: ValidationFinding[] = [];
  const found = discoverDashboardFiles(root);
  const contributions: DashboardFile<ContributionDoc>[] = [];
  const views: DashboardFile<ViewDoc>[] = [];

  for (const rel of found.contributions) {
    const doc = readYaml(path.join(root, rel));
    const version = versionOf(doc);
    const validateContribution = validators[version].contribution;
    if (validateContribution(doc)) {
      contributions.push({ relPath: rel, doc: doc as ContributionDoc });
    } else {
      for (const line of schemaErrorLines(rel, validateContribution.errors)) {
        findings.push({
          profile: rel,
          severity: "error",
          check: "NEXUS000",
          message: line,
          file: rel,
          fix: `make the file validate against dashboard-contribution/${version}/contribution.schema.json`,
        });
      }
    }
  }
  for (const rel of found.views) {
    const doc = readYaml(path.join(root, rel));
    const version = versionOf(doc);
    const validateView = validators[version].view;
    if (validateView(doc)) {
      views.push({ relPath: rel, doc: doc as ViewDoc });
    } else {
      for (const line of schemaErrorLines(rel, validateView.errors)) {
        findings.push({
          profile: rel,
          severity: "error",
          check: "NEXUS000",
          message: line,
          file: rel,
          fix: `make the file validate against dashboard-contribution/${version}/view.schema.json`,
        });
      }
    }
  }

  const icons: IconAsset[] = [];
  for (const rel of found.icons) {
    // The emitter's ancestor probe, mirrored: a symlink anywhere on the
    // path could pull operator files into the GitOps tree.
    const linkRefusal = symlinkOnPath(root, rel);
    const bytes = linkRefusal === null ? fs.readFileSync(path.join(root, rel)) : Buffer.alloc(0);
    const refusal = linkRefusal ?? iconAssetError(rel, bytes);
    if (refusal) {
      findings.push({
        profile: rel,
        severity: "error",
        check: "NEXUS010",
        message: refusal,
        file: rel,
        fix: "ship a genuine .png or .webp under 256KiB, or remove the file",
      });
      continue;
    }
    const ext = path.extname(rel) as IconAsset["ext"];
    icons.push({ relPath: rel, stem: path.basename(rel, ext), ext, bytes });
  }

  const declared: Record<string, DeclaredProfileFacts> = {};
  let profileDirs: { dir: string; subdir: string }[] = [];
  try {
    profileDirs = discoverContractDirs(root);
  } catch {
    // No profiles - contributions can still bind another catalogue's plan.
  }
  for (const { dir } of profileDirs) {
    // Eve projects (ADR-149) have no distribution.yaml and declare no
    // Hermes cron/config facts - nothing to read here.
    if (!fs.existsSync(path.join(dir, "distribution.yaml"))) continue;
    const manifest = readYaml(path.join(dir, "distribution.yaml")) as { name?: string } | null;
    if (!manifest?.name) continue;
    const crons = cronFacts(dir);
    declared[manifest.name] = { crons, config: configFacts(dir, manifest.name, crons.length) };
  }

  return { contributions, views, icons, declared, findings };
}
