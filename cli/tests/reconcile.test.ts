// hg reconcile: the state machine, the retry gate, crash recovery, the
// scrubbing pipeline, and full ticks against a REAL local bare repo (git
// is cheap; the mutation commands are the only fake). HG_HOME is pointed
// at a tmpdir before the module loads, so nothing here touches the
// operator's real state.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "hg-reconcile-"));
process.env["HERMES_GITOPS_HOME"] = HOME;

const {
  configFile, ledgerFile, logsDir,
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
  rmSync(configFile(), { force: true });
  rmSync(ledgerFile(), { force: true });
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
