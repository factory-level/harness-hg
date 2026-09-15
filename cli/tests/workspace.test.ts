import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify as yaml } from "yaml";
import type { NormalizedWorkspaceBinding } from "../src/workspace/bindings.ts";
import {
  findAlertScenario,
  groupBindings,
  judgeBound,
  parseProbeOutput,
  scenarioFromRows,
  trackedFreshness,
  workspaceList,
  type DesiredWorkspaces,
  type VerifyRow,
} from "../src/workspace/index.ts";

const PIN = "a".repeat(40);

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function binding(over: Partial<NormalizedWorkspaceBinding> = {}): NormalizedWorkspaceBinding {
  return {
    repository: "vision-manager",
    source: "https://github.com/org/vision-manager",
    resolvedRevision: PIN,
    mountPath: "/workspaces/vision-manager",
    access: "read-only",
    purpose: "strategy-context",
    targetProfiles: ["manager", "research"],
    ...over,
  };
}

function desired(over: Partial<DesiredWorkspaces> = {}): DesiredWorkspaces {
  return {
    declaration: "/env/workspaces.yaml",
    bindings: [binding()],
    findings: [],
    selfRepositories: new Set(),
    bundledProfiles: new Set(),
    ...over,
  };
}

function row(over: Partial<VerifyRow>): VerifyRow {
  return {
    profile: "manager",
    repository: "vision-manager",
    namespace: "hermes-manager",
    shape: "independent",
    expected: "mounted",
    mountPath: "/workspaces/vision-manager",
    access: "read-only",
    resolvedRevision: PIN,
    probe: {
      repository: "vision-manager",
      present: true,
      revision: PIN,
      readable: true,
      writable: false,
      marker: "sha",
    },
    credentialOk: null,
    ok: true,
    problems: [],
    ...over,
  };
}

describe("parseProbeOutput", () => {
  test("parses the full probe line set per repository", () => {
    const out = [
      "vision mount=present",
      `vision head=${PIN}`,
      "vision read=ok",
      "vision write=denied",
      "vision marker=sha",
      "other mount=absent",
      "other marker=missing",
      "Defaulted container noise that is not a probe line",
    ].join("\n");
    const probes = parseProbeOutput(out, [
      { name: "vision", mountPath: "/workspaces/vision" },
      { name: "other", mountPath: "/workspaces/other" },
    ]);
    expect(probes[0]).toEqual({
      repository: "vision",
      present: true,
      revision: PIN,
      readable: true,
      writable: false,
      marker: "sha",
    });
    expect(probes[1]).toEqual({
      repository: "other",
      present: false,
      revision: null,
      readable: false,
      writable: null,
      marker: "missing",
    });
  });

  test("an unavailable marker survives even when the mount looks present", () => {
    const probes = parseProbeOutput("r mount=present\nr marker=unavailable", [
      { name: "r", mountPath: "/workspaces/r" },
    ]);
    expect(probes[0]!.marker).toBe("unavailable");
  });
});

