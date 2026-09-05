// Bootstrap stage 1 — install the Hermes fork CLI and the gitops-emitter
// plugin, then enable + configure the plugin in the operating profile.
//
// "Operating profile" is whatever HERMES_HOME resolves to for the process
// actually running these commands (unset -> the fork's own default,
// ~/.hermes) — this program deliberately does not manage a `hermesHome`
// stack config key of its own; every local.Command this component (and
// components/hermes-agent) creates inherits the ambient environment
// (@pulumi/command's `environment` is ADDITIONAL env vars, not a
// replacement), so exporting HERMES_HOME before `pulumi up` is all that's
// needed to point the whole bootstrap flow at an isolated profile home
// (see infra/scripts/verify-bootstrap-git-side.sh for exactly that).
//
// Two local.Command resources:
//
// 1. `hermes-cli-install` — `uv tool install` the fork (--editable for a
//    local-path source, a PEP 508 git+<url>[@ref] spec otherwise) with the
//    gitops-emitter package (this repo, or hermes.pluginPath if the
//    checkout lives elsewhere) pulled into the same tool venv via --with,
//    so importlib.metadata entry-point discovery finds it. Verifies the
//    install by resolving the installed `hermes` shim's own interpreter
//    (see RESOLVE_HERMES_PY_FN) and asserting gitops-emitter is registered
//    under the hermes_agent.plugins entry-point group. Idempotent: only
//    reruns (see triggers) when source/ref/pluginPath change; --force on
//    the `uv tool install` line itself is what makes that rerun actually
//    replace the prior install rather than no-op.
//
// 2. `hermes-profile-config` — a small idempotent script (run with the
//    installed tool's OWN Python, so it can rely on PyYAML being present
//    without adding a dependency to this Pulumi program) that merges
//    plugins.enabled + plugins.entries.gitops-emitter.* into the operating
//    profile's config.yaml (a yaml.safe_load/safe_dump round trip — every
//    other key survives, but comments/formatting are dropped, same as any
//    PyYAML round-trip), and upserts GITOPS_GIT_TOKEN=<secret> into the
//    profile's .env (preserving every other line) when a token is
//    configured.
//
// The config script reuses gitopsRepoUrl/gitopsBranch/hermesGitopsRepoUrl/
// chartRevision from the EXISTING top-level stack config rather than
// introducing parallel hermes.* keys for the same values — stage 3's
// root-app needs the exact same GitOps repo/branch the plugin pushes to,
// so one set of config keys drives both.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";
import { ConfigError, isGithubRepoUrl, type BootstrapConfig } from "../../../control-flow/config.ts";

// POSIX shell single-quote escaping (shlex.quote equivalent for the shapes
// this program feeds it: paths and PEP 508 specs).
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

// Extracts the venv python path out of a `uv tool install`-generated shim.
// uv emits ONE OF TWO shapes depending on how long the venv python path is
// (verified empirically against real `uv tool install --editable` shims,
// uv 0.11.27, against both a short and a long install path):
//
//   * Short enough for a shebang line (<~127 bytes on Linux): a plain
//     `#!/abs/path/to/tool/bin/python` shebang.
//   * Too long for a shebang line: a POSIX-portable polyglot instead
//     (a plain `#!/path/to/python` shebang would silently truncate/break):
//       #!/bin/sh
//       '''exec' '/abs/path/to/tool/bin/python' "$0" "$@"
//       ' '''
//       # -*- coding: utf-8 -*-
//       ...
//
// so this can't just always read line 1 (breaks on the polyglot form,
// where line 1 is the fixed `#!/bin/sh`) or always read line 2 (breaks on
// the plain-shebang form, where line 2 is unrelated file content) — it has
// to branch on which shape the actual shim uses.
export const RESOLVE_HERMES_PY_FN = `_resolve_hermes_py() {
    first_line="$(sed -n '1p' "$1")"
    if [ "$first_line" = '#!/bin/sh' ]; then
        sed -n '2p' "$1" | sed -E "s/^'''exec' '([^']+)'.*/\\1/"
    else
        case "$first_line" in
            '#!'*) rest="\${first_line#??}"; printf '%s\\n' "\${rest%% *}" ;;
            *) printf '' ;;
        esac
    fi
}`;

