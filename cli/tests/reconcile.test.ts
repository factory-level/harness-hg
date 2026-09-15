// hg reconcile: the state machine, the retry gate, crash recovery, the
// scrubbing pipeline, and full ticks against a REAL local bare repo (git
// is cheap; the mutation commands are the only fake). HG_HOME is pointed
// at a tmpdir before the module loads, so nothing here touches the
// operator's real state.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hg-reconcile-"));
process.env["HERMES_GITOPS_HOME"] = HOME;

const {
  configFile, ledgerFile, logsDir, lockFile, unitName, statusName, selectInstance,
  emptyLedger, gitArgs, nexusRecord, readLedger, reconcileOnce, recoverLedger,
  saveLedger, scrub, shouldApply, summarize, unitFiles, writeConfig,
} = await import("../src/reconcile/index.ts");
type Ledger = import("../src/reconcile/index.ts").ReconcileLedger;
type Config = import("../src/reconcile/index.ts").ReconcileConfig;

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const TOKEN = "ghp_" + "x".repeat(30);

// A real bare deployment repo + a workdir to push from.
const BARE = join(HOME, "deploy.git");
const WORK = join(HOME, "work");
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
execFileSync("git", ["init", "--bare", BARE]);
mkdirSync(WORK);
git(WORK, "init");
git(WORK, "config", "user.email", "t@t");
git(WORK, "config", "user.name", "t");
git(WORK, "remote", "add", "origin", BARE);
function push(content: string): string {
  writeFileSync(join(WORK, "file.txt"), content);
  git(WORK, "add", ".");
  git(WORK, "commit", "-m", content);
  git(WORK, "push", "origin", "HEAD:main", "--force");
  return git(WORK, "rev-parse", "HEAD");
}

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    version: "v-test",
    repoUrl: BARE,
    branch: "main",
    intervalSeconds: 60,
    checks: ["true"],
    apply: "true",
    hermesHome: join(HOME, ".hermes"),
    argocdTimeoutSec: 5,
    ...over,
  };
}

function ledgerWith(over: Partial<Ledger> = {}): Ledger {
  return { ...emptyLedger(baseConfig()), ...over };
}

beforeEach(() => {
  selectInstance();
  rmSync(configFile(), { force: true });
  rmSync(ledgerFile(), { force: true });
});

describe("named repository watchers", () => {
  test("isolate paths and units, preserve the default, and share the existing lock", () => {
    const defaultConfig = configFile();
    const sharedLock = lockFile();
    try {
      selectInstance("inferops");
      expect(configFile()).not.toBe(defaultConfig);
      expect(lockFile()).toBe(sharedLock);
      expect(unitName()).toBe("hermes-reconcile-inferops");
      expect(statusName()).toBe("hermes-reconciliation-status-inferops");
      const units = unitFiles(baseConfig(), { bun: "/bin/bun", main: "/app/main.ts" });
      expect(units.service).toContain("reconcile run --instance inferops");
      expect(units.timer).toContain("Unit=hermes-reconcile-inferops.service");
      expect(() => selectInstance("../escape")).toThrow(/instance must/);
      expect(() => selectInstance("inferops-")).toThrow(/instance must/);
    } finally { selectInstance(); }
    expect(configFile()).toBe(defaultConfig);
    expect(unitName()).toBe("hermes-reconcile");
  });

  test("selection stays process-local and a second instance cannot take the shared flock", () => {
    selectInstance("inferops");
    try {
      const modulePath = join(import.meta.dir, "../src/reconcile/index.ts");
      const child = `const m = await import(${JSON.stringify(modulePath)}); console.log(m.unitName());`;
      expect(execFileSync(process.execPath, ["-e", child], { encoding: "utf8" }).trim()).toBe("hermes-reconcile");
      mkdirSync(join(HOME, "reconcile"), { recursive: true });
      const contend = `const m = await import(${JSON.stringify(modulePath)}); m.selectInstance("other"); const r = Bun.spawnSync(["flock", "-n", "-E", "75", m.lockFile(), "true"]); console.log(JSON.stringify({ lock: m.lockFile(), exitCode: r.exitCode, error: r.stderr.toString() })); process.exit(r.exitCode === 75 ? 0 : 1);`;
      const result = Bun.spawnSync(["flock", lockFile(), process.execPath, "-e", contend], { env: { ...process.env } });
      expect({ code: result.exitCode, output: result.stdout.toString().trim(), error: result.stderr.toString() }).toEqual({
        code: 0, output: JSON.stringify({ lock: lockFile(), exitCode: 75, error: "" }), error: "",
      });
    } finally { selectInstance(); }
  });

  test("a failed named source cannot overwrite or block the default source ledger", async () => {
    const sha = push("named-watchers");
    writeConfig(baseConfig());
    const initial = await reconcileOnce({ manual: false, retry: false }, { argocdConverged: async () => true });
    expect(initial.appliedSha).toBe(sha);
    try {
      selectInstance("independent");
      writeConfig(baseConfig({ checks: ["exit 1"] }));
      const failed = await reconcileOnce({ manual: false, retry: false }, {});
      expect(failed.state).toBe("failed");
      expect(failed.appliedSha).toBeUndefined();
      writeConfig(baseConfig());
      const retried = await reconcileOnce({ manual: true, retry: true }, { argocdConverged: async () => true });
      expect(retried.appliedSha).toBe(sha);
    } finally { selectInstance(); }
    expect(readLedger(baseConfig()).appliedSha).toBe(sha);
    expect(readLedger(baseConfig()).blocked).toBeUndefined();
  });
});
afterAll(() => rmSync(HOME, { recursive: true, force: true }));

describe("the retry gate (shouldApply)", () => {
  const tick = { manual: false, retry: false };

  test("a new desired sha acts; the applied sha does not", () => {
    const l = ledgerWith({ appliedSha: SHA_A });
    expect(shouldApply(l, SHA_B, tick).act).toBe(true);
    expect(shouldApply(l, SHA_A, tick).act).toBe(false);
  });

  test("a blocked sha never re-runs on the timer - the whole point", () => {
    const l = ledgerWith({
      appliedSha: SHA_A,
      blocked: { sha: SHA_B, attempts: 3, lastAt: "t", summary: "s" },
    });
    const v = shouldApply(l, SHA_B, tick);
    expect(v.act).toBe(false);
    expect(v.reason).toContain("failed 3x");
    expect(v.reason).toContain("hg reconcile retry");
  });

  test("sync bypasses the unchanged-sha short-circuit but NOT the block", () => {
    const blocked = ledgerWith({ blocked: { sha: SHA_B, attempts: 1, lastAt: "t", summary: "s" } });
    expect(shouldApply(blocked, SHA_B, { manual: true, retry: false }).act).toBe(false);
    const clean = ledgerWith({ appliedSha: SHA_A });
    expect(shouldApply(clean, SHA_A, { manual: true, retry: false }).act).toBe(true);
  });

  test("only retry clears the way through a block", () => {
    const l = ledgerWith({ blocked: { sha: SHA_B, attempts: 2, lastAt: "t", summary: "s" } });
    expect(shouldApply(l, SHA_B, { manual: true, retry: true }).act).toBe(true);
  });
});