describe("scenarioFromRows", () => {
  test("a clean binding passes with the declaration's own profile list", () => {
    const d = desired();
    const rows = [
      row({}),
      row({ profile: "research", namespace: "hermes-research" }),
      row({
        profile: "bystander",
        expected: "absent",
        probe: { repository: "vision-manager", present: false, revision: null, readable: false, writable: null, marker: "missing" },
      }),
    ];
    const s = scenarioFromRows(d, groupBindings(d.bindings)[0]!, rows);
    expect(s.name).toBe("business-context");
    expect(s.pass).toBe(true);
    expect(s.revisionMatched).toBe(true);
    expect(s.readOnlyVerified).toBe(true);
    expect(s.expectedVisibleProfiles).toEqual(["manager", "research"]);
    expect(s.unexpectedVisibleProfiles).toEqual([]);
  });

  test("a self repository names the operation-source scenario", () => {
    const d = desired({ selfRepositories: new Set(["vision-manager"]) });
    const s = scenarioFromRows(d, groupBindings(d.bindings)[0]!, [row({})]);
    expect(s.name).toBe("sre-operation-source");
  });

  test("revision drift and an unbound-visible profile both fail the scenario", () => {
    const d = desired();
    const drifted = row({
      probe: { repository: "vision-manager", present: true, revision: "b".repeat(40), readable: true, writable: false, marker: "sha" },
      ok: false,
      problems: ["revision drift"],
    });
    const leaked = row({
      profile: "bystander",
      expected: "absent",
      probe: { repository: "vision-manager", present: true, revision: null, readable: true, writable: true, marker: "missing" },
      ok: false,
      problems: ["visible to a profile its binding does not name"],
    });
    const s = scenarioFromRows(d, groupBindings(d.bindings)[0]!, [drifted, leaked]);
    expect(s.pass).toBe(false);
    expect(s.revisionMatched).toBe(false);
    expect(s.unexpectedVisibleProfiles).toEqual(["bystander"]);
  });

  test("a self group's per-profile bindings never read as leakage or drift", () => {
    // `source: self` expands to one binding per profile under ONE
    // repository name - the group is the unit, and each bound row judges
    // against ITS OWN resolved revision.
    const perProfile = [
      binding({ repository: "op-source", mountPath: "/workspaces/op", targetProfiles: ["manager"] }),
      binding({
        repository: "op-source",
        mountPath: "/workspaces/op",
        resolvedRevision: "b".repeat(40),
        targetProfiles: ["research"],
      }),
    ];
    const d = desired({ bindings: perProfile, selfRepositories: new Set(["op-source"]) });
    const group = groupBindings(d.bindings)[0]!;
    expect(groupBindings(d.bindings)).toHaveLength(1);
    const rows = [
      row({ repository: "op-source", mountPath: "/workspaces/op",
        probe: { repository: "op-source", present: true, revision: PIN, readable: true, writable: false, marker: "sha" } }),
      row({ profile: "research", repository: "op-source", mountPath: "/workspaces/op",
        resolvedRevision: "b".repeat(40),
        probe: { repository: "op-source", present: true, revision: "b".repeat(40), readable: true, writable: false, marker: "sha" } }),
    ];
    const s = scenarioFromRows(d, group, rows);
    expect(s.name).toBe("sre-operation-source");
    expect(s.expectedVisibleProfiles).toEqual(["manager", "research"]);
    expect(s.revisionMatched).toBe(true);
    expect(s.unexpectedVisibleProfiles).toEqual([]);
    expect(s.pass).toBe(true);
  });

  test("a WRITABLE read-only mount fails readOnlyVerified", () => {
    const d = desired();
    const writable = row({
      probe: { repository: "vision-manager", present: true, revision: PIN, readable: true, writable: true, marker: "sha" },
      ok: false,
      problems: ["WRITABLE though declared read-only"],
    });
    const s = scenarioFromRows(d, groupBindings(d.bindings)[0]!, [writable]);
    expect(s.readOnlyVerified).toBe(false);
    expect(s.pass).toBe(false);
  });
});

