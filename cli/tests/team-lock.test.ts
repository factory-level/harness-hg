import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { digest, immutableRef, validatePlan, type TeamPlan } from "../src/team/plan.ts";
import { compileLock, lockedCommit, lockPath, planDigest, readLock, renderLock, validateLock, verifyLock, writeLockFile } from "../src/team/lock.ts";
import { assertAllowedRuntimes, effectiveRuntime } from "../src/team/runtime.ts";
import versions from "../../versions.json";
import { resolveRef, resolveSources } from "../src/team/command.ts";

const temporary: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-lock-test-")); temporary.push(dir); return dir; }
afterEach(() => { for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const COMMIT = "c".repeat(40);
const DEFAULT_IMAGE = `example/eve@sha256:${"a".repeat(64)}`;
const OTHER = "d".repeat(40);

function plan(overrides: Record<string, unknown> = {}, ref = "refs/tags/v1.0.0"): TeamPlan {
  return {
    version: 2, id: "factory", lock: "teams/installation.lock.yaml",
    sources: [{ id: "social", repository: "https://github.com/example/social", ref, private: false,
      agents: [{ name: "manager", subdir: "agents/eve/manager/src", environment: [], tools: [], writablePaths: [], skills: [] }] }],
    destination: { repository: "https://github.com/example/generated", branch: "main", credentialEnv: "GITOPS_TOKEN", autoMerge: false },
    environment: "environment.yaml", argoDestinations: ["in-cluster"], bootstrap: { directory: "infra", stack: "test" }, kubeContext: "test",
    runtime: { image: `example/eve@sha256:${"a".repeat(64)}`, platform: "linux/amd64" }, authorizations: [],
    acceptance: [{ id: "verify-manager", source: "social", agent: "manager", argv: ["node", "verify.mjs"], effect: "read" }],
    ...overrides,
  } as TeamPlan;
}

function privateChartPlan(version: 1 | 2, revision?: string): TeamPlan {
  const base = plan({ version, ...(version === 1 ? { lock: undefined } : {}) }, version === 1 ? "main" : "refs/tags/v1.0.0");
  const source = base.sources[0]!;
  return { ...base, sources: [{ ...source, private: true, credentialEnv: "SOCIAL_TOKEN",
    agents: [{ ...source.agents[0]!, gitAuthSecretRef: "social-git",
      appChartSource: { repository: source.repository, ...(revision ? { revision } : {}) } }] }] };
}

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
function git(cwd: string, ...args: string[]) { return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim(); }
function sourceRepository() {
  const dir = temp();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowReachableSHA1InWant", "true");
  fs.writeFileSync(path.join(dir, "README.md"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-q", "-m", "one"); git(dir, "tag", "v1.0.0");
  const first = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, "README.md"), "two\n");
  git(dir, "commit", "-q", "-am", "two");
  return { dir, first, second: git(dir, "rev-parse", "HEAD") };
}

describe("version 2 installation plans", () => {
  test("pin explicit tag refs or full commits, never branches, and name their lock", () => {
    expect(() => validatePlan(plan())).not.toThrow();
    expect(() => validatePlan(plan({}, COMMIT))).not.toThrow();
    for (const ref of ["main", "v1.0.0", "refs/heads/main", "refs/tags/../main", "refs/tags/v1.lock", "refs/tags/", "0".repeat(40), "C".repeat(40)]) {
      expect(immutableRef(ref)).toBe(false);
      expect(() => validatePlan(plan({}, ref))).toThrow(/never a branch/);
    }
    expect(() => validatePlan(plan({ lock: undefined }))).toThrow(/lock file/);
    expect(() => validatePlan(plan({ lock: "../outside.lock.yaml" }))).toThrow(/lock file/);
    expect(() => validatePlan(plan({ version: 1 }, "main"))).toThrow(/only version 2/);
    expect(() => validatePlan(plan({ version: 1, lock: undefined }, "main"))).not.toThrow();
  });

  test("tag refs follow git's own ref-name rules", () => {
    const names = ["v1.0.0", "v1+build.7", "release@2026", "nested/v2", "@", "-dash", "v1..2", ".hidden", "nested/.dot", "v1.",
      "a b", "x@{1}", "v1.lock", "trailing/", "double//slash", "q?", "star*", "bracket[", "caret^", "tilde~", "colon:", "back\\slash", "tab\tname"];
    for (const name of names) {
      let gitAccepts = true;
      try { execFileSync("git", ["check-ref-format", `refs/tags/${name}`], { stdio: "ignore" }); } catch { gitAccepts = false; }
      expect([name, immutableRef(`refs/tags/${name}`)]).toEqual([name, gitAccepts]);
    }
  });

  test("a version 1 installation's evidence input is unchanged by the lock field", () => {
    const v1 = validatePlan(plan({ version: 1, lock: undefined }, "main"));
    expect(digest({ plan: v1, lock: undefined, projection: "p" })).toBe(digest({ plan: v1, projection: "p" }));
  });

  test("version 2 derives the app chart revision from the locked source commit", () => {
    expect(() => validatePlan(privateChartPlan(2))).not.toThrow();
    expect(() => validatePlan(privateChartPlan(2, COMMIT))).toThrow(/derives appChartSource.revision/);
    expect(() => validatePlan(privateChartPlan(1, COMMIT))).not.toThrow();
    expect(() => validatePlan(privateChartPlan(1))).toThrow(/immutable commit/);
  });
});

describe("installation lock", () => {
  test("compile resolves every ref, binds this exact plan and renders deterministic bytes", async () => {
    const valid = validatePlan(plan());
    const lock = await compileLock(valid, async () => `${COMMIT}\n`);
    expect(lock).toEqual({ version: 2, installation: "factory", planDigest: planDigest(valid), sources: { social: { ref: "refs/tags/v1.0.0", commit: COMMIT } },
      agents: { manager: { image: DEFAULT_IMAGE, eveVersion: versions.runtimes.eve.version } } });
    const text = renderLock(lock);
    expect(renderLock(await compileLock(valid, async () => COMMIT))).toBe(text);
    expect(text.startsWith("# Generated by `hg team compile`")).toBe(true);
    expect(validateLock(parse(text))).toEqual(lock);
  });

  test("compile refuses version 1 plans, unresolved refs and a commit ref that resolves elsewhere", async () => {
    await expect(compileLock({ ...validatePlan(plan()), version: 1 }, async () => COMMIT)).rejects.toThrow(/version 2/);
    await expect(compileLock(validatePlan(plan()), async () => "not-a-commit")).rejects.toThrow(/did not resolve/);
    await expect(compileLock(validatePlan(plan({}, COMMIT)), async () => OTHER)).rejects.toThrow(/different commit/);
  });

  test("a changed plan, foreign installation or different source set makes the lock unusable", async () => {
    const valid = validatePlan(plan());
    const lock = await compileLock(valid, async () => COMMIT);
    expect(() => verifyLock(valid, lock)).not.toThrow();
    expect(() => verifyLock(validatePlan(plan({ kubeContext: "other" })), lock)).toThrow(/stale/);
    expect(() => verifyLock(valid, { ...lock, installation: "other" })).toThrow(/different installation/);
    expect(() => verifyLock(valid, { ...lock, sources: {} })).toThrow(/exactly the plan's sources/);
    expect(() => verifyLock(valid, { ...lock, sources: { social: { ref: COMMIT, commit: COMMIT } } })).toThrow(/different ref/);
    expect(() => verifyLock(valid, { ...lock, agents: {} })).toThrow(/exactly the plan's agents/);
    expect(() => verifyLock(valid, { ...lock, agents: { manager: { image: lock.agents.manager!.image, eveVersion: "9.9.9" } } })).toThrow(/different runtime for manager/);
  });

  // ADR 0192: a canary is one agent on an allowed runtime, recorded in the lock like everything
  // else that deploys. Nothing outside versions.json runtimes.eve.allowed may be pinned.
  test("a per-agent runtime pin must be one the platform publishes, and the lock records it", async () => {
    const pinned = { image: `example/eve@sha256:${"b".repeat(64)}`, eveVersion: "0.43.0" };
    const withPin = plan();
    withPin.sources[0]!.agents[0]!.runtime = pinned;
    const valid = validatePlan(withPin);
    expect(() => assertAllowedRuntimes(valid, [])).toThrow(/not one the platform publishes/);
    expect(() => assertAllowedRuntimes(valid, [{ version: "0.43.0", image: pinned.image }])).not.toThrow();
    // Only the PAIR is allowed: the same image at another version is not that entry.
    expect(() => assertAllowedRuntimes(valid, [{ version: "0.44.0", image: pinned.image }])).toThrow(/not one the platform publishes/);
    expect(effectiveRuntime(valid, valid.sources[0]!.agents[0]!)).toEqual(pinned);
    // The shipped list is closed: with none published, no pin passes.
    expect(() => assertAllowedRuntimes(valid)).toThrow(/versions.json runtimes.eve.allowed/);
    // An unpinned agent is always the installation default, and needs no allowed entry.
    const plain = validatePlan(plan());
    expect(() => assertAllowedRuntimes(plain, [])).not.toThrow();
    expect(effectiveRuntime(plain, plain.sources[0]!.agents[0]!)).toEqual({ image: DEFAULT_IMAGE, eveVersion: versions.runtimes.eve.version });
    // The pin's shape is refused before any list is consulted.
    for (const bad of [{ image: "example/eve:0.43.0", eveVersion: "0.43.0" }, { image: pinned.image, eveVersion: "latest" }, { image: pinned.image } as any]) {
      const broken = plan();
      broken.sources[0]!.agents[0]!.runtime = bad;
      expect(() => validatePlan(broken)).toThrow(/manager/);
    }
    const v1 = plan({ version: 1, lock: undefined }, "main");
    v1.sources[0]!.agents[0]!.runtime = pinned;
    expect(() => validatePlan(v1)).toThrow(/only version 2 plans pin/);
  });

  test("a tag that moved after compile refuses instead of publishing a different commit", async () => {
    const valid = validatePlan(plan());
    const lock = await compileLock(valid, async () => COMMIT);
    expect(lockedCommit(lock, valid.sources[0]!, COMMIT)).toBe(COMMIT);
    expect(() => lockedCommit(lock, valid.sources[0]!, OTHER)).toThrow(/now resolves to dddddddddddd, not the locked cccccccccccc/);
  });

  test("lock documents are strict", async () => {
    const lock = await compileLock(validatePlan(plan()), async () => COMMIT);
    for (const bad of [
      null, [], {}, { ...lock, extra: 1 }, { ...lock, version: 1 }, { ...lock, planDigest: "short" },
      { ...lock, agents: { manager: { image: "eve:latest", eveVersion: "0.1.0" } } },
      { ...lock, agents: { manager: { image: DEFAULT_IMAGE, eveVersion: "latest" } } },
      { ...lock, agents: { manager: { image: DEFAULT_IMAGE, eveVersion: versions.runtimes.eve.version, extra: 1 } } },
      { ...lock, sources: { social: { ref: "main", commit: COMMIT } } },
      { ...lock, sources: { social: { ref: COMMIT, commit: OTHER } } },
      { ...lock, sources: { social: { ref: "refs/tags/v1.0.0", commit: COMMIT, note: "x" } } },
    ]) expect(() => validateLock(bad)).toThrow(/installation lock/);
  });

  // An installation that locked its sources before runtimes were recorded keeps reconciling: the
  // lock still governs every commit. It just cannot vouch for a pin, so a pinned plan recompiles.
  test("a version 1 lock still verifies an unpinned plan and refuses a pinned one", async () => {
    const valid = validatePlan(plan());
    const v2 = await compileLock(valid, async () => COMMIT);
    const { agents, ...rest } = v2;
    const v1 = { ...rest, version: 1 as const };
    expect(validateLock(v1)).toEqual(v1);
    expect(() => verifyLock(valid, v1)).not.toThrow();
    expect(() => renderLock(v1)).toThrow(/version 2/);
    const pinnedPlan = plan();
    pinnedPlan.sources[0]!.agents[0]!.runtime = { image: `example/eve@sha256:${"b".repeat(64)}`, eveVersion: "0.43.0" };
    const pinned = validatePlan(pinnedPlan);
    expect(() => verifyLock(pinned, { ...v1, planDigest: planDigest(pinned) })).toThrow(/predates per-agent runtimes.*manager/s);
  });

  // ADR 0193: the platform revision is resolved into the lock beside the sources, and the
  // revision it replaces is what a rollback returns to.
  test("the platform ref resolves into the lock and carries the revision it replaces", async () => {
    const REV_A = "1".repeat(40), REV_B = "2".repeat(40);
    const credentials = { configFile: "infra/Pulumi.test.yaml", bindings: {} };
    const withPlatform = plan({ credentials, platform: { repository: "https://github.com/example/platform", ref: "refs/tags/v1.0.0" } });
    const valid = validatePlan(withPlatform);
    const resolve = (revision: string) => async (target: { id: string }) => target.id === "platform~" ? revision : COMMIT;
    const first = await compileLock(valid, resolve(REV_A));
    expect(first.platform).toEqual({ ref: "refs/tags/v1.0.0", revision: REV_A });
    // Moving forward records what it replaced; re-compiling at the same revision keeps it.
    const second = await compileLock(valid, resolve(REV_B), first);
    expect(second.platform).toEqual({ ref: "refs/tags/v1.0.0", revision: REV_B, previousRevision: REV_A });
    const again = await compileLock(valid, resolve(REV_B), second);
    expect(again.platform).toEqual({ ref: "refs/tags/v1.0.0", revision: REV_B, previousRevision: REV_A });
    // Rolling back to the revision we came from never records itself as its own predecessor.
    const back = await compileLock(valid, resolve(REV_A), second);
    expect(back.platform).toEqual({ ref: "refs/tags/v1.0.0", revision: REV_A, previousRevision: REV_B });
    expect(validateLock(parse(renderLock(second)))).toEqual(second);
    // A plan with no platform locks none, and a commit ref must resolve to itself.
    expect((await compileLock(validatePlan(plan()), resolve(REV_A))).platform).toBeUndefined();
    // Without the encrypted baseline there is nowhere to carry the revision, so it is refused.
    expect(() => validatePlan(plan({ platform: { repository: "https://github.com/example/platform", ref: REV_A } }))).toThrow(/needs credentials.configFile/);
    const pinned = validatePlan(plan({ credentials, platform: { repository: "https://github.com/example/platform", ref: REV_A } }));
    await expect(compileLock(pinned, resolve(REV_B))).rejects.toThrow(/Platform: commit ref resolved to a different commit/);
    await expect(compileLock(pinned, async () => "not-a-commit")).rejects.toThrow(/did not resolve/);
    for (const bad of [{ repository: "https://github.com/example/platform", ref: "main" }, { repository: "git://example.com/p", ref: REV_A },
      { repository: "https://github.com/example/platform", ref: REV_A, extra: 1 },
      { repository: "https://gitlab.com/example/platform", ref: REV_A, credentialEnv: "PLATFORM_TOKEN" },
      { repository: "https://github.com/example/platform", ref: REV_A, credentialEnv: "lowercase" }]) {
      expect(() => validatePlan(plan({ credentials, platform: bad }))).toThrow(/platform/);
    }
    expect(() => validatePlan(plan({ version: 1, lock: undefined, credentials, platform: { repository: "https://github.com/example/platform", ref: REV_A } }, "main"))).toThrow(/only version 2/);
    // A private platform repository resolves with its own credential, under its own scratch name.
    const privatePlan = validatePlan(plan({ credentials, platform: { repository: "https://github.com/example/platform", ref: "refs/tags/v1.0.0", credentialEnv: "PLATFORM_TOKEN" } }));
    const seen: { id: string; private: boolean; credentialEnv?: string }[] = [];
    await compileLock(privatePlan, async (t: any) => { seen.push({ id: t.id, private: t.private, credentialEnv: t.credentialEnv }); return t.id === "platform~" ? REV_A : COMMIT; });
    expect(seen.at(-1)).toEqual({ id: "platform~", private: true, credentialEnv: "PLATFORM_TOKEN" });
    // The lock must describe the platform the plan declares, not another valid-looking one.
    const locked = await compileLock(privatePlan, resolve(REV_A));
    expect(() => verifyLock(privatePlan, { ...locked, platform: { ref: REV_B, revision: REV_B } })).toThrow(/different platform revision/);
    expect(() => verifyLock(privatePlan, { ...locked, platform: undefined })).toThrow(/different platform revision/);
    for (const bad of [{ ...second, platform: { ref: "refs/tags/v1.0.0", revision: "short" } },
      { ...second, platform: { ref: "main", revision: REV_A } },
      { ...second, platform: { ref: REV_A, revision: REV_B } },
      { ...second, platform: { ref: "refs/tags/v1.0.0", revision: REV_A, previousRevision: REV_A } }]) {
      expect(() => validateLock(bad)).toThrow(/installation lock/);
    }
  });

  test("the lock path stays inside the bootstrap checkout and is never a symbolic link", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "teams"));
    expect(lockPath(root, "teams/installation.lock.yaml")).toBe(path.join(fs.realpathSync(root), "teams", "installation.lock.yaml"));
    expect(() => lockPath(root, "../escape.lock.yaml")).toThrow(/outside/);
    expect(() => lockPath(root, "missing/installation.lock.yaml")).toThrow(/does not exist/);
    fs.symlinkSync(path.join(root, "nowhere.yaml"), path.join(root, "teams", "dangling.lock.yaml"));
    expect(() => lockPath(root, "teams/dangling.lock.yaml")).toThrow(/symbolic link/);
    expect(() => readLock(path.join(root, "teams", "installation.lock.yaml"))).toThrow(/missing/);
  });

  test("writing the lock never follows a planted temporary path", () => {
    const root = temp();
    const outside = path.join(temp(), "victim.txt");
    fs.writeFileSync(outside, "untouched");
    const file = path.join(root, "installation.lock.yaml");
    fs.symlinkSync(outside, `${file}.planted.tmp`);
    expect(() => writeLockFile(file, "lock\n", "planted")).toThrow(/temporary file already exists/);
    expect(fs.readFileSync(outside, "utf8")).toBe("untouched");
    writeLockFile(file, "lock\n");
    expect(fs.readFileSync(file, "utf8")).toBe("lock\n");
    expect(fs.readdirSync(root).filter(entry => entry.endsWith(".tmp"))).toEqual(["installation.lock.yaml.planted.tmp"]);
  });
});

describe("source resolution against a real repository", () => {
  test("a tag and a commit resolve to exact commits, and moving the tag is caught against the lock", async () => {
    const repo = sourceRepository();
    const valid = validatePlan(plan());
    const definition = { ...valid.sources[0]!, repository: repo.dir };
    expect((await resolveRef(definition, temp())).sha).toBe(repo.first);
    expect((await resolveRef({ ...definition, ref: repo.second }, temp())).sha).toBe(repo.second);
    const lock = await compileLock(valid, async source => (await resolveRef({ ...source, repository: repo.dir }, temp())).sha);
    expect(lock.sources.social!.commit).toBe(repo.first);
    const local = { ...valid, sources: [definition] };
    expect((await resolveSources(local, temp(), lock))[0]!.sha).toBe(repo.first);
    git(repo.dir, "tag", "-f", "v1.0.0", repo.second);
    const moved = await resolveRef(definition, temp());
    expect(moved.sha).toBe(repo.second);
    await expect(resolveSources(local, temp(), lock)).rejects.toThrow(/review the moved tag/);
  });
});