describe("crash recovery (recoverLedger)", () => {
  test("a run with no result becomes a failed attempt", () => {
    const l = recoverLedger(
      ledgerWith({
        run: { sha: SHA_B, startedAt: "t0", trigger: "timer", phase: "apply" },
      }),
    );
    expect(l.state).toBe("failed");
    expect(l.run).toBeUndefined();
    expect(l.blocked?.sha).toBe(SHA_B);
    expect(l.blocked?.attempts).toBe(1);
    expect(l.history[l.history.length - 1]?.failure?.summary).toContain("interrupted");
  });

  test("a crash-looping commit accumulates attempts against the SAME gate", () => {
    const once = recoverLedger(
      ledgerWith({
        blocked: { sha: SHA_B, attempts: 2, lastAt: "t", summary: "s" },
        run: { sha: SHA_B, startedAt: "t0", trigger: "timer", phase: "check" },
      }),
    );
    expect(once.blocked?.attempts).toBe(3);
  });

  test("a crash during the ARGO WAIT does not block the applied commit", () => {
    // The apply already succeeded (appliedSha advanced); a kill during
    // the convergence wait must read degraded and stay retriable by the
    // NEXT TICK alone - blocking here would freeze the reconciler on a
    // commit that needs no retry. Found live.
    const l = recoverLedger(
      ledgerWith({
        appliedSha: SHA_B,
        run: { sha: SHA_B, startedAt: "t0", trigger: "timer", phase: "argocd" },
      }),
    );
    expect(l.state).toBe("degraded");
    expect(l.blocked).toBeUndefined();
    expect(l.appliedSha).toBe(SHA_B);
    // An argocd-phase crash for a DIFFERENT sha than applied (impossible
    // in one process, possible with a hand-edited ledger) still fails.
    const weird = recoverLedger(
      ledgerWith({
        appliedSha: SHA_A,
        run: { sha: SHA_B, startedAt: "t0", trigger: "timer", phase: "argocd" },
      }),
    );
    expect(weird.state).toBe("failed");
  });

  test("a completed run is untouched", () => {
    const l = ledgerWith({
      run: { sha: SHA_B, startedAt: "t0", trigger: "timer", phase: "done", result: "success" },
    });
    expect(recoverLedger(l)).toEqual(l);
  });
});