describe("findAlertScenario", () => {
  function repoWith(scenarios: Record<string, unknown>[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hg-ws-"));
    temporary.push(root);
    for (const [i, doc] of scenarios.entries()) {
      const dir = path.join(root, "evals", "scenarios", `s${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "scenario.yaml"), yaml(doc));
    }
    return root;
  }

  test("finds the scenario whose event targets the profile", () => {
    const root = repoWith([
      { name: "other", invoke: { event: { name: "x", payload: "p.json" } }, expect: { outputs: [{ agent: { profile: "manager" } }] } },
      { name: "sre", invoke: { event: { name: "observability.alert", payload: "fixtures/a.json" } }, expect: { outputs: [{ agent: { profile: "marketing-sre" } }, { chatops: "d#c" }] } },
    ]);
    const found = findAlertScenario(root, "marketing-sre");
    expect(found).not.toBeNull();
    expect(found!.dir.endsWith("s1")).toBe(true);
    expect(found!.spec.event?.name).toBe("observability.alert");
  });

  test("no matching scenario returns null, never a guess", () => {
    const root = repoWith([
      { name: "other", invoke: { event: { name: "x", payload: "p.json" } }, expect: { outputs: [{ agent: { profile: "manager" } }] } },
    ]);
    expect(findAlertScenario(root, "marketing-sre")).toBeNull();
    expect(findAlertScenario(path.join(root, "nowhere"), "marketing-sre")).toBeNull();
  });
});

describe("workspaceList", () => {
  test("decorates shape, classification and the single-repo terminal cwd", () => {
    const d = desired({
      bindings: [
        binding({ targetProfiles: ["manager", "sre"] }),
        binding({
          repository: "social-operation",
          mountPath: "/workspaces/social-media",
          purpose: "operation-source",
          targetProfiles: ["sre"],
        }),
      ],
      selfRepositories: new Set(["social-operation"]),
      bundledProfiles: new Set(["manager"]),
    });
    // workspaceList reads no state fields beside what desired carries.
    const rows = workspaceList({} as never, d);
    expect(rows[0]!.classification).toBe("business-context");
    expect(rows[1]!.classification).toBe("sre-operation-source");
    expect(rows[0]!.profiles).toEqual([
      { profile: "manager", shape: "bundled", terminalCwd: "/workspaces/vision-manager" },
      { profile: "sre", shape: "independent", terminalCwd: null }, // two repos - no default cwd
    ]);
    expect(rows[1]!.profiles[0]).toEqual({ profile: "sre", shape: "independent", terminalCwd: null });
  });
});

describe("tracked workspaces in verify (ADR 0197)", () => {
  const SHA = "c".repeat(40);
  const NOW = Date.parse("2026-09-13T12:00:00Z") / 1000;
  const tracked = binding({
    resolvedRevision: "",
    targetProfiles: ["manager"],
    tracking: { branch: "main", refreshInterval: "30m" },
  });
  const REPO = [{ name: "vision-manager", mountPath: "/workspaces/vision-manager" }];

  function stampLine(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      name: "vision-manager",
      mode: "tracked",
      branch: "main",
      sha: SHA,
      refreshIntervalSeconds: 1800,
      fetchedAt: "2026-09-13T11:40:00Z",
      lastSuccessAt: "2026-09-13T11:50:00Z",
      lastAttemptAt: "2026-09-13T11:50:00Z",
      consecutiveFailures: 0,
      error: null,
      ...over,
    });
  }

  function probe(stamp: string | null = stampLine(), head = SHA) {
    const out = [
      "vision-manager mount=present",
      `vision-manager head=${head}`,
      "vision-manager read=ok",
      "vision-manager write=denied",
      "vision-manager marker=sha",
      ...(stamp === null ? [] : [`vision-manager stamp=${stamp}`]),
      `vision-manager now=${NOW}`,
    ].join("\n");
    return parseProbeOutput(out, REPO)[0]!;
  }

  test("the probe carries the stamp and the pod's own clock", () => {
    const p = probe();
    expect(p.stamp?.sha).toBe(SHA);
    expect(p.stamp?.branch).toBe("main");
    expect(p.stamp?.lastSuccessAt).toBe("2026-09-13T11:50:00Z");
    expect(p.observedAt).toBe(NOW);
    expect(probe("{not json").stamp).toBeNull();
    expect("stamp" in probe(null)).toBe(false);
  });

  test("a fresh tracked workspace passes - there is no compiled revision to drift from", () => {
    expect(judgeBound(tracked, probe(), null)).toEqual([]);
    expect(trackedFreshness(tracked.tracking!, probe()).stale).toBe(false);
  });

  test("a last success older than twice the interval is stale and fails; just inside it is not", () => {
    const old = probe(stampLine({ lastSuccessAt: "2026-09-13T10:59:00Z" }));
    expect(trackedFreshness(tracked.tracking!, old).stale).toBe(true);
    expect(judgeBound(tracked, old, null).join("; ")).toMatch(/stale: last successful refresh 2026-09-13T10:59:00Z is older than 2 x 30m/);
    const inside = probe(stampLine({ lastSuccessAt: "2026-09-13T11:01:00Z" }));
    expect(judgeBound(tracked, inside, null)).toEqual([]);
  });

  test("a failed refresh fails verify before it is stale - serving the last good tree is never quiet", () => {
    const failing = probe(stampLine({ consecutiveFailures: 2, error: "branch main was rewritten" }));
    expect(trackedFreshness(tracked.tracking!, failing).stale).toBe(false);
    expect(judgeBound(tracked, failing, null)).toEqual(["last refresh failed (2 in a row): branch main was rewritten"]);
  });

  test("a live tree that disagrees with its stamp, a moved branch, or no stamp at all, fails", () => {
    expect(judgeBound(tracked, probe(stampLine(), "d".repeat(40)), null).join("; ")).toMatch(/live tree at dddddddddddd but the stamp records cccccccccccc/);
    expect(judgeBound(tracked, probe(stampLine({ branch: "release" })), null).join("; ")).toMatch(/stamp tracks branch release, the binding tracks main/);
    const never = judgeBound(tracked, probe(null), null).join("; ");
    expect(never).toMatch(/never synced/);
    expect(never).toMatch(/stale: last successful refresh never/);
    expect(judgeBound(tracked, probe("{not json"), null).join("; ")).toMatch(/does not parse/);
  });

  test("a tracked row's revision match is its stamp, not the empty compiled revision", () => {
    const d = desired({ bindings: [tracked] });
    const group = groupBindings(d.bindings)[0]!;
    const p = probe();
    const good = row({ resolvedRevision: "", probe: p, tracking: trackedFreshness(tracked.tracking!, p) });
    expect(scenarioFromRows(d, group, [good]).revisionMatched).toBe(true);
    const moved = probe(stampLine(), "d".repeat(40));
    const bad = row({ resolvedRevision: "", probe: moved, tracking: trackedFreshness(tracked.tracking!, moved), ok: false, problems: ["live tree"] });
    expect(scenarioFromRows(d, group, [bad]).revisionMatched).toBe(false);
  });

  test("workspaceList carries the channel for a tracked repository", () => {
    const rows = workspaceList({} as never, desired({ bindings: [tracked] }));
    expect(rows[0]!.tracking).toEqual({ branch: "main", refreshInterval: "30m" });
    expect(rows[0]!.resolvedRevision).toBe("");
  });
});