// Run with the installed tool's own Python (see RESOLVE_HERMES_PY_FN) so
// it can rely on PyYAML being present (a hard dependency of hermes-agent
// itself) without this Pulumi program needing its own copy. Verifies the
// gitops-emitter plugin is discoverable exactly the way the fork's
// PluginManager discovers pip/entry-point plugins (see hermes_cli/
// plugins.py's `_scan_entry_points` / ENTRY_POINTS_GROUP).
export const ENTRYPOINT_CHECK_PY = `import importlib
import importlib.metadata as m

# 1. Plugin discoverable: the gitops-emitter package is installed in this
#    venv and declares its entry point. Failure here means "plugin not
#    discoverable" - a --with/pluginPath problem, NOT a wrong hermes fork.
eps = sorted(e.name for e in m.entry_points(group='hermes_agent.plugins'))
assert 'gitops-emitter' in eps, (
    'plugin not discoverable: gitops-emitter entry point not found on the '
    'hermes_agent.plugins entry-point group; got ' + str(eps) + ' - check '
    'hermes.pluginPath points at the harness-hg repo'
)
print('hermes-gitops-bootstrap: gitops-emitter entry point resolved OK: ' + ', '.join(eps))

# 2. Host Hermes can FIRE the profile-lifecycle hooks (issue #2 [D1]):
#    entry-point discovery alone passes against ANY Hermes build - a
#    wrong-but-plausible hermes.source (e.g. upstream, not the
#    profile-hooks fork) would silently no-op every stage-2 install.
#    Prove the capability structurally: the fork's plugins module must
#    declare the three hooks in VALID_HOOKS, and its profile pipeline
#    must carry the fire helper that invokes them.
REQUIRED_HOOKS = ('profile_install', 'profile_update', 'profile_install_failed')
try:
    plugins_mod = importlib.import_module('hermes_cli.plugins')
except Exception as exc:
    raise SystemExit(
        'host Hermes cannot fire profile hooks: hermes_cli.plugins is not '
        'importable (' + repr(exc) + ') - hermes.source does not look like '
        'the hermes-agent-gitops fork'
    )
valid_hooks = getattr(plugins_mod, 'VALID_HOOKS', set()) or set()
missing = [h for h in REQUIRED_HOOKS if h not in valid_hooks]
assert not missing, (
    'host Hermes cannot fire profile hooks: VALID_HOOKS is missing '
    + ', '.join(missing)
    + ' - hermes.source points at a Hermes build without the '
    'profile-lifecycle hooks (use the hermes-agent-gitops fork)'
)
try:
    pd = importlib.import_module('hermes_cli.profile_distribution')
except Exception as exc:
    raise SystemExit(
        'host Hermes cannot fire profile hooks: hermes_cli.profile_distribution '
        'is not importable (' + repr(exc) + ')'
    )
assert hasattr(pd, '_fire_profile_lifecycle_hook'), (
    'host Hermes cannot fire profile hooks: profile_distribution has no '
    '_fire_profile_lifecycle_hook - the install/update pipeline of this '
    'Hermes build never invokes profile_install/profile_update'
)
print('hermes-gitops-bootstrap: host Hermes profile-hook capability verified '
      '(VALID_HOOKS + _fire_profile_lifecycle_hook present)')

# 3. This Hermes can ACTIVATE a distribution's declared cron jobs.
#    hermes profile install copies a distribution's cron/ directory onto the
#    profile, but the scheduler only ever reads cron/jobs.json - so without
#    'hermes cron sync' every shipped cron/<job>.yaml is a dead file. The
#    failure is silent: pods come up healthy and simply never run the work.
#
#    The host itself does not schedule anything (its profile is a throwaway
#    that exists to fire the emitter hook). It is checked here because it is
#    the SAME build the agent image is cut from, so this is the earliest place
#    a wrong pin surfaces - at preview, rather than as a job that never fires.
#    It also gates the coupling in the other direction: a distribution raising
#    hermes_requires to the cron-sync build fails install here first.
#    Prove the SUBCOMMAND, not just the module: an importable cron_sync whose
#    handler was never wired into the cron dispatcher would pass an
#    import-only check and still leave every declared job unscheduled.
_cron_sync_err = (
    ' - hermes.ref points at a Hermes build without a usable \`hermes cron '
    'sync\`. Shipped cron/<job>.yaml files would be copied onto every agent '
    'and never scheduled. Move hermes.ref AND the agent image tag together.'
)
try:
    cron_sync_mod = importlib.import_module('hermes_cli.cron_sync')
    cron_cli_mod = importlib.import_module('hermes_cli.cron')
except Exception as exc:
    raise SystemExit(
        'host Hermes cannot activate declared cron jobs: '
        + repr(exc) + _cron_sync_err
    )
assert callable(getattr(cron_sync_mod, 'sync', None)), (
    'host Hermes cannot activate declared cron jobs: hermes_cli.cron_sync has '
    'no callable sync()' + _cron_sync_err
)
assert callable(getattr(cron_cli_mod, 'cron_sync', None)), (
    'host Hermes cannot activate declared cron jobs: the cron subcommand '
    'dispatcher has no cron_sync handler, so \`hermes cron sync\` is not '
    'reachable even though the module imports' + _cron_sync_err
)
print('hermes-gitops-bootstrap: host Hermes cron-activation capability verified '
      '(hermes_cli.cron_sync importable)')
`;