describe("scrubbing", () => {
  test("token literal, url userinfo, and secret patterns are redacted", () => {
    const raw = `pushed to https://x-access-token:${TOKEN}@github.test/o/r
error: token ${TOKEN} rejected
key sk-${"y".repeat(24)} leaked`;
    const clean = scrub(raw, [TOKEN]);
    expect(clean).not.toContain(TOKEN);
    expect(clean).not.toContain("sk-" + "y".repeat(24));
    expect(clean).toContain("«redacted»");
  });

  test("summarize keeps the tail and the cap", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const s = summarize(lines, []);
    expect(s).toContain("line 99");
    expect(s).not.toContain("line 10\n");
    expect(summarize("x".repeat(9000), []).length).toBeLessThanOrEqual(2000);
  });

  test("a synthetic token-bearing failure never reaches the serialized ledger", async () => {
    push("clean");
    writeConfig(baseConfig({ checks: [`echo "fatal: auth ${TOKEN} rejected" >&2; exit 1`] }));
    writeFileSync(join(baseConfig().hermesHome, "..", "unused"), ""); // ensure parent exists
    mkdirSync(baseConfig().hermesHome, { recursive: true });
    writeFileSync(join(baseConfig().hermesHome, ".env"), `GITOPS_GIT_TOKEN=${TOKEN}\n`);
    const ledger = await reconcileOnce({ manual: false, retry: false }, {});
    expect(ledger.state).toBe("failed");
    const serialized = readFileSync(ledgerFile(), "utf8");
    expect(serialized).not.toContain(TOKEN);
    // The FULL output (with the token) lives only in the 0600 host log.
    const logs = readdirSync(logsDir()).filter((f) => f.endsWith(".log"));
    expect(logs.length).toBeGreaterThan(0);
    const mode = statSync(join(logsDir(), logs[logs.length - 1]!)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("git plumbing", () => {
  test("the token never enters argv", () => {
    const cfg = baseConfig({ repoUrl: "https://github.test/o/r.git" });
    const argv = gitArgs(cfg, TOKEN, ["ls-remote", cfg.repoUrl]);
    expect(argv.join(" ")).not.toContain(TOKEN);
    expect(argv.join(" ")).toContain("credential.helper=store --file=");
  });

  test("no credential helper for a non-http remote", () => {
    const argv = gitArgs(baseConfig(), TOKEN, ["fetch"]);
    expect(argv.join(" ")).not.toContain("credential.helper");
  });
});

describe("the published record (nexusRecord)", () => {
  test("allowlist only - ledger internals do not leave the host", () => {
    const l = ledgerWith({
      state: "failed",
      desiredSha: SHA_B,
      appliedSha: SHA_A,
      blocked: { sha: SHA_B, attempts: 2, lastAt: "t", summary: "check failed: doctor said no" },
      history: [{ sha: SHA_A, startedAt: "t", trigger: "timer", phase: "done", result: "success" }],
    });
    const rec = nexusRecord(l);
    expect(rec["kind"]).toBe("ReconciliationStatus");
    expect(rec["phase"]).toBe("failed");
    expect(rec["retryable"]).toBe(true);
    expect(rec["appliedSha"]).toBe(SHA_A);
    expect(rec["attempts"]).toBe(2);
    expect(rec).not.toHaveProperty("history");
    expect(rec).not.toHaveProperty("repo");
    expect(rec).not.toHaveProperty("run");
  });

  test("a malformed sha never serializes", () => {
    const rec = nexusRecord(ledgerWith({ state: "synced", appliedSha: "https://evil" as never }));
    expect(rec).not.toHaveProperty("appliedSha");
  });
});

describe("full ticks against a real repo", () => {
  test("valid change: poll -> checkout exact sha -> checks -> apply -> synced", async () => {
    const sha = push("v1");
    const seen: string[] = [];
    writeConfig(baseConfig({ checks: ["pwd"], apply: "git rev-parse HEAD" }));
    const ledger = await reconcileOnce(
      { manual: false, retry: false },
      {
        argocdReady: () => true,
        argocdConverged: async () => true,
        publish: (r) => seen.push(String(r["phase"])),
      },
    );
    expect(ledger.state).toBe("synced");
    expect(ledger.appliedSha).toBe(sha);
    expect(ledger.history[ledger.history.length - 1]?.result).toBe("success");
    expect(ledger.history[ledger.history.length - 1]?.trigger).toBe("timer");
    expect(seen).toEqual(["synced"]);
  });

  test("a failing check blocks BEFORE mutation and never advances appliedSha", async () => {
    const good = push("v2");
    writeConfig(baseConfig());
    await reconcileOnce({ manual: false, retry: false }, { argocdConverged: async () => true });
    const bad = push("v3-broken");
    writeConfig(baseConfig({ checks: ["exit 1"], apply: "echo SHOULD-NEVER-RUN" }));
    const ledger = await reconcileOnce({ manual: false, retry: false }, {});
    expect(ledger.state).toBe("failed");
    expect(ledger.attemptedSha).toBe(bad);
    expect(ledger.appliedSha).toBe(good); // the previous good commit is still what runs
    expect(ledger.blocked?.sha).toBe(bad);
    expect(ledger.blocked?.attempts).toBe(1);

    // The gate holds: a second timer tick does nothing.
    const again = await reconcileOnce({ manual: false, retry: false }, {});
    expect(again.blocked?.attempts).toBe(1);
    expect(again.state).toBe("failed");

    // retry re-attempts (and fails again, honestly counting).
    const retried = await reconcileOnce({ manual: false, retry: true }, {});
    expect(retried.blocked?.attempts).toBe(2);

    // A pushed fix clears the block without human action.
    const fixed = push("v4-fixed");
    writeConfig(baseConfig());
    const healed = await reconcileOnce({ manual: false, retry: false }, { argocdConverged: async () => true });
    expect(healed.state).toBe("synced");
    expect(healed.appliedSha).toBe(fixed);
    expect(healed.blocked).toBeUndefined();
  });

  test("checks can invoke the running runtime even on a bare PATH", async () => {
    // The first real systemd tick failed with "bun: command not found":
    // bash -l under systemd --user never reaches the rc that extends
    // PATH. The executor now carries the running runtime's directory.
    push("v-path");
    writeConfig(baseConfig({ checks: ["bun --version"], apply: "true" }));
    const savedPath = process.env["PATH"];
    process.env["PATH"] = "/usr/bin:/bin"; // a systemd-shaped PATH
    try {
      const ledger = await reconcileOnce({ manual: false, retry: false }, { argocdConverged: async () => true });
      expect(ledger.state).toBe("synced");
    } finally {
      process.env["PATH"] = savedPath;
    }
  });

  test("a SILENT check failure still leaves an auditable summary", async () => {
    // `test -f missing` exits 1 with no output at all - the most common
    // real preflight failure. The ledger must say what happened anyway.
    push("v-silent");
    writeConfig(baseConfig({ checks: ["test -f does-not-exist.txt"] }));
    const ledger = await reconcileOnce({ manual: false, retry: false }, {});
    expect(ledger.state).toBe("failed");
    expect(ledger.blocked!.summary).toContain("exited 1 with no output");
    expect(ledger.blocked!.summary).toContain("does-not-exist");
  });

  test("an Argo timeout is degraded, not failed - the apply DID succeed", async () => {
    const sha = push("v5");
    writeConfig(baseConfig());
    const ledger = await reconcileOnce(
      { manual: false, retry: false },
      { argocdConverged: async () => false },
    );
    expect(ledger.state).toBe("degraded");
    expect(ledger.appliedSha).toBe(sha);
    expect(ledger.blocked).toBeUndefined();

    // The next tick re-checks Argo only and heals without re-applying.
    let applied = 0;
    const healed = await reconcileOnce(
      { manual: false, retry: false },
      {
        argocdConverged: async () => true,
        exec: undefined, // real exec; apply would bump nothing because sha is unchanged
      },
    );
    expect(applied).toBe(0);
    expect(healed.state).toBe("synced");
  });

  test("control plane not ready = degraded with no checkout and no apply", async () => {
    push("v6");
    writeConfig(baseConfig({ apply: "echo MUST-NOT-RUN > applied.txt" }));
    const ledger = await reconcileOnce(
      { manual: false, retry: false },
      { argocdReady: () => false },
    );
    expect(ledger.state).toBe("degraded");
    expect(ledger.run).toBeUndefined();
  });

  test("a missing token against an http remote reads authentication-required", async () => {
    writeConfig(baseConfig({ repoUrl: "https://127.0.0.1:1/none.git", hermesHome: join(HOME, "no-such") }));
    const ledger = await reconcileOnce({ manual: false, retry: false }, {});
    expect(ledger.state).toBe("authentication-required");
  });

  test("a torn ledger restarts clean instead of crashing the timer", () => {
    writeConfig(baseConfig());
    writeFileSync(ledgerFile(), "{ not json");
    const l = readLedger(baseConfig());
    expect(l.kind).toBe("ReconcileState");
    expect(l.history).toEqual([]);
  });

  test("the ledger write is atomic - no tmp litter", () => {
    saveLedger(ledgerWith());
    const litter = readdirSync(join(HOME, "reconcile")).filter((f) => f.endsWith(".tmp"));
    expect(litter).toEqual([]);
  });
});

describe("unit files", () => {
  test("golden shape: oneshot, inactive-edge cadence, version pin, no token", () => {
    const units = unitFiles(baseConfig({ intervalSeconds: 60, argocdTimeoutSec: 900 }), {
      bun: "/usr/local/bin/bun",
      main: "/opt/hg/cli/src/main.ts",
    });
    expect(units.service).toContain("Type=oneshot");
    expect(units.service).toContain("Description=Harness Hg reconciliation (version v-test)");
    expect(units.service).toContain("ExecStart=/usr/local/bin/bun /opt/hg/cli/src/main.ts reconcile run");
    // Argo wait + apply headroom: a hung run is killed, never holds the
    // flock forever.
    expect(units.service).toContain("TimeoutStartSec=1500");
    // From the END of the last run - a slow pulumi up can never queue
    // a burst of overlapping ticks.
    expect(units.timer).toContain("OnUnitInactiveSec=60s");
    expect(units.timer).toContain("OnBootSec=2min");
    expect(units.timer).toContain("WantedBy=timers.target");
    // No credential material of any kind in either unit.
    for (const text of [units.service, units.timer]) {
      expect(text).not.toContain("TOKEN");
      expect(text).not.toContain("ghp_");
    }
  });
});

describe("the M02 handshake", () => {
  test("nexusRecord output validates against the frozen ReconciliationStatus schema", async () => {
    // Both sides of the handshake pinned in one place: what this writer
    // emits must be exactly what the overlay's reader (and the frozen
    // schema) accept, for every state the ledger can be in.
    const Ajv2020 = (await import("ajv/dist/2020")).default;
    const schema = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "..", "agent-bundle-contracts", "runtime-overlay", "v1alpha1", "reconciliation-status.schema.json"),
        "utf8",
      ),
    );
    const validate = new Ajv2020({ allErrors: true, strictTypes: false }).compile(schema);
    const states: import("../src/reconcile/index.ts").ReconcileState[] = [
      "synced", "change-detected", "validating", "applying",
      "waiting-for-argocd", "degraded", "failed", "authentication-required",
    ];
    for (const state of states) {
      const rec = nexusRecord(
        ledgerWith({
          state,
          desiredSha: SHA_B,
          appliedSha: SHA_A,
          appliedAt: "2026-07-31T12:00:00.123Z", // millis must be shaved to the schema's Z shape
          observedAt: "2026-07-31T12:00:05.999Z",
          blocked: state === "failed" ? { sha: SHA_B, attempts: 1, lastAt: "t", summary: "s" } : undefined,
        }),
      );
      const okRec = validate(rec);
      expect(validate.errors ?? []).toEqual([]);
      expect(okRec).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The team-kind watcher (ADR 0191): `hg team resume --unattended` as the apply,
// pending as a first-class state with capped backoff, the v1alpha2 record.

const {
  lastJsonDocument, nexusRecord: teamRecord, pendingBackoffSeconds, planBootstrapDirectory, readEnvironmentFile,
  planLockFile, planPlatform, lockPlatformRevisions, platformDir, checkoutFile,
} = await import("../src/reconcile/index.ts");
type ExecResult = { exitCode: number; stdout: string; stderr: string };

function teamConfig(over: Partial<Config> = {}): Config {
  return baseConfig({ checks: [], apply: "", kind: "team", team: { plan: "teams/installation.yaml" }, ...over });
}
/** A valid version 2 plan (the tick loads it for the credential gate). `HG_FACTORY_GIT` is a
 * bootstrap config input, so an empty environment satisfies it; `agentEnvironment` adds runtime
 * names the environment must carry. */
/** A bare platform repository whose worktrees carry a usable cli/src/main.ts, plus the two
 * workspaces the watcher installs. Two commits, so a lock can move between revisions. */
const PLATFORM_URL = "https://github.com/example/platform";
function platformRepository(): { url: string; first: string; second: string } {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const work = join(HOME, `platform-src-${stamp}`), bare = join(HOME, `platform-${stamp}.git`);
  mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  for (const workspace of ["cli", "infra"]) {
    mkdirSync(join(work, workspace, "src"), { recursive: true });
    writeFileSync(join(work, workspace, "package.json"), JSON.stringify({ name: workspace, private: true }));
    writeFileSync(join(work, workspace, "bun.lock"), "");
  }
  writeFileSync(join(work, "cli", "src", "main.ts"), "// platform hg, revision one\n");
  git(work, "add", "."); git(work, "commit", "-m", "platform one");
  const first = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "cli", "src", "main.ts"), "// platform hg, revision two\n");
  git(work, "add", "."); git(work, "commit", "-m", "platform two");
  const second = git(work, "rev-parse", "HEAD");
  execFileSync("git", ["clone", "--bare", "-q", work, bare], { encoding: "utf8" });
  // The plan names the real URL; git resolves it to this bare copy for the duration of the test.
  const config = join(HOME, `git-config-${stamp}`);
  writeFileSync(config, `[user]\n\tname = test\n\temail = test@example.invalid\n[url "${bare}"]\n\tinsteadOf = ${PLATFORM_URL}\n`);
  process.env["GIT_CONFIG_GLOBAL"] = config;
  return { url: PLATFORM_URL, first, second };
}

/** The same plan, declaring a platform repository, with the lock that records its revision. */
function pushPlanWithPlatform(repository: string | undefined, revision: string, previousRevision?: string): string {
  pushPlan();
  const planFile = join(WORK, "teams", "installation.yaml");
  const plan = parse(readFileSync(planFile, "utf8"));
  plan.lock = "teams/installation.lock.yaml";
  if (repository) plan.platform = { repository, ref: revision };
  writeFileSync(planFile, stringify(plan));
  writeFileSync(join(WORK, "teams", "installation.lock.yaml"), stringify({
    version: 2, installation: "factory-teams", planDigest: "0".repeat(64), sources: {}, agents: {},
    platform: { ref: revision, revision, ...(previousRevision ? { previousRevision } : {}) },
  }));
  git(WORK, "add", "--all", ".");
  git(WORK, "commit", "-m", `platform ${revision.slice(0, 8)} ${Date.now()}`, "--allow-empty");
  git(WORK, "push", "origin", "HEAD:main", "--force");
  return git(WORK, "rev-parse", "HEAD");
}

function pushPlan(bootstrapDir = "infra", agentEnvironment: string[] = []): string {
  mkdirSync(join(WORK, "teams"), { recursive: true });
  const plan = {
    version: 2, id: "factory-teams", lock: "teams/installation.lock.yaml",
    sources: [{ id: "social", repository: "https://github.com/example/social", ref: "a".repeat(40), private: false,
      agents: [{ name: "manager", subdir: "agents/eve/manager/src", environment: agentEnvironment, tools: [], writablePaths: [], skills: [] }] }],
    destination: { repository: "https://github.com/example/generated", branch: "main", credentialEnv: "HG_FACTORY_GIT", autoMerge: true },
    environment: "environment.yaml", argoDestinations: ["in-cluster"],
    runtime: { image: `example/eve@sha256:${"a".repeat(64)}`, platform: "linux/amd64" },
    bootstrap: { directory: bootstrapDir, stack: "factory" }, kubeContext: "default", authorizations: ["publish"],
    credentials: { configFile: `${bootstrapDir}/Pulumi.factory.yaml`, bindings: {}, inputs: { HG_FACTORY_GIT: "factory:git.token" } },
    acceptance: [{ id: "verify", source: "social", agent: "manager", argv: ["node", "verify.mjs"], effect: "read" }],
  };
  writeFileSync(join(WORK, "teams", "installation.yaml"), stringify(plan));
  rmSync(join(WORK, "teams", "installation.lock.yaml"), { force: true });
  mkdirSync(join(WORK, bootstrapDir), { recursive: true });
  writeFileSync(join(WORK, bootstrapDir, "package.json"), JSON.stringify({ name: "bootstrap", private: true }));
  writeFileSync(join(WORK, bootstrapDir, "bun.lock"), "");
  git(WORK, "add", "--all", ".");
  git(WORK, "commit", "-m", `plan ${Date.now()}`, "--allow-empty");
  git(WORK, "push", "origin", "HEAD:main", "--force");
  return git(WORK, "rev-parse", "HEAD");
}
const resumeWith = (exitCode: number, report: Record<string, unknown>, seen: string[][] = []) =>
  (checkout: string, planFile: string, env: Record<string, string>): ExecResult => {
    seen.push([checkout, planFile, JSON.stringify(env)]);
    return { exitCode, stdout: `team factory-teams: validated\n${JSON.stringify({ complete: exitCode === 0, report })}\n`, stderr: "" };
  };
const noInstall = (real: (argv: string[], opts?: { cwd?: string }) => ExecResult) => (argv: string[], opts?: { cwd?: string }): ExecResult =>
  argv[1] === "install" ? { exitCode: 0, stdout: "", stderr: "" } : real(argv, opts);
const realExecFor = async () => (await import("../src/reconcile/index.ts")).gitArgs && ((argv: string[], opts?: { cwd?: string }) => {
  const r = Bun.spawnSync(argv, { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
});

describe("the team-kind watcher", () => {
  test("a completing resume applies the commit and publishes a v1alpha2 record with the report", async () => {
    const sha = pushPlan();
    writeConfig(teamConfig());
    const seen: string[][] = [], published: Record<string, unknown>[] = [];
    const report = { installation: "factory-teams", stage: "complete",
      sources: [{ id: "social", ref: "refs/tags/v1", desiredSha: SHA_A, appliedSha: SHA_A }],
      agents: [{ name: "manager", source: "social", desiredSha: SHA_A, appliedSha: SHA_A, runtimeDigest: "example/eve@sha256:" + "a".repeat(64), eveVersion: "0.42.0", ready: true }] };
    const ledger = await reconcileOnce({ manual: false, retry: false }, {
      exec: noInstall((await realExecFor())!), teamResume: resumeWith(0, report, seen), argocdConverged: async () => true, publish: (r) => published.push(r),
    });
    expect(ledger.state).toBe("synced");
    expect(ledger.appliedSha).toBe(sha);
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toBe("teams/installation.yaml");
    const record = published.at(-1)!;
    expect(record["apiVersion"]).toBe("nexus.hermes.ai/v1alpha2");
    expect(record["installation"]).toBe("factory-teams");
    expect(record["stage"]).toBe("complete");
    expect(record["agents"]).toEqual([{ name: "manager", source: "social", desiredSha: SHA_A, appliedSha: SHA_A, runtimeDigest: "example/eve@sha256:" + "a".repeat(64), eveVersion: "0.42.0", ready: true }]);
    expect(record["pending"]).toBeUndefined();
  });

  test("exit 75 is pending: backoff, no block, same commit retried after nextAttemptAt or on sync, cleared by a new commit", async () => {
    const sha = pushPlan();
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    let clock = Date.parse("2026-09-10T10:00:00Z");
    const now = () => clock;
    const pendingReport = { installation: "factory-teams", stage: "published", pending: { reason: "merge-pending", link: "https://github.com/example/generated/pull/42" }, sources: [], agents: [] };
    const attempts: number[] = [];
    const resume = (code: number) => (c: string, p: string, e: Record<string, string>) => { attempts.push(code); return resumeWith(code, pendingReport)(c, p, e); };
    const published: Record<string, unknown>[] = [];
    const first = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resume(75), publish: (r) => published.push(r) });
    expect(first.state).toBe("pending");
    expect(first.blocked).toBeUndefined();
    expect(first.appliedSha).toBeUndefined();
    expect(first.pending).toMatchObject({ sha, attempts: 1, reason: "merge-pending", link: "https://github.com/example/generated/pull/42", stage: "published" });
    expect(Date.parse(first.pending!.nextAttemptAt) - clock).toBe(pendingBackoffSeconds(1) * 1000);
    expect(published.at(-1)).toMatchObject({ apiVersion: "nexus.hermes.ai/v1alpha2", phase: "pending", pending: { reason: "merge-pending", link: "https://github.com/example/generated/pull/42" } });
    expect(first.history.at(-1)?.result).toBe("pending");

    // Before nextAttemptAt a timer tick does nothing.
    clock += 30_000;
    const held = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resume(75) });
    expect(attempts).toHaveLength(1);
    expect(held.state).toBe("pending");
    // An operator `sync` re-attempts immediately.
    const forced = await reconcileOnce({ manual: true, retry: false }, { exec, now, teamResume: resume(75) });
    expect(attempts).toHaveLength(2);
    expect(forced.pending?.attempts).toBe(2);
    expect(Date.parse(forced.pending!.nextAttemptAt) - clock).toBe(pendingBackoffSeconds(2) * 1000);
    // After the backoff the timer re-attempts; the merge landed, so the commit completes.
    clock += pendingBackoffSeconds(2) * 1000 + 1;
    const done = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resume(0), argocdConverged: async () => true });
    expect(done.state).toBe("synced");
    expect(done.pending).toBeUndefined();
    expect(done.appliedSha).toBe(sha);
    // A new commit while pending clears the wait without human action.
    pushPlan();
    const again = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resume(75) });
    expect(again.state).toBe("pending");
    const next = pushPlan();
    const cleared = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resume(0), argocdConverged: async () => true });
    expect(cleared.appliedSha).toBe(next);
    expect(cleared.pending).toBeUndefined();
  });

  test("backoff is capped and RECON009-style bounds hold", () => {
    expect(pendingBackoffSeconds(1)).toBe(120);
    expect(pendingBackoffSeconds(2)).toBe(240);
    expect(pendingBackoffSeconds(4)).toBe(960);
    expect(pendingBackoffSeconds(5)).toBe(1800);
    expect(pendingBackoffSeconds(50)).toBe(1800);
    const ledger = ledgerWith({ state: "pending", pending: { sha: SHA_A, attempts: 1, lastAt: "2026-09-10T10:00:00Z", nextAttemptAt: "2026-09-10T10:02:00Z", reason: "approval-required" } });
    expect(shouldApply(ledger, SHA_A, { manual: false, retry: false }, Date.parse("2026-09-10T10:01:00Z")).act).toBe(false);
    expect(shouldApply(ledger, SHA_A, { manual: false, retry: false }, Date.parse("2026-09-10T10:02:01Z")).act).toBe(true);
    expect(shouldApply(ledger, SHA_B, { manual: false, retry: false }, Date.parse("2026-09-10T10:01:00Z")).act).toBe(true);
  });

  test("a retry that turns pending drops the block, and a pending applied commit still re-attempts after its backoff", async () => {
    const sha = pushPlan();
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    let clock = Date.parse("2026-09-10T12:00:00Z");
    const now = () => clock;
    const report = { installation: "factory-teams", stage: "published", pending: { reason: "merge-pending" }, sources: [], agents: [] };
    const failed = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resumeWith(1, report) });
    expect(failed.blocked?.sha).toBe(sha);
    const retried = await reconcileOnce({ manual: true, retry: true }, { exec, now, teamResume: resumeWith(75, report) });
    expect(retried.state).toBe("pending");
    expect(retried.blocked).toBeUndefined();
    clock += pendingBackoffSeconds(1) * 1000 + 1;
    const attempts: number[] = [];
    const again = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: (c, p, e) => { attempts.push(75); return resumeWith(75, report)(c, p, e); } });
    expect(attempts).toHaveLength(1); // the timer re-attempted on its own: no blocked gate in the way
    expect(again.pending?.attempts).toBe(2);
    // An operator sync of an already applied commit that turns pending is still re-attempted later.
    clock += pendingBackoffSeconds(2) * 1000 + 1;
    const done = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resumeWith(0, {}), argocdConverged: async () => true });
    expect(done.appliedSha).toBe(sha);
    const synced = await reconcileOnce({ manual: true, retry: false }, { exec, now, teamResume: resumeWith(75, report) });
    expect(synced.state).toBe("pending");
    clock += pendingBackoffSeconds(1) * 1000 + 1;
    const due = await reconcileOnce({ manual: false, retry: false }, { exec, now, teamResume: resumeWith(0, {}), argocdConverged: async () => true });
    expect(due.state).toBe("synced");
    expect(due.pending).toBeUndefined();
  });

  test("the host log and the stored report never carry an environment-file value; a stale report is dropped", async () => {
    pushPlan();
    const file = join(HOME, "log-scrub.env");
    writeFileSync(file, "HG_FACTORY_GIT=private-fixture-token\n", { mode: 0o600 });
    writeConfig(teamConfig({ environmentFile: file }));
    const exec = noInstall((await realExecFor())!);
    const chatty = (c: string, p: string, env: Record<string, string>): ExecResult => ({ exitCode: 0,
      stdout: `token ${env["HG_FACTORY_GIT"]}\n${JSON.stringify({ complete: true, report: { installation: "factory-teams", stage: "complete", sources: [{ id: "social", ref: `x-${env["HG_FACTORY_GIT"]}` }], agents: [] } })}\n`, stderr: `used ${env["HG_FACTORY_GIT"]}` });
    const ledger = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: chatty, argocdConverged: async () => true });
    expect(ledger.state).toBe("synced");
    const logs = readdirSync(logsDir()).map((f) => readFileSync(join(logsDir(), f), "utf8")).join("\n");
    expect(logs).not.toContain("private-fixture-token");
    expect(logs).toContain("«redacted»");
    expect(JSON.stringify(ledger.report)).not.toContain("private-fixture-token");
    // A later run that writes no report leaves none behind.
    pushPlan();
    const quiet = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, undefined as any), argocdConverged: async () => true });
    expect(quiet.report).toBeUndefined();
  });

  test("a plan whose credential names are not all present fails before any resume, naming only the names", async () => {
    pushPlan("infra", ["POSTIZ_TOKEN"]);
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    const calls: string[][] = [];
    const saved = process.env["POSTIZ_TOKEN"]; delete process.env["POSTIZ_TOKEN"];
    try {
      const published: Record<string, unknown>[] = [];
      const ledger = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, {}, calls), publish: (r) => published.push(r) });
      expect(ledger.state).toBe("failed");
      expect(calls).toHaveLength(0);
      // Refused before anything runs, but never anonymously: the status names the installation.
      expect(ledger.installation).toBe("factory-teams");
      expect(published.at(-1)!["installation"]).toBe("factory-teams");
      expect(ledger.blocked!.summary).toContain("POSTIZ_TOKEN");
      expect(ledger.blocked!.summary).not.toContain("HG_FACTORY_GIT"); // resolved from bootstrap config inputs at run time
      // Provided through the environment file, the tick proceeds to the resume.
      const file = join(HOME, "creds.env");
      writeFileSync(file, "POSTIZ_TOKEN=private-fixture-token\n", { mode: 0o600 });
      writeConfig(teamConfig({ environmentFile: file }));
      const ok = await reconcileOnce({ manual: true, retry: true }, { exec, teamResume: resumeWith(0, {}, calls), argocdConverged: async () => true });
      expect(ok.state).toBe("synced");
      expect(calls).toHaveLength(1);
      expect(calls[0]![2]).toContain("POSTIZ_TOKEN");
    } finally { if (saved !== undefined) process.env["POSTIZ_TOKEN"] = saved; }
  });

  // ADR 0196: Pulumi rejects a whole stack config holding the generator's unset placeholder
  // ("validating stack config: bad value") without naming it, so the watcher names it first.
  test("a bootstrap config still carrying an unset placeholder fails before any resume, naming the path and its fix", async () => {
    const { UNSET_SECRET_MARKER } = await import("../src/env/stack-config.ts");
    mkdirSync(join(WORK, "infra"), { recursive: true });
    const configFile = join(WORK, "infra", "Pulumi.factory.yaml");
    writeFileSync(configFile, stringify({ config: {
      "hermes-gitops-bootstrap:gitopsGitToken": { secure: "v1:fixture:CIPHERTEXT-FIXTURE" },
      "hermes-gitops-bootstrap:agentGitAuth": { "workshop-coordinator": { password: { secure: UNSET_SECRET_MARKER } } },
    } }));
    pushPlan("infra");
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    const calls: string[][] = [];
    try {
      const ledger = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, {}, calls) });
      expect(ledger.state).toBe("failed");
      expect(calls).toHaveLength(0);
      expect(ledger.installation).toBe("factory-teams");
      expect(ledger.blocked!.summary).toContain("hermes-gitops-bootstrap:agentGitAuth.workshop-coordinator.password");
      expect(ledger.blocked!.summary).toContain("pulumi config set --secret --path");
      expect(JSON.stringify(ledger)).not.toContain("CIPHERTEXT-FIXTURE");
    } finally { rmSync(configFile, { force: true }); }
  });

  // ADR 0193: the compiler that publishes must be the same revision as the charts Argo CD syncs,
  // so the watcher runs `hg` from the revision the lock records - not whatever it has installed.
  test("the locked platform revision is materialized as a worktree and IS the hg that resumes", async () => {
    const platform = platformRepository();
    pushPlanWithPlatform(platform.url, platform.first);
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    const mains: (string | undefined)[] = [];
    const record = (c: string, p: string, e: Record<string, string>, main?: string): ExecResult => { mains.push(main); return resumeWith(0, {})(c, p, e); };
    const first = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: record, argocdConverged: async () => true });
    expect(first.state).toBe("synced");
    expect(mains[0]).toBe(join(platformDir(), platform.first, "cli", "src", "main.ts"));
    expect(readFileSync(mains[0]!, "utf8")).toContain("revision one");
    // A second tick at the same revision reuses the worktree rather than cloning again.
    pushPlanWithPlatform(platform.url, platform.first);
    await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: record, argocdConverged: async () => true });
    expect(mains[1]).toBe(mains[0]);
    // Moving the lock forward runs the new revision and keeps the one a rollback returns to.
    pushPlanWithPlatform(platform.url, platform.second, platform.first);
    const moved = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: record, argocdConverged: async () => true });
    expect(moved.state).toBe("synced");
    expect(readFileSync(mains[2]!, "utf8")).toContain("revision two");
    expect(readdirSync(platformDir()).sort()).toEqual([platform.first, platform.second].sort());
    // Once the lock stops naming the old revision, its checkout goes.
    pushPlanWithPlatform(platform.url, platform.second);
    await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: record, argocdConverged: async () => true });
    expect(readdirSync(platformDir())).toEqual([platform.second]);
  });

  test("a half-built worktree is rebuilt, and every tick prunes what the lock stopped naming", async () => {
    const platform = platformRepository();
    pushPlanWithPlatform(platform.url, platform.first);
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, {}), argocdConverged: async () => true });
    const worktree = join(platformDir(), platform.first);
    // A run killed between checkout and install leaves the entry point but no stamp: the next
    // tick must rebuild rather than execute a half-installed checkout.
    rmSync(join(worktree, ".hg-platform-ready"));
    writeFileSync(join(worktree, "cli", "src", "main.ts"), "// tampered\n");
    pushPlanWithPlatform(platform.url, platform.first);
    const rebuilt = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, {}), argocdConverged: async () => true });
    expect(rebuilt.state).toBe("synced");
    expect(readFileSync(join(worktree, "cli", "src", "main.ts"), "utf8")).toContain("revision one");
    expect(readFileSync(join(worktree, ".hg-platform-ready"), "utf8").trim()).toBe(platform.first);
    // A tick whose resume FAILS still prunes: retention follows the lock, not the outcome.
    pushPlanWithPlatform(platform.url, platform.second);
    const failed = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: () => ({ exitCode: 3, stdout: "", stderr: "boom" }) });
    expect(failed.state).toBe("failed");
    expect(readdirSync(platformDir())).toEqual([platform.second]);
    // Dropping the platform from the plan leaves no checkout behind at all.
    pushPlan();
    const plain = await reconcileOnce({ manual: true, retry: true }, { exec, teamResume: resumeWith(0, {}), argocdConverged: async () => true });
    expect(plain.state).toBe("synced");
    expect(readdirSync(platformDir())).toEqual([]);
  });

  test("a platform revision the repository does not carry fails before any resume", async () => {
    const platform = platformRepository();
    pushPlanWithPlatform(platform.url, "d".repeat(40));
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    const calls: string[][] = [];
    const ledger = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, {}, calls) });
    expect(ledger.state).toBe("failed");
    expect(calls).toHaveLength(0);
    expect(ledger.blocked!.summary).toContain("platform revision");
    // A lock that records a revision the plan cannot attribute to a repository is also refused.
    pushPlanWithPlatform(undefined, platform.first);
    const orphan = await reconcileOnce({ manual: true, retry: true }, { exec, teamResume: resumeWith(0, {}, calls) });
    expect(orphan.state).toBe("failed");
    expect(orphan.blocked!.summary).toContain("declares no platform.repository");
    expect(calls).toHaveLength(0);
  });

  // Found by e2e step 13 against a real cluster: a plan written as a flow mapping is the same
  // document, and a reader that only recognizes block style refuses a perfectly valid plan.
  test("the bootstrap directory is read from the document, whatever style it is written in", () => {
    const dir = mkdtempSync(join(HOME, "bootstrap-"));
    const plan = join(dir, "installation.yaml");
    writeFileSync(plan, "version: 2\nbootstrap:\n  directory: infra\n  stack: s\n");
    expect(planBootstrapDirectory(plan)).toBe("infra");
    writeFileSync(plan, `version: 2\nbootstrap: {directory: infra, stack: s}\n`);
    expect(planBootstrapDirectory(plan)).toBe("infra");
    writeFileSync(plan, JSON.stringify({ version: 2, bootstrap: { directory: "infra", stack: "s" } }, null, 2));
    expect(planBootstrapDirectory(plan)).toBe("infra");
    for (const bad of [{ directory: "/etc", stack: "s" }, { directory: "../escape", stack: "s" }, { stack: "s" }]) {
      writeFileSync(plan, JSON.stringify({ version: 2, bootstrap: bad }));
      expect(() => planBootstrapDirectory(plan)).toThrow(/relative path inside the checkout/);
    }
  });

  test("the plan and lock readers agree with the real parser, and refuse what escapes the checkout", () => {
    const dir = mkdtempSync(join(HOME, "readers-"));
    const plan = join(dir, "installation.yaml"), lock = join(dir, "installation.lock.yaml");
    writeFileSync(plan, "version: 2\nlock: teams/installation.lock.yaml\nplatform:\n  repository: https://github.com/example/platform\n  ref: refs/tags/v1.0.0\n");
    expect(planLockFile(plan)).toBe("teams/installation.lock.yaml");
    expect(planPlatform(plan)).toEqual({ repository: "https://github.com/example/platform" });
    // A flow mapping is the same document: the launcher must not read it as "no platform".
    writeFileSync(plan, `version: 2\nlock: teams/l.yaml\nplatform: {repository: "https://github.com/example/platform", ref: refs/tags/v1, credentialEnv: PLATFORM_TOKEN}\n`);
    expect(planPlatform(plan)).toEqual({ repository: "https://github.com/example/platform", credentialEnv: "PLATFORM_TOKEN" });
    writeFileSync(plan, "version: 2\nplatform:\n  repository: https://token@github.com/example/platform\n  ref: refs/tags/v1\n");
    expect(() => planPlatform(plan)).toThrow(/credential-free/);
    writeFileSync(plan, "version: 2\n");
    expect(planLockFile(plan)).toBeUndefined();
    expect(planPlatform(plan)).toBeUndefined();
    writeFileSync(lock, `version: 2\nplatform: {ref: refs/tags/v1.0.0, revision: ${"e".repeat(40)}, previousRevision: ${"f".repeat(40)}}\n`);
    expect(lockPlatformRevisions(lock)).toEqual({ revision: "e".repeat(40), previousRevision: "f".repeat(40) });
    writeFileSync(lock, "version: 2\nsources: {}\n");
    expect(lockPlatformRevisions(lock)).toBeUndefined();
    writeFileSync(lock, "version: 2\nplatform:\n  ref: main\n  revision: main\n");
    expect(() => lockPlatformRevisions(lock)).toThrow(/full 40-character commit/);
  });

  test("a lock the checkout does not really contain never decides which code runs", () => {
    const checkout = mkdtempSync(join(HOME, "boundary-")), outside = mkdtempSync(join(HOME, "outside-"));
    writeFileSync(join(outside, "planted.yaml"), "version: 2\n");
    expect(() => checkoutFile(checkout, "../outside/planted.yaml")).toThrow(/inside the checkout/);
    expect(() => checkoutFile(checkout, "/etc/passwd")).toThrow(/inside the checkout/);
    symlinkSync(join(outside, "planted.yaml"), join(checkout, "link.yaml"));
    expect(() => checkoutFile(checkout, "link.yaml")).toThrow(/symbolic link/);
    mkdirSync(join(checkout, "real"), { recursive: true });
    symlinkSync(outside, join(checkout, "escape"));
    expect(() => checkoutFile(checkout, "escape/planted.yaml")).toThrow(/outside the checkout/);
    writeFileSync(join(checkout, "real", "installation.yaml"), "version: 2\n");
    expect(checkoutFile(checkout, "real/installation.yaml")).toBe(join(realpathSync(checkout), "real", "installation.yaml"));
  });

  // Found by e2e step 13 on a real cluster: a resume that fails before writing a report left
  // the published status with no installation, so a failed watcher was unattributable.
  test("a failed team tick still publishes a status naming its installation", async () => {
    pushPlan();
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    const published: Record<string, unknown>[] = [];
    const ledger = await reconcileOnce({ manual: false, retry: false }, {
      exec, teamResume: () => ({ exitCode: 4, stdout: "", stderr: "resume exploded" }),
      publish: (record) => published.push(record),
    });
    expect(ledger.state).toBe("failed");
    expect(ledger.installation).toBe("factory-teams");
    expect(published.at(-1)!["installation"]).toBe("factory-teams");
    expect(published.at(-1)!["phase"]).toBe("failed");
  });

  test("a failing resume blocks like any failed apply; a missing plan fails before any resume", async () => {
    const sha = pushPlan();
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    const failed = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(1, { installation: "factory-teams", stage: "runtime-verified" }) });
    expect(failed.state).toBe("failed");
    expect(failed.blocked?.sha).toBe(sha);
    expect(failed.pending).toBeUndefined();
    writeConfig(teamConfig({ team: { plan: "teams/missing.yaml" } }));
    const calls: string[][] = [];
    const missing = await reconcileOnce({ manual: false, retry: true }, { exec, teamResume: resumeWith(0, {}, calls) });
    expect(missing.state).toBe("failed");
    expect(calls).toHaveLength(0);
  });

  test("a re-pointed watcher starts a fresh ledger", async () => {
    const sha = pushPlan();
    writeConfig(teamConfig());
    const exec = noInstall((await realExecFor())!);
    const first = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, {}), argocdConverged: async () => true });
    expect(first.appliedSha).toBe(sha);
    writeConfig(teamConfig({ branch: "release" }));
    const other = readLedger(teamConfig({ branch: "release" }));
    expect(other.appliedSha).toBe(sha); // on disk it is still the old ledger...
    const ledger = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: resumeWith(0, {}) });
    expect(ledger.branch).toBe("release");
    expect(ledger.appliedSha).toBeUndefined(); // ...but the tick discards it: no release branch exists yet
    expect(["degraded", "failed", "authentication-required"]).toContain(ledger.state);
  });

  test("the unit loads a 0600 environment file and the tick refuses a world-readable one", () => {
    const file = join(HOME, "watcher.env");
    writeFileSync(file, "HG_FACTORY_GIT=private-fixture-token\n", { mode: 0o600 });
    const cfg = teamConfig({ environmentFile: file });
    const units = unitFiles(cfg, { bun: "/bin/bun", main: "/app/main.ts" });
    expect(units.service).toContain(`EnvironmentFile=-${file}`);
    expect(units.service).not.toContain("private-fixture-token");
    expect(readEnvironmentFile(file)).toEqual({ HG_FACTORY_GIT: "private-fixture-token" });
    expect(readEnvironmentFile(undefined)).toEqual({});
    expect(readEnvironmentFile(join(HOME, "absent.env"))).toEqual({});
    chmodSync(file, 0o644);
    expect(() => readEnvironmentFile(file)).toThrow(/mode 644/);
  });

  test("environment-file values are scrubbed from what leaves the host", async () => {
    pushPlan();
    const file = join(HOME, "scrub.env");
    writeFileSync(file, "HG_FACTORY_GIT=private-fixture-token\n", { mode: 0o600 });
    writeConfig(teamConfig({ environmentFile: file }));
    const exec = noInstall((await realExecFor())!);
    const leaky = (c: string, p: string, env: Record<string, string>): ExecResult => ({ exitCode: 1, stdout: "", stderr: `auth failed for ${env["HG_FACTORY_GIT"]}` });
    const ledger = await reconcileOnce({ manual: false, retry: false }, { exec, teamResume: leaky });
    expect(ledger.state).toBe("failed");
    expect(JSON.stringify(ledger)).not.toContain("private-fixture-token");
    expect(ledger.blocked!.summary).toContain("«redacted»");
  });

  test("pure helpers: the plan's bootstrap directory and the report's JSON document", () => {
    const plan = join(HOME, "plan.yaml");
    writeFileSync(plan, "version: 2\nid: x\nbootstrap:\n  directory: infra   # the Pulumi program\n  stack: factory\n");
    expect(planBootstrapDirectory(plan)).toBe("infra");
    writeFileSync(plan, "version: 2\nbootstrap:\n  directory: ../escape\n");
    expect(() => planBootstrapDirectory(plan)).toThrow(/relative path/);
    writeFileSync(plan, "version: 2\nbootstrap:\n  stack: factory\n");
    expect(() => planBootstrapDirectory(plan)).toThrow(/relative path/);
    expect(lastJsonDocument('team x: validated\n{"complete":false,"report":{"stage":"published"}}\n')).toEqual({ complete: false, report: { stage: "published" } });
    expect(lastJsonDocument('{"a":1}')).toEqual({ a: 1 });
    expect(lastJsonDocument("nothing here")).toBeUndefined();
    expect(lastJsonDocument("[1,2]")).toBeUndefined();
  });

  test("the v1alpha2 record allowlists report fields and validates against the contract", async () => {
    const { validateDocument } = await import("../src/skills/contract.ts");
    const schema = JSON.parse(readFileSync(join(import.meta.dir, "../../agent-bundle-contracts/runtime-overlay/v1alpha2/reconciliation-status.schema.json"), "utf8"));
    const Ajv = (await import("ajv/dist/2020")).default;
    const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
    const ledger = ledgerWith({ state: "pending", desiredSha: SHA_A,
      pending: { sha: SHA_A, attempts: 2, lastAt: "2026-09-10T10:00:00.000Z", nextAttemptAt: "2026-09-10T10:04:00.000Z", reason: "approval-required", link: "javascript:alert(1)", stage: "validated" },
      report: { installation: "Factory Teams", stage: "validated; rm -rf", sources: [{ id: "social", ref: "refs/tags/v1", desiredSha: "short" }], agents: [{ name: "manager", source: "social", runtimeDigest: "has space here", eveVersion: "0.42.0", ready: "yes", secret: "x" }] } });
    const record = teamRecord(ledger, "team");
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    expect(record["installation"]).toBeUndefined();
    expect(record["stage"]).toBeUndefined();
    expect((record["pending"] as any).link).toBeUndefined();
    expect(record["sources"]).toEqual([{ id: "social", ref: "refs/tags/v1" }]);
    expect(record["agents"]).toEqual([{ name: "manager", source: "social", eveVersion: "0.42.0" }]);
    expect(validateDocument).toBeDefined();
    // A command-kind watcher keeps the v1alpha1 shape untouched.
    expect(teamRecord(ledgerWith({ state: "synced" }))["apiVersion"]).toBe("nexus.hermes.ai/v1alpha1");
  });
});