// Behavioral half of the D1 capability check, run by the CONFIG command
// (after config.yaml enables the plugin - plugins are opt-in, so
// discovery before enablement would prove nothing): discover plugins on
// THIS host and assert gitops-emitter's register() actually subscribed a
// callback to each profile-lifecycle hook.
export const SUBSCRIPTION_CHECK_PY = `from hermes_cli import plugins

REQUIRED_HOOKS = ('profile_install', 'profile_update', 'profile_install_failed')
plugins.discover_plugins(force=True)
unsubscribed = [h for h in REQUIRED_HOOKS if not plugins.has_hook(h)]
assert not unsubscribed, (
    'gitops-emitter did not subscribe to: ' + ', '.join(unsubscribed)
    + ' - the plugin is installed and the host exposes the hooks, but '
    'register() did not attach callbacks (is gitops-emitter in '
    'plugins.enabled?)'
)
print('hermes-gitops-bootstrap: gitops-emitter subscribed to '
      + ', '.join(REQUIRED_HOOKS))
`;

/** hermes.pluginPath if set, else this checkout's own repo root — found by
 * walking up from the process cwd until the directory holding the
 * gitops_emitter package (pyproject.toml + plugin/gitops_emitter/) appears.
 * Walking (rather than assuming a fixed depth) matters because Pulumi's
 * nodejs runtime sets cwd to the program's `main` directory (infra/src/),
 * not the project root. Resolved here (not in config.ts) so config.ts
 * keeps its no-filesystem-dependency property; operators who vendor
 * infra/ without the rest of the repo must set hermes.pluginPath
 * explicitly — same contract as the Python predecessor. */
export function findRepoRoot(): string | null {
  let dir = process.cwd();
  for (;;) {
    if (
      fs.existsSync(path.join(dir, "pyproject.toml")) &&
      fs.existsSync(path.join(dir, "plugin", "gitops_emitter"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolvePluginPath(cfg: BootstrapConfig): string {
  if (cfg.hermesInstall.pluginPath) return cfg.hermesInstall.pluginPath;
  const root = findRepoRoot();
  if (root !== null) return root;
  throw new ConfigError(
    "could not locate the harness-hg repo root (pyproject.toml + " +
      "plugin/gitops_emitter/) above the running program; set " +
      "hermes-gitops-bootstrap:hermes.pluginPath explicitly when vendoring " +
      "infra/ outside this repo",
  );
}

export function isLocalSource(source: string): boolean {
  const expanded = source.startsWith("~/")
    ? path.join(process.env["HOME"] ?? "~", source.slice(2))
    : source;
  try {
    return fs.statSync(expanded).isDirectory();
  } catch {
    return false;
  }
}

export function buildInstallScript(source: string, ref: string, pluginPath: string): string {
  let installLine: string;
  if (isLocalSource(source)) {
    if (ref) {
      // Reproducible local-path pin (issue #7 [D3]): a plain local path
      // installs --editable against whatever is on disk, which made
      // `ref` a silent no-op. With `ref` set, install from the local
      // repo's GIT DATABASE at that ref instead (git+file, non-editable)
      // - independent of the working tree, byte-reproducible across
      // machines at the same commit. Requires the path to be a git repo
      // (uv fails loudly otherwise). Leave `ref` unset for the default
      // fast-iteration editable install.
      const pinned = `git+file://${path.resolve(source)}@${ref}`;
      installLine =
        `uv tool install ${shellQuote(pinned)} ` +
        `--with ${shellQuote(pluginPath)} --force`;
    } else {
      installLine =
        `uv tool install --editable ${shellQuote(source)} ` +
        `--with ${shellQuote(pluginPath)} --force`;
    }
  } else {
    // General case: a git URL, optionally pinned via PEP 508's `@<ref>`
    // syntax (`uv tool install` accepts git+<url>[@ref] directly as its
    // PACKAGE argument — no separate --ref flag).
    let pep508 = source.startsWith("git+") ? source : `git+${source}`;
    if (ref) pep508 = `${pep508}@${ref}`;
    installLine =
      `uv tool install ${shellQuote(pep508)} ` + `--with ${shellQuote(pluginPath)} --force`;
  }

  return `set -eu
export PATH="\${UV_TOOL_BIN_DIR:-$HOME/.local/bin}:$PATH"
${installLine}
${RESOLVE_HERMES_PY_FN}
HERMES_BIN="$(command -v hermes)"
HERMES_PY="$(_resolve_hermes_py "$HERMES_BIN")"
if [ -z "$HERMES_PY" ] || [ ! -x "$HERMES_PY" ]; then
    echo "hermes-gitops-bootstrap: could not resolve the hermes tool's own python interpreter from $HERMES_BIN" >&2
    exit 1
fi
"$HERMES_PY" <<'HERMES_GITOPS_VERIFY_EOF'
${ENTRYPOINT_CHECK_PY}HERMES_GITOPS_VERIFY_EOF
`;
}

export function buildConfigureScript(): string {
  // The config write goes through the plugin's SUPPORTED surface
  // (python -m gitops_emitter.config_cli apply - issue #10 [E1]): a
  // versioned, tested, comment-preserving (ruamel round-trip) writer
  // that also asserts the written config back through the same seam the
  // plugin reads at hook time. Config rides in env vars only (see this
  // Command's `environment`) - the desired values are therefore REAL
  // Pulumi inputs whose per-key before/after shows in `pulumi preview`
  // diffs, and the token never appears in command text.
  return `set -eu
export PATH="\${UV_TOOL_BIN_DIR:-$HOME/.local/bin}:$PATH"
${RESOLVE_HERMES_PY_FN}
HERMES_BIN="$(command -v hermes)"
HERMES_PY="$(_resolve_hermes_py "$HERMES_BIN")"
if [ -z "$HERMES_PY" ] || [ ! -x "$HERMES_PY" ]; then
    echo "hermes-gitops-bootstrap: could not resolve the hermes tool's own python interpreter from $HERMES_BIN" >&2
    exit 1
fi
"$HERMES_PY" -m gitops_emitter.config_cli apply
"$HERMES_PY" <<'HERMES_GITOPS_SUBSCRIPTION_EOF'
${SUBSCRIPTION_CHECK_PY}HERMES_GITOPS_SUBSCRIPTION_EOF
`;
}

/** Extract the tool venv's python interpreter path out of a
 * `uv tool install`-generated shim — the TS twin of the shell
 * RESOLVE_HERMES_PY_FN above (same two uv shim shapes: a plain shebang,
 * or the sh polyglot whose second line is an exec of the venv python,
 * used when the path is too long for a shebang line). Returns null when
 * the file has neither shape. */
export function resolveShimInterpreter(shimText: string): string | null {
  const lines = shimText.split("\n");
  const first = lines[0] ?? "";
  if (first === "#!/bin/sh") {
    const match = /^'''exec' '([^']+)'/.exec(lines[1] ?? "");
    return match?.[1] ?? null;
  }
  if (first.startsWith("#!")) {
    const rest = first.slice(2);
    return rest.split(" ")[0] || null;
  }
  return null;
}

// Minimal healthy-venv probe body: the plugin is discoverable AND the
// host declares the profile-lifecycle hooks (the cheap core of D1's
// structural check). Anything failing here means the venv needs the full
// install+verify rerun.
export const HEALTH_PROBE_PY = `import importlib
import importlib.metadata as m
assert 'gitops-emitter' in {e.name for e in m.entry_points(group='hermes_agent.plugins')}
plugins_mod = importlib.import_module('hermes_cli.plugins')
required = {'profile_install', 'profile_update', 'profile_install_failed'}
assert required <= set(getattr(plugins_mod, 'VALID_HOOKS', set()) or set())
`;

/** Probe the installed hermes tool venv's health at graph-construction
 * time (issue #3 [D2]): resolve the `hermes` shim (UV_TOOL_BIN_DIR or
 * ~/.local/bin or PATH), extract its interpreter, and run the minimal
 * capability check with it. Cheap (<1s) and read-only — safe to run on
 * every preview/up. */
export function probeHermesInstallHealth(): { healthy: boolean; reason: string } {
  const binDir = process.env["UV_TOOL_BIN_DIR"] ?? path.join(os.homedir(), ".local", "bin");
  const candidates = [path.join(binDir, "hermes")];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, "hermes"));
  }
  const shim = candidates.find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (shim === undefined) {
    return { healthy: false, reason: "no hermes shim on UV_TOOL_BIN_DIR/PATH" };
  }
  let interpreter: string | null;
  try {
    interpreter = resolveShimInterpreter(fs.readFileSync(shim, "utf-8"));
  } catch {
    return { healthy: false, reason: `hermes shim at ${shim} is unreadable` };
  }
  if (interpreter === null) {
    return { healthy: false, reason: `hermes shim at ${shim} has an unrecognized shape` };
  }
  try {
    fs.accessSync(interpreter, fs.constants.X_OK);
  } catch {
    return {
      healthy: false,
      reason: `tool venv interpreter ${interpreter} is missing/not executable (venv deleted?)`,
    };
  }
  const run = spawnSync(interpreter, ["-c", HEALTH_PROBE_PY], { timeout: 30_000 });
  if (run.status !== 0) {
    return {
      healthy: false,
      reason: "tool venv failed the plugin/hook capability probe (corrupt or wrong build)",
    };
  }
  return { healthy: true, reason: "hermes tool venv healthy" };
}

/** Preview-time plugin-config drift check (issue #32 [K1]): read the
 * operating profile's current plugins.entries.gitops-emitter block and
 * report which keys the coming apply would change — so out-of-band edits
 * are VISIBLE at `pulumi preview` instead of being silently re-forced.
 * Best-effort and read-only: an unreadable/absent config.yaml simply
 * reports nothing (first install). Returns the changed keys for tests. */
export function pluginConfigDrift(
  desired: Record<string, string | boolean>,
): string[] {
  const home = process.env["HERMES_HOME"] ?? path.join(os.homedir(), ".hermes");
  const configPath = path.join(home, "config.yaml");
  let currentEntry: Record<string, unknown> = {};
  try {
    const text = fs.readFileSync(configPath, "utf-8");
    // Cheap line-based extraction (no YAML dep): find the plugin block's
    // scalar keys. Good enough for a WARNING; the authoritative
    // comparison happens in config_cli's read-back assertion at apply.
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^\s+gitops-emitter:\s*$/.test(l));
    if (start !== -1) {
      const indentMatch = /^(\s+)/.exec(lines[start] ?? "");
      const indent = (indentMatch?.[1] ?? "").length;
      for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (line.trim() === "") continue;
        const lineIndent = line.length - line.trimStart().length;
        if (lineIndent <= indent) break;
        const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
        if (kv) currentEntry[kv[1]!] = kv[2]!.replace(/^['"]|['"]$/g, "");
      }
    }
  } catch {
    return [];
  }
  if (Object.keys(currentEntry).length === 0) return [];
  const changed: string[] = [];
  for (const [key, value] of Object.entries(desired)) {
    const current = currentEntry[key];
    if (current === undefined) continue;
    if (String(current) !== String(value)) changed.push(key);
  }
  return changed;
}

export interface HermesInstallArgs {
  config: BootstrapConfig;
}

/** Runs bootstrap stage 1. Exposes the created Commands, in dependency
 * order, for components/hermes-agent (stage 2) to chain onto. */
/** The plugin's configuration as the HERMES_GITOPS_* environment contract
 * config_cli.desired_entry_from_env reads (the same variables the
 * `hermes-profile-config` Command writes into config.yaml). Shared by
 * stage 1 and by the EveAgents component: an Eve host has no Hermes and
 * no config.yaml, so its emit commands run with
 * HERMES_GITOPS_CONFIG_SOURCE=env plus exactly this environment (ADR-149).
 * Pure; unit-tested. */
export function pluginConfigEnvironment(
  cfg: BootstrapConfig,
): Record<string, pulumi.Input<string>> {
  const environment: Record<string, pulumi.Input<string>> = {
    HERMES_GITOPS_GITOPS_REPO_URL: cfg.gitopsRepoUrl,
    HERMES_GITOPS_GITOPS_BRANCH: cfg.gitopsBranch,
    HERMES_GITOPS_GITOPS_SCAFFOLD: cfg.hermesInstall.scaffold ? "true" : "false",
    HERMES_GITOPS_HERMES_GITOPS_REPO_URL: cfg.hermesGitopsRepoUrl,
    HERMES_GITOPS_CHART_REVISION: cfg.chartRevision,
  };
  if (cfg.gitopsGitToken !== null) {
    environment["GITOPS_GIT_TOKEN"] = cfg.gitopsGitToken;
  }
  // Optional plugin-config fields + the fleet defaults document (issue
  // #13 [E3]) — passed only when configured, so unset keeps the
  // plugin's own fallback defaults.
  // Publishing posture (issue #21 [F3]): explicit mode wins; the
  // default is the resolved bootstrap posture - pr (installs direct,
  // updates auto-merged PRs) for github.com repos, direct otherwise.
  const effectiveMode =
    cfg.pluginConfig.mode ?? (isGithubRepoUrl(cfg.gitopsRepoUrl) ? "pr" : "direct");
  environment["HERMES_GITOPS_MODE"] = effectiveMode;
  if (cfg.pluginConfig.prAutoMerge !== null) {
    environment["HERMES_GITOPS_PR_AUTO_MERGE"] = cfg.pluginConfig.prAutoMerge
      ? "true"
      : "false";
  }
  // ADR-2's escape hatch (#140). Emitted ONLY when the operator set it,
  // so an unset stack shows no such variable at all - `pulumi preview`
  // is where the exception becomes visible, which is the whole point of
  // replacing the event-type carve-out with a flag.
  if (cfg.pluginConfig.allowDirectCommit !== null) {
    environment["HERMES_GITOPS_ALLOW_DIRECT_COMMIT"] = cfg.pluginConfig.allowDirectCommit
      ? "true"
      : "false";
  }
  const pluginFieldEnv: Array<[string, string | null]> = [
    ["HERMES_GITOPS_PROFILES_PATH", cfg.pluginConfig.profilesPath],
    ["HERMES_GITOPS_DEFAULTS_FILE", cfg.pluginConfig.defaultsFile],
    ["HERMES_GITOPS_OVERRIDES_DIR", cfg.pluginConfig.overridesDir],
    ["HERMES_GITOPS_GIT_AUTHOR_NAME", cfg.pluginConfig.gitAuthorName],
    ["HERMES_GITOPS_GIT_AUTHOR_EMAIL", cfg.pluginConfig.gitAuthorEmail],
    ["HERMES_GITOPS_IMAGE_REPOSITORY", cfg.pluginConfig.imageRepository],
    ["HERMES_GITOPS_IMAGE_TAG", cfg.pluginConfig.imageTag],
  ];
  for (const [envVar, value] of pluginFieldEnv) {
    if (value !== null) environment[envVar] = value;
  }
  if (cfg.fleetDefaults !== null) {
    environment["HERMES_GITOPS_FLEET_DEFAULTS_JSON"] = JSON.stringify(cfg.fleetDefaults);
  }
  return environment;
}

/** What the plugin path currently HOLDS: its git HEAD when it is a
 * checkout, else a hash of the emitter's file list + sizes (a vendored
 * copy still changes when its files do). Pure enough to unit-test; never
 * throws - an unreadable path yields "unknown", which is stable and so
 * changes nothing. */
export function pluginRevision(pluginPath: string): string {
  const git = spawnSync("git", ["-C", pluginPath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000 });
  if (git.status === 0 && /^[0-9a-f]{40}\s*$/.test(git.stdout)) return git.stdout.trim();
  const root = path.join(pluginPath, "plugin", "gitops_emitter");
  if (!fs.existsSync(root)) return "unknown";
  const h = crypto.createHash("sha256");
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        if (name !== "__pycache__") walk(p);
      } else {
        h.update(`${path.relative(root, p)}:${st.size}\n`);
      }
    }
  };
  walk(root);
  return `files-${h.digest("hex").slice(0, 16)}`;
}

export class HermesInstall extends pulumi.ComponentResource {
  readonly resources: pulumi.Resource[];

  constructor(name: string, args: HermesInstallArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:HermesInstall", name, {}, opts);
    const cfg = args.config;

    if (!cfg.hermesInstall.source) {
      throw new ConfigError(
        "hermes-gitops-bootstrap:hermes.source is required when stages.hermes is true " +
          "(local path or git URL of the hermes-agent-gitops fork)",
      );
    }

    const pluginPath = resolvePluginPath(cfg);
    const installScript = buildInstallScript(
      cfg.hermesInstall.source,
      cfg.hermesInstall.ref,
      pluginPath,
    );

    // Self-heal (issue #3 [D2]): the install is trigger-idempotent, so a
    // venv deleted/corrupted out-of-band with unchanged config would
    // never reinstall. Probe venv health at graph construction and fold
    // the result into the triggers: healthy -> the stable string
    // "healthy" (no diff, repeated `pulumi up`s stay no-ops); broken ->
    // a fresh nonce (fresh per up, so a heal that FAILS retries on the
    // next up), forcing the full install+verify to rerun (`uv tool
    // install --force` is the repair; the D1 capability checks then
    // re-certify it). Convergence is two-step by construction: the heal
    // up stores the nonce, and the FIRST up after a successful heal
    // normalizes the trigger back to "healthy" (re-running the
    // idempotent install+verify once more); every up after that is a
    // no-op.
    const health = probeHermesInstallHealth();
    let healthTrigger = "healthy";
    if (!health.healthy) {
      healthTrigger = `heal-${crypto.randomBytes(8).toString("hex")}`;
      pulumi.log.info(
        `hermes-install: tool venv needs (re)install - ${health.reason}; ` +
          "stage 1 will run the full install+verify",
      );
    }

    // The plugin's REVISION is a trigger too (found live 2026-09-03): the
    // path never changes when the clone advances, so the tool venv kept
    // an emitter wheel from 08-27 through every later `pulumi up` - the
    // Hermes install path then rendered the managed scaffold files from
    // the OLD template while the Eve emit path (which runs from the
    // clone) rendered the new one, and the two flip-flopped every apply.
    const installCmd = new local.Command(
      "hermes-cli-install",
      {
        create: installScript,
        update: installScript,
        triggers: [
          cfg.hermesInstall.source,
          cfg.hermesInstall.ref,
          pluginPath,
          pluginRevision(pluginPath),
          healthTrigger,
        ],
      },
      { parent: this },
    );

    const configureScript = buildConfigureScript();
    const environment = pluginConfigEnvironment(cfg);

    const desiredForDrift: Record<string, string | boolean> = {
      repo_url: cfg.gitopsRepoUrl,
      branch: cfg.gitopsBranch,
      scaffold: cfg.hermesInstall.scaffold,
      hermes_gitops_repo_url: cfg.hermesGitopsRepoUrl,
      chart_revision: cfg.chartRevision,
    };
    const drifted = pluginConfigDrift(desiredForDrift);
    if (drifted.length > 0) {
      pulumi.log.warn(
        "hermes-profile-config: the operating profile's current plugin " +
          `config differs from the stack's desired state on: ${drifted.join(", ")} ` +
          "- the coming apply will converge it (out-of-band edits do not survive)",
      );
    }

    const configCmd = new local.Command(
      "hermes-profile-config",
      {
        create: configureScript,
        update: configureScript,
        environment,
        triggers: [
          cfg.gitopsRepoUrl,
          cfg.gitopsBranch,
          cfg.hermesInstall.scaffold,
          cfg.hermesGitopsRepoUrl,
          cfg.chartRevision,
          cfg.gitopsGitToken,
          cfg.pluginConfig,
          cfg.fleetDefaults,
        ],
      },
      { parent: this, dependsOn: [installCmd] },
    );

    this.resources = [installCmd, configCmd];
    this.registerOutputs({});
  }
}