// ---------------------------------------------------------------------------
// Content-only commits (ADR 0198): an apply that rolled nothing out still applies the commit,
// and the host ledger records the reason `hg team` gave.

describe("an apply that rolls nothing out", () => {
  const reason = `source social ${"3".repeat(12)}: no agent input changed since ${"9".repeat(12)}`;

  test("a command-kind apply that reports skipped.reason applies the commit with that note", async () => {
    const sha = push(`content-only ${Date.now()}`);
    writeConfig(baseConfig({ apply: `printf '%s\\n' '${JSON.stringify({ complete: true, skipped: { reason, at: "t" } })}'` }));
    const ledger = await reconcileOnce({ manual: false, retry: false }, { argocdConverged: async () => true });
    expect(ledger.state).toBe("synced");
    expect(ledger.appliedSha).toBe(sha);
    expect(ledger.history.at(-1)!.note).toBe(reason);
  });

  test("a team-kind resume that reports skipped.reason applies the commit with that note", async () => {
    const sha = pushPlan();
    writeConfig(teamConfig());
    const ledger = await reconcileOnce({ manual: false, retry: false }, {
      exec: noInstall((await realExecFor())!), argocdConverged: async () => true,
      teamResume: () => ({ exitCode: 0, stdout: `${JSON.stringify({ complete: true, skipped: { reason, at: "t" }, report: { installation: "factory-teams", stage: "complete", skipped: reason } })}\n`, stderr: "" }),
    });
    expect(ledger.appliedSha).toBe(sha);
    expect(ledger.history.at(-1)!.note).toBe(reason);
  });

  test("an apply that says nothing records no note", async () => {
    push(`plain ${Date.now()}`);
    writeConfig(baseConfig());
    const ledger = await reconcileOnce({ manual: false, retry: false }, { argocdConverged: async () => true });
    expect(ledger.history.at(-1)!.note).toBeUndefined();
  });
});
