// Offline unit tests for the hg backup discovery/reconcile surface
// (cli/src/backup.ts) - captured kubectl/inspector output as fixtures,
// no cluster. The cluster-touching paths (runRoutine, inspectSink) are
// thin kubectl wrappers proven by the live loop.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLATFORM_ROOT } from "../src/lib.ts";
import {
  backupNsOf,
  backupProof,
  declaresBackup,
  mountingPods,
  fmtAge,
  parseInspector,
  parseRestoreHook,
  parseRoutines,
  restoreShapeOf,
  parseWorkloadClaims,
  reconcile,
  verifyFindings,
  writersOf,
  type ArtifactReport,
  type BackupRoutine,
} from "../src/backup/routines.ts";
import {
  platformBackupRecord,
  protectedStateLedger,
  UNPROTECTED_BY_DESIGN,
} from "../src/backup/platform.ts";

/** A captured `kubectl get cronjob -l ... -o json` shape, trimmed. */
function cronjobList(items: object[]): string {
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

const PLATFORM_ROUTINE = {
  metadata: {
    name: "hermes-marketing-manager-backup",
    namespace: "hermes-marketing-manager",
    annotations: { "hermes.dev/backup-protects": "profiles/" },
    labels: { "hermes.dev/backup-routine": "true" },
  },
  spec: {
    schedule: "0 3 * * *",
    suspend: false,
    jobTemplate: {
      spec: {
        template: {
          spec: {
            volumes: [
              { name: "data", persistentVolumeClaim: { claimName: "data-hermes-marketing-manager-0" } },
              { name: "backups", persistentVolumeClaim: { claimName: "hermes-marketing-manager-backups" } },
            ],
          },
        },
      },
    },
  },
  status: { lastScheduleTime: "2026-07-28T03:00:00Z", lastSuccessfulTime: "2026-07-28T03:00:09Z" },
};

describe("parseRoutines", () => {
  test("extracts name, schedule, protects, and the sink PVC by volume-name convention", () => {
    const routines = parseRoutines(cronjobList([PLATFORM_ROUTINE]));
    expect(routines).toHaveLength(1);
    const r = routines[0]!;
    expect(r.name).toBe("hermes-marketing-manager-backup");
    expect(r.schedule).toBe("0 3 * * *");
    expect(r.suspend).toBe(false);
    expect(r.protects).toEqual(["profiles/"]);
    expect(r.sinkPvc).toBe("hermes-marketing-manager-backups");
    expect(r.lastSuccessfulTime).toBe("2026-07-28T03:00:09Z");
  });

  test("a routine without a `backups` volume reports a null sink", () => {
    const broken = structuredClone(PLATFORM_ROUTINE);
    broken.spec.jobTemplate.spec.template.spec.volumes = [
      { name: "data", persistentVolumeClaim: { claimName: "whatever" } },
    ];
    expect(parseRoutines(cronjobList([broken]))[0]!.sinkPvc).toBeNull();
  });

  test("multiple protects patterns split on commas and trim", () => {
    const multi = structuredClone(PLATFORM_ROUTINE);
    multi.metadata.annotations["hermes.dev/backup-protects"] = "postiz.dump, uploads.tar.gz";
    expect(parseRoutines(cronjobList([multi]))[0]!.protects).toEqual([
      "postiz.dump",
      "uploads.tar.gz",
    ]);
  });

  test("an empty list parses to no routines", () => {
    expect(parseRoutines(cronjobList([]))).toEqual([]);
  });
});

describe("parseInspector", () => {
  test("a full report round-trips artifact fields and protect checks", () => {
    const report = parseInspector(
      [
        "HG_ARTIFACT name=hermes-20260728-030001.tar.gz sizeKB=1204 ageSec=13500",
        "HG_COUNT 7",
        "HG_PROTECTS_OK profiles/",
        "HG_PROTECTS_MISSING board.json",
      ].join("\n"),
    );
    expect(report).toEqual({
      name: "hermes-20260728-030001.tar.gz",
      sizeKB: 1204,
      ageSeconds: 13500,
      count: 7,
      protects: [
        { pattern: "profiles/", found: true },
        { pattern: "board.json", found: false },
      ],
      // No HG_DB_SIDECARS line (an old inspector) parses as clean - the
      // protects/marker gate (BKUP006) is what fails an old archive.
      dbSidecars: [],
    });
  });

  test("sidecar lines parse into dbSidecars (#436)", () => {
    const clean = parseInspector("HG_ARTIFACT name=a.tar.gz sizeKB=1 ageSec=1\nHG_DB_SIDECARS none");
    expect(clean?.dbSidecars).toEqual([]);
    const torn = parseInspector(
      "HG_ARTIFACT name=a.tar.gz sizeKB=1 ageSec=1\nHG_DB_SIDECARS ./state.db-wal ./state.db-shm",
    );
    expect(torn?.dbSidecars).toEqual(["./state.db-wal", "./state.db-shm"]);
  });

  test("HG_NO_ARTIFACT is null - an empty sink, not a parse failure", () => {
    expect(parseInspector("HG_NO_ARTIFACT\n")).toBeNull();
  });

  test("garbage output THROWS - a broken inspector is never 'no artifact'", () => {
    expect(() => parseInspector("OCI runtime exec failed blah")).toThrow(
      /broken inspection/,
    );
  });
});

describe("reconcile", () => {
  const routine: BackupRoutine = {
    name: "kanban-backup",
    namespace: "hermes-marketing-manager",
    schedule: "30 3 * * *",
    suspend: false,
    protects: ["board.json"],
    sinkPvc: "kanban-backups",
    dataPvc: "kanban-data",
  };

  test("declared intent with no routine at all is THE error this exists for", () => {
    const findings = reconcile("marketing-manager", true, []);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe("error");
    expect(findings[0]!.message).toMatch(/intent with no mechanism/);
  });

  test("no intent and no routines is clean", () => {
    expect(reconcile("marketing-manager", false, [])).toEqual([]);
  });

  test("a suspended routine is an error - it will never take a backup", () => {
    const findings = reconcile("p", true, [{ ...routine, suspend: true }]);
    expect(findings.some((f) => f.severity === "error" && /suspended/.test(f.message))).toBe(true);
  });

  test("a broken sink convention is an error; missing protects is a warning", () => {
    const findings = reconcile("p", true, [{ ...routine, sinkPvc: null, protects: [] }]);
    expect(findings.filter((f) => f.severity === "error").map((f) => f.message).join()).toMatch(
      /no volume named "backups"/,
    );
    expect(findings.filter((f) => f.severity === "warning").map((f) => f.message).join()).toMatch(
      /verify can prove an artifact exists but not/,
    );
  });

  test("a healthy routine reconciles clean", () => {
    expect(reconcile("p", true, [routine])).toEqual([]);
  });
});

describe("verifyFindings", () => {
  const base: BackupRoutine = {
    name: "kanban-backup",
    namespace: "ns",
    schedule: "30 3 * * *",
    suspend: false,
    protects: ["board.json"],
    sinkPvc: "kanban-backups",
    dataPvc: "kanban-data",
  };
  const status = (artifact: Parameters<typeof verifyFindings>[0]["routines"][0]["artifact"]) => ({
    profile: "marketing-manager",
    declaresBackup: true,
    routines: [{ ...base, artifact }],
    findings: [],
  });

  test("an empty sink is an error - nothing has ever been backed up", () => {
    const findings = verifyFindings(status(null));
    expect(findings.some((f) => /NO artifact/.test(f.message))).toBe(true);
  });

  test("a missing protected path is an error naming the lie", () => {
    const findings = verifyFindings(
      status({
        name: "a.tar.gz",
        sizeKB: 10,
        ageSeconds: 60,
        count: 1,
        protects: [{ pattern: "board.json", found: false }],
      }),
    );
    expect(findings.some((f) => /does NOT contain "board\.json"/.test(f.message))).toBe(true);
  });

  test("an empty artifact is an error even if the protect check passes", () => {
    const findings = verifyFindings(
      status({
        name: "a.tar.gz",
        sizeKB: 0,
        ageSeconds: 60,
        count: 1,
        protects: [{ pattern: "board.json", found: true }],
      }),
    );
    expect(findings.some((f) => /is empty/.test(f.message))).toBe(true);
  });

  test("a verified artifact produces no findings", () => {
    const findings = verifyFindings(
      status({
        name: "a.tar.gz",
        sizeKB: 12,
        ageSeconds: 60,
        count: 3,
        protects: [{ pattern: "board.json", found: true }],
      }),
    );
    expect(findings).toEqual([]);
  });

  test("a live sqlite sidecar in the artifact is BKUP008 (#436)", () => {
    const findings = verifyFindings(
      status({
        name: "a.tar.gz",
        sizeKB: 12,
        ageSeconds: 60,
        count: 3,
        protects: [{ pattern: "board.json", found: true }],
        dbSidecars: ["./state.db-wal"],
      }),
    );
    expect(findings.some((f) => f.id === "BKUP008" && /copied hot/.test(f.message))).toBe(true);
  });

  test("a routine with NO protects annotation cannot verify - error, not vacuous pass", () => {
    const noProtects = {
      profile: "p",
      declaresBackup: true,
      routines: [
        {
          ...base,
          protects: [],
          artifact: { name: "a.tar.gz", sizeKB: 12, ageSeconds: 60, count: 1, protects: [] },
        },
      ],
      findings: [],
    };
    const findings = verifyFindings(noProtects);
    expect(findings.some((f) => /cannot be verified/.test(f.message))).toBe(true);
  });

  test("a declared pattern the inspector never reported is an error, not a skip", () => {
    const findings = verifyFindings(
      status({
        name: "a.tar.gz",
        sizeKB: 12,
        ageSeconds: 60,
        count: 1,
        // Inspector reported on a DIFFERENT pattern than the declared board.json.
        protects: [{ pattern: "something-else", found: true }],
      }),
    );
    expect(findings.some((f) => /never reported by the inspector/.test(f.message))).toBe(true);
  });
});

describe("declaresBackup", () => {
  test("reads the backup block from hermes-gitops.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-backup-test-"));
    writeFileSync(join(dir, "hermes-gitops.yaml"), "backup:\n  schedule: '0 3 * * *'\n");
    expect(declaresBackup(dir)).toBe(true);
  });

  test("no file or no block is false", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-backup-test-"));
    expect(declaresBackup(dir)).toBe(false);
    mkdirSync(join(dir, "x"));
    writeFileSync(join(dir, "hermes-gitops.yaml"), "apps: []\n");
    expect(declaresBackup(dir)).toBe(false);
  });
});

describe("fmtAge", () => {
  test("scales through s/m/h/d and flags unknown", () => {
    expect(fmtAge(-1)).toBe("unknown");
    expect(fmtAge(45)).toBe("45s");
    expect(fmtAge(300)).toBe("5m");
    expect(fmtAge(7200)).toBe("2h");
    expect(fmtAge(200000)).toBe("2d");
  });
});

describe("dataPvc discovery (restore target)", () => {
  test("the routine's non-backups PVC volume is the restore target", () => {
    const [r] = parseRoutines(cronjobList([PLATFORM_ROUTINE]));
    expect(r!.dataPvc).toBe("data-hermes-marketing-manager-0");
  });

  test("a routine with only a sink volume has no restore target", () => {
    const sinkOnly = structuredClone(PLATFORM_ROUTINE) as typeof PLATFORM_ROUTINE;
    sinkOnly.spec.jobTemplate.spec.template.spec.volumes =
      sinkOnly.spec.jobTemplate.spec.template.spec.volumes.filter((v) => v.name === "backups");
    expect(parseRoutines(cronjobList([sinkOnly]))[0]!.dataPvc).toBeNull();
  });
});

describe("parseWorkloadClaims / writersOf", () => {
  const workloadList = (items: object[]) => JSON.stringify({ items });
  const sts = {
    kind: "StatefulSet",
    metadata: { name: "hermes-marketing-sre" },
    spec: {
      replicas: 1,
      volumeClaimTemplates: [{ metadata: { name: "data" } }],
      template: { spec: { volumes: [] } },
    },
  };
  const deploy = {
    kind: "Deployment",
    metadata: { name: "content-kanban" },
    spec: {
      replicas: 2,
      template: {
        spec: {
          volumes: [{ persistentVolumeClaim: { claimName: "kanban-data" } }],
        },
      },
    },
  };

  test("StatefulSet volumeClaimTemplates expand to ordinal PVC names", () => {
    const w = parseWorkloadClaims(workloadList([sts]));
    expect(w).toHaveLength(1);
    expect(w[0]!.claims).toContain("data-hermes-marketing-sre-0");
  });

  test("a scaled-to-zero StatefulSet still owns its ordinal-0 PVC", () => {
    const zero = structuredClone(sts);
    zero.spec.replicas = 0;
    expect(parseWorkloadClaims(workloadList([zero]))[0]!.claims).toContain(
      "data-hermes-marketing-sre-0",
    );
  });

  test("Deployment template volumes count as claims", () => {
    const w = parseWorkloadClaims(workloadList([deploy]));
    expect(w[0]!.claims).toEqual(["kanban-data"]);
    expect(w[0]!.replicas).toBe(2);
  });

  test("writersOf finds exactly the workloads mounting the target PVC", () => {
    const all = parseWorkloadClaims(workloadList([sts, deploy]));
    expect(writersOf(all, "data-hermes-marketing-sre-0").map((w) => w.name)).toEqual([
      "hermes-marketing-sre",
    ]);
    expect(writersOf(all, "nobody-mounts-this")).toEqual([]);
  });
});

// The platform-backup record (#282): the projection that crosses from the
// operator host into the cluster. Its scrubbing is the interesting part -
// the manifest names archive paths and the operator's home directory, and
// a ConfigMap is readable by anything with get on the namespace.
describe("platformBackupRecord", () => {
  const manifest = {
    schemaVersion: "hermes.dev/platform-backup/v1alpha1" as const,
    backupId: "hg-2026-08-01T03-11-52z",
    createdAt: "2026-08-01T03:11:52.000Z",
    environment: "marketing-sre,nexus",
    components: [
      {
        name: "volume/marketing-sre/agent-backup",
        kind: "volume-archive" as const,
        profile: "marketing-sre",
        routine: "agent-backup",
        archive: "volumes/marketing-sre/agent-20260801.tar.gz",
        sha256: "9f3a1c7e2b4508d6e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8",
        sizeKB: 412,
        consistency: "fresh routine invocation, exported and checksummed",
      },
      {
        name: "host/nexus-state",
        kind: "host-archive" as const,
        archive: "host/nexus-state.tar.gz",
        sha256: "4c81de09aa62b1c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c",
        sizeKB: 88,
        detail: "/home/operator/.hermes/plugins/hermes-gitops/state",
      },
      { name: "argocd", kind: "declarative" as const, detail: "rebuilt by `hg up`" },
    ],
    verification: { state: "available" as const },
  };

  test("drops archive paths and the operator's home directory", () => {
    const body = JSON.stringify(platformBackupRecord(manifest, "2026-08-01T03:14:07Z"));
    expect(body).not.toContain("/home/operator");
    expect(body).not.toContain(".tar.gz");
    expect(body).not.toContain("volumes/");
  });

  test("abbreviates the checksum rather than mirroring the manifest", () => {
    const rec = platformBackupRecord(manifest, "2026-08-01T03:14:07Z") as {
      components: { checksum?: string }[];
    };
    expect(rec.components[0].checksum).toBe("9f3a1c7e2b45");
    expect(rec.components[0].checksum).toHaveLength(12);
  });

  test("keeps declarative prose but not host-archive detail", () => {
    const rec = platformBackupRecord(manifest, "2026-08-01T03:14:07Z") as {
      components: { name: string; detail?: string }[];
    };
    expect(rec.components[1].detail).toBeUndefined(); // host archive
    expect(rec.components[2].detail).toBe("rebuilt by `hg up`"); // declarative
  });

  test("the ephemeral ledger rides the record, bounded and scrubbed (#582)", () => {
    const withLedger = {
      ...manifest,
      unprotectedByDesign: [
        { claim: "prometheus-db-0", namespace: "hermes-monitoring", reason: "metric history: continuity not promised" },
        { claim: "x".repeat(500), namespace: "n", reason: "r".repeat(900) },
      ],
    };
    const rec = platformBackupRecord(withLedger, "2026-08-01T03:14:07Z") as {
      unprotectedByDesign?: { claim: string; namespace: string; reason: string }[];
    };
    expect(rec.unprotectedByDesign).toHaveLength(2);
    expect(rec.unprotectedByDesign![0]).toEqual({
      claim: "prometheus-db-0",
      namespace: "hermes-monitoring",
      reason: "metric history: continuity not promised",
    });
    expect(rec.unprotectedByDesign![1].claim).toHaveLength(200);
    expect(rec.unprotectedByDesign![1].reason).toHaveLength(400);
    // A record without the field carries no empty array - byte-stable.
    expect("unprotectedByDesign" in platformBackupRecord(manifest, "2026-08-01T03:14:07Z")).toBe(false);
  });

  test("carries the verification state through, at second precision", () => {
    const restored = {
      ...manifest,
      verification: {
        state: "restorable" as const,
        restoredAt: "2026-08-01T04:58:40.000Z",
        durationSeconds: 219,
      },
    };
    const rec = platformBackupRecord(restored, "2026-08-01T05:02:19Z") as {
      verification: { state: string; restoredAt?: string; durationSeconds?: number };
    };
    // The state and duration pass through untouched - they are the
    // contract. The timestamp is normalized, because the reader parses
    // second precision and a stray millisecond made a record published
    // seconds ago render as stale (found live).
    expect(rec.verification).toEqual({
      state: "restorable",
      restoredAt: "2026-08-01T04:58:40Z",
      durationSeconds: 219,
    });
  });

  test("every timestamp it emits is second-precision", () => {
    const rec = platformBackupRecord(manifest, "2026-08-01T03:14:07.512Z") as Record<string, string>;
    expect(rec.observedAt).toBe("2026-08-01T03:14:07Z");
    expect(rec.createdAt).toBe("2026-08-01T03:11:52Z");
  });

  test("counts archived components without counting declarative ones", () => {
    const rec = platformBackupRecord(manifest, "2026-08-01T03:14:07Z") as { summary: string };
    expect(rec.summary).toBe("3 component(s), 2 archived");
  });
});

// The app-owned restore hook (#282). A routine whose artifact is a
// database dump cannot be restored by the volume path - wiping the PVC
// and untarring would destroy the database that has to accept it. The
// app declares how, as an annotation on the CronJob it already owns.
describe("parseRestoreHook", () => {
  const good = JSON.stringify({
    workload: "statefulset/postiz-db",
    container: "db",
    command: ["sh", "-c", "gunzip -c /tmp/r.gz | psql -U app app"],
    stagePath: "/tmp/r.gz",
    quiesce: ["deployment/postiz"],
  });

  test("no annotation is not an error - most routines are volume archives", () => {
    expect(parseRestoreHook(undefined)).toEqual({});
    expect(parseRestoreHook("  ")).toEqual({});
  });

  test("parses a complete declaration", () => {
    const { hook, error } = parseRestoreHook(good);
    expect(error).toBeUndefined();
    expect(hook).toEqual({
      workload: "statefulset/postiz-db",
      container: "db",
      command: ["sh", "-c", "gunzip -c /tmp/r.gz | psql -U app app"],
      stagePath: "/tmp/r.gz",
      quiesce: ["deployment/postiz"],
    });
  });

  test("a malformed declaration is an ERROR, never a partial hook", () => {
    // The dangerous outcome is a half-understood restore command, so
    // every rejection returns a message and no hook at all.
    for (const raw of [
      "{not json",
      "[]",
      '"a string"',
      JSON.stringify({ command: ["x"] }), // no workload
      JSON.stringify({ workload: "pod/x", command: ["x"] }), // pods are not scalable targets
      JSON.stringify({ workload: "deployment/x" }), // no command
      JSON.stringify({ workload: "deployment/x", command: [] }),
      JSON.stringify({ workload: "deployment/x", command: ["ok", 7] }), // mixed types
      JSON.stringify({ workload: "deployment/x", command: ["x"], stagePath: "relative" }),
      JSON.stringify({ workload: "deployment/x", command: ["x"], stagePath: "/a/../../etc" }),
      JSON.stringify({ workload: "deployment/x", command: ["x"], quiesce: ["nonsense"] }),
    ]) {
      const out = parseRestoreHook(raw);
      expect(out.hook).toBeUndefined();
      expect(out.error).toBeTruthy();
    }
  });

  test("stagePath defaults rather than being required", () => {
    const { hook } = parseRestoreHook(JSON.stringify({ workload: "deployment/x", command: ["x"] }));
    expect(hook?.stagePath).toBe("/tmp/hg-restore");
    expect(hook?.quiesce).toEqual([]);
  });
});

describe("restoreShapeOf", () => {
  const base: BackupRoutine = {
    name: "r",
    namespace: "ns",
    schedule: "0 3 * * *",
    suspend: false,
    protects: [],
    sinkPvc: "backups",
    dataPvc: null,
  };

  test("a data PVC is the volume path", () => {
    expect(restoreShapeOf({ ...base, dataPvc: "data-x-0" })).toBe("volume");
  });

  test("a declared hook wins over the volume path", () => {
    // An app that declares a hook means it: untarring over its PVC would
    // be the wrong operation even though one is technically possible.
    const hook = parseRestoreHook(
      JSON.stringify({ workload: "deployment/x", command: ["x"] }),
    ).hook;
    expect(restoreShapeOf({ ...base, dataPvc: "data-x-0", restoreHook: hook })).toBe("hook");
  });

  test("neither is UNSUPPORTED - archives nothing can put back", () => {
    expect(restoreShapeOf(base)).toBe("unsupported");
  });
});

describe("verifyFindings and restorability", () => {
  const status = (routine: Partial<BackupRoutine>) => ({
    profile: "p",
    declaresBackup: true,
    findings: [],
    routines: [
      {
        name: "r",
        namespace: "ns",
        schedule: "0 3 * * *",
        suspend: false,
        protects: ["data/"],
        sinkPvc: "backups",
        dataPvc: "data-0",
        artifact: { name: "a.tar.gz", sizeKB: 10, ageSeconds: 60, count: 1, protects: [{ pattern: "data/", found: true }] },
        ...routine,
      } as BackupRoutine & { artifact: ArtifactReport },
    ],
  });

  test("a routine with no restore path fails verification even with a perfect artifact", () => {
    const findings = verifyFindings(status({ dataPvc: null }));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("cannot be restored");
    expect(findings[0]!.severity).toBe("error");
  });

  test("a declared-but-invalid hook is reported as its own failure", () => {
    const findings = verifyFindings(
      status({ dataPvc: null, restoreHookError: "hermes.dev/backup-restore-hook is not valid JSON" }),
    );
    // The invalid declaration, not the generic "unsupported" message:
    // an operator who wrote a hook needs to know it did not parse.
    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toContain("not valid JSON");
  });

  test("a restorable routine with a good artifact is clean", () => {
    expect(verifyFindings(status({}))).toEqual([]);
  });
});

// The design-16 envelope (#282). One finding per CHECK, not per message -
// the launch gate (#285) groups on the id, and a per-message envelope
// would make "how many checks failed" depend on how many routines a
// profile happens to have.
describe("backupProof", () => {
  const AT = "2026-08-01T12:00:00.000Z";
  const clean = {
    profile: "p",
    declaresBackup: true,
    findings: [],
    routines: [
      {
        name: "r",
        namespace: "ns",
        schedule: "0 3 * * *",
        suspend: false,
        protects: ["data/"],
        sinkPvc: "backups",
        dataPvc: "data-0",
        artifact: {
          name: "a.tar.gz",
          sizeKB: 10,
          ageSeconds: 60,
          count: 1,
          protects: [{ pattern: "data/", found: true }],
        },
      } as BackupRoutine & { artifact: ArtifactReport },
    ],
  };

  test("a clean fleet passes every check in the matrix", () => {
    const proof = backupProof([clean], AT, AT);
    expect(proof.ok).toBe(true);
    expect(proof.kind).toBe("ProofResult");
    expect(proof.findings.map((f) => f.id)).toEqual([
      "BKUP001", "BKUP002", "BKUP003", "BKUP004", "BKUP005", "BKUP006", "BKUP007", "BKUP008",
    ]);
    expect(proof.summary).toEqual({ pass: 8, fail: 0, unknown: 0 });
  });

  test("several failures of the same kind collapse into ONE failed check", () => {
    const twoBroken = {
      ...clean,
      routines: [
        { ...clean.routines[0]!, name: "a", dataPvc: null },
        { ...clean.routines[0]!, name: "b", dataPvc: null },
      ],
    };
    const proof = backupProof([twoBroken], AT, AT);
    const restore = proof.findings.find((f) => f.id === "BKUP007")!;
    expect(restore.status).toBe("fail");
    // One check, both routines named in its message.
    expect(proof.summary.fail).toBe(1);
    expect(restore.message).toContain("routine a");
    expect(restore.message).toContain("routine b");
  });

  test("the failing profile is named on the finding", () => {
    const broken = { ...clean, profile: "marketing-sre", routines: [{ ...clean.routines[0]!, dataPvc: null }] };
    const proof = backupProof([clean, broken], AT, AT);
    expect(proof.findings.find((f) => f.id === "BKUP007")!.component).toBe("marketing-sre");
  });

  test("warnings inform but never gate", () => {
    // A missing protects annotation on a routine with no artifact check
    // is a warning from reconcile(); the envelope must stay ok.
    const warned = {
      ...clean,
      findings: [
        { profile: "p", severity: "warning" as const, message: "no protects", id: "BKUP004" as const },
      ],
    };
    expect(backupProof([warned], AT, AT).ok).toBe(true);
  });
});

// The quiesce gate (#282). Found live: every namespace that had ever run
// a backup could no longer be restored - the poll waited out its full
// timeout on a COMPLETED backup Job pod, whose spec.volumes still names
// the PVC forever, and then refused to restore.
describe("mountingPods", () => {
  const pods = (...items: { name: string; phase: string; pvc?: string }[]) =>
    JSON.stringify({
      items: items.map((i) => ({
        metadata: { name: i.name },
        status: { phase: i.phase },
        spec: { volumes: i.pvc ? [{ persistentVolumeClaim: { claimName: i.pvc } }] : [] },
      })),
    });

  test("a running writer holds the volume", () => {
    expect(mountingPods(pods({ name: "agent-0", phase: "Running", pvc: "data-0" }), "data-0")).toEqual([
      "agent-0",
    ]);
  });

  test("a COMPLETED backup pod does not - it holds no attachment", () => {
    // This is the bug. The pod finished hours ago; its spec still names
    // the PVC, and a spec-only scan waits for it forever.
    expect(
      mountingPods(pods({ name: "agent-backup-123", phase: "Succeeded", pvc: "data-0" }), "data-0"),
    ).toEqual([]);
  });

  test("a failed pod does not either", () => {
    expect(mountingPods(pods({ name: "x", phase: "Failed", pvc: "data-0" }), "data-0")).toEqual([]);
  });

  test("a quiesced namespace with backup history reads empty", () => {
    // The exact live shape: the StatefulSet scaled to zero, one completed
    // backup pod left behind. This must be quiesced, not blocked.
    const json = pods(
      { name: "agent-backup-29759265", phase: "Succeeded", pvc: "data-0" },
      { name: "unrelated", phase: "Running", pvc: "other-pvc" },
    );
    expect(mountingPods(json, "data-0")).toEqual([]);
  });

  test("names the holders so the refusal is actionable", () => {
    const json = pods(
      { name: "agent-0", phase: "Running", pvc: "data-0" },
      { name: "sidecar-0", phase: "Running", pvc: "data-0" },
    );
    expect(mountingPods(json, "data-0")).toEqual(["agent-0", "sidecar-0"]);
  });

  test("a routine with no data PVC holds nothing", () => {
    expect(mountingPods(pods({ name: "x", phase: "Running", pvc: "data-0" }), null)).toEqual([]);
  });
});

// Bundle-aware namespace resolution (#282, ADR-28). Addressing a bundled
// profile by name resolves to a namespace that was retired with its
// StatefulSet - and the failure reads as "no backup routines found",
// which on this surface means "nothing is backed up" rather than "you
// asked the wrong namespace".
describe("backupNsOf", () => {
  const repo = () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-bundle-ns-"));
    mkdirSync(join(dir, "environment"), { recursive: true });
    writeFileSync(
      join(dir, "environment", "bundles.yaml"),
      [
        "bundles:",
        "  - name: marketing-core",
        "    placement:",
        "      namespace: hermes-marketing-core",
        "    profiles:",
        "      - name: marketing-manager",
        "      - name: marketing-research",
      ].join("\n"),
    );
    mkdirSync(join(dir, "distributions", "manager"), { recursive: true });
    return dir;
  };

  test("a bundled profile resolves to the BUNDLE's namespace when the cluster has it", () => {
    const dir = repo();
    expect(
      backupNsOf(
        { name: "marketing-manager", subdir: "distributions/manager", dir: join(dir, "distributions/manager") },
        () => true,
      ),
    ).toBe("hermes-marketing-core");
  });

  test("a declared bundle whose namespace is not deployed falls back to the profile's own (#735)", () => {
    const dir = repo();
    expect(
      backupNsOf(
        { name: "marketing-manager", subdir: "distributions/manager", dir: join(dir, "distributions/manager") },
        () => false,
      ),
    ).toBe("hermes-marketing-manager");
  });

  test("an unbundled profile in the same fleet keeps its own", () => {
    const dir = repo();
    expect(
      backupNsOf({ name: "marketing-sre", subdir: "distributions/sre", dir: join(dir, "distributions/sre") }),
    ).toBe("hermes-marketing-sre");
  });

  test("a fleet with no bundles.yaml gets the plain answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-no-bundles-"));
    expect(backupNsOf({ name: "solo", subdir: "", dir })).toBe("hermes-solo");
  });

  test("an unreadable environment never throws - it falls back", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-bad-bundles-"));
    mkdirSync(join(dir, "environment"), { recursive: true });
    writeFileSync(join(dir, "environment", "bundles.yaml"), "{{{ not yaml");
    expect(backupNsOf({ name: "solo", subdir: "", dir })).toBe("hermes-solo");
  });
});

// The protected-state ledger (#283). Every other recovery check asks
// whether what we archived survived; this asks whether anything durable
// was never archived at all - which is the question that decides if the
// server is actually disposable.
describe("protectedStateLedger", () => {
  const claims = (...names: string[]) => names.map((n) => ({ name: n, namespace: "ns" }));

  test("a volume a routine archives is protected", () => {
    const l = protectedStateLedger(claims("data-agent-0"), new Set(["ns/data-agent-0"]));
    expect(l[0]!.status).toBe("protected");
  });

  test("a volume nobody archives and nobody excused FAILS the ledger", () => {
    // The entire point. Silence here means finding out during a restore.
    const l = protectedStateLedger(claims("some-app-data"), new Set());
    expect(l[0]!.status).toBe("UNACCOUNTED");
    expect(l[0]!.reason).toContain("does not survive");
  });

  test("each exemption carries a reason a reviewer can check", () => {
    for (const u of UNPROTECTED_BY_DESIGN) {
      expect(u.reason.length).toBeGreaterThan(30);
    }
  });

  test("a backup sink is excused - archiving the archive is circular", () => {
    const l = protectedStateLedger(claims("agent-backups"), new Set());
    expect(l[0]!.status).toBe("unprotected-by-design");
  });

  test("workspaces are excused as declarative, not as unimportant", () => {
    const l = protectedStateLedger(claims("workspaces-bundle-0"), new Set());
    expect(l[0]!.status).toBe("unprotected-by-design");
    expect(l[0]!.reason).toContain("cloning at the recorded SHA");
  });

  test("the prometheus pattern is loose enough to survive a rename", () => {
    // Pinned to one spelling, it silently reclassified the live volume
    // as UNACCOUNTED the moment the release naming differed. Found that
    // way, so both spellings are asserted.
    for (const n of [
      "prometheus-monitoring-prometheus-db-prometheus-monitoring-prometheus-0",
      "prometheus-monitoring-kube-prometheus-prometheus-db-prometheus-0",
    ]) {
      expect(protectedStateLedger(claims(n), new Set())[0]!.status).toBe("unprotected-by-design");
    }
  });

  test("the redis exemption names what losing it actually costs", () => {
    const l = protectedStateLedger(claims("hermes-event-router-redis"), new Set());
    expect(l[0]!.status).toBe("unprotected-by-design");
    // An exemption that hides its cost is a silencer, not a decision.
    expect(l[0]!.reason).toContain("DEAD LETTERS");
  });

  test("entries sort by claim so the output is diffable", () => {
    const l = protectedStateLedger(claims("zeta", "alpha"), new Set());
    expect(l.map((e) => e.claim)).toEqual(["alpha", "zeta"]);
  });
});

// Quiescing against Argo CD (#283). A namespace holds the profile's own
// Application AND one per spec.apps[] entry, each with its own selfHeal.
describe("pauseAutoSync covers every Application in the namespace", () => {
  // The shape the live failure had: two Applications, same destination.
  const apps = {
    items: [
      {
        metadata: { name: "hermes-marketing-engagement" },
        spec: {
          destination: { namespace: "hermes-marketing-engagement" },
          syncPolicy: { automated: { prune: true, selfHeal: true } },
        },
      },
      {
        metadata: { name: "hermes-marketing-engagement-postiz" },
        spec: {
          destination: { namespace: "hermes-marketing-engagement" },
          syncPolicy: { automated: { prune: true, selfHeal: true } },
        },
      },
      {
        metadata: { name: "hermes-marketing-sre" },
        spec: {
          destination: { namespace: "hermes-marketing-sre" },
          syncPolicy: { automated: { selfHeal: true } },
        },
      },
    ],
  };

  test("the fixture has two Applications on one namespace - that IS the bug", () => {
    // Pausing only the first left postiz's child Application restoring
    // replicas:1 under the quiesce; the restore then timed out after
    // 300s on a pod it had just told to go away.
    const sameNs = apps.items.filter(
      (a) => a.spec.destination.namespace === "hermes-marketing-engagement",
    );
    expect(sameNs).toHaveLength(2);
    // The old `find` semantics would have taken only this one.
    expect(sameNs[0]!.metadata.name).toBe("hermes-marketing-engagement");
  });

  test("an Application in another namespace is not touched", () => {
    const sameNs = apps.items.filter(
      (a) => a.spec.destination.namespace === "hermes-marketing-engagement",
    );
    expect(sameNs.map((a) => a.metadata.name)).not.toContain("hermes-marketing-sre");
  });

  test("an Application with no automated policy has nothing to pause", () => {
    const manual = { metadata: { name: "x" }, spec: { destination: { namespace: "ns" }, syncPolicy: {} } };
    expect(manual.spec.syncPolicy).not.toHaveProperty("automated");
  });
});

describe("the Hermes backup contract (#417)", () => {
  // The routines are two files that must state the SAME contract; the
  // annotation is what `hg backup verify` turns into per-pattern
  // BKUP006 errors, so widening it here is what makes the check real.
  const routine = (rel: string) =>
    readFileSync(join(PLATFORM_ROOT, rel), "utf8");
  const ROUTINES = [
    "harness/hermes/charts/hermes-profile/templates/pod/backup.yaml",
    "harness/hermes/charts/hermes-bundle/templates/backup.yaml",
  ];
  const protectsOf = (text: string) =>
    (text.match(/hermes\.dev\/backup-protects:\s*"([^"]+)"/) ?? [])[1]?.split(",") ?? [];

  test("both routines declare the same required set", () => {
    const [a, b] = ROUTINES.map((r) => protectsOf(routine(r)));
    expect(a).toEqual(b!);
    // `profiles/` alone proved only that the archive was not empty.
    expect(a!.length).toBeGreaterThan(1);
  });

  test("the required set names the state a restore actually needs", () => {
    const declared = new Set(protectsOf(routine(ROUTINES[0]!)));
    for (const required of [
      "profiles/",
      "state.db", // the core store: sessions, tasks, memory banks, usage
      "config.yaml",
      "memories/",
      "skills/",
      "plugins/",
      "sessions/",
      "cron/",
    ]) {
      expect({ required, declared: declared.has(required) }).toEqual({ required, declared: true });
    }
  });

  test("regenerable and host-namespaced state is excluded from the archive", () => {
    for (const rel of ROUTINES) {
      const text = routine(rel);
      for (const excluded of [
        "./backups", // nests archives exponentially
        "./checkpoints",
        "./cache",
        "*/node_modules",
        "*/.venv",
        "*/__pycache__",
        // Restoring these leaves the gateway stuck "starting" and
        // disconnected - upstream's _IMPORT_SKIP_NAMES exists for it.
        "*gateway_state.json",
        "*gateway.pid",
        "*cron.pid",
        "*gateway.lock",
        "*processes.json",
      ]) {
        expect({ rel, excluded, present: text.includes(`--exclude=${excluded}`) || text.includes(`--exclude='${excluded}'`) })
          .toEqual({ rel, excluded, present: true });
      }
    }
  });

  test("what must NOT be excluded, is not", () => {
    // skills/.archive holds restorable user skills; logs are history
    // Hermes keeps in its own backups. Both are easy to sweep up by
    // accident when adding exclusions.
    for (const rel of ROUTINES) {
      // Only the --exclude flags themselves: the surrounding comment
      // names .archive precisely to say it must stay IN.
      const flags = routine(rel).match(/--exclude=\S+/g) ?? [];
      for (const keep of [".archive", "logs", "skills", "memories", "state.db"]) {
        const swept = flags.filter((f) => f.includes(keep));
        expect({ rel, keep, swept }).toEqual({ rel, keep, swept: [] });
      }
    }
  });
});

describe("the Eve backup contract (ADR-150)", () => {
  // The eve-agent routine states ITS contract in the same convention:
  // label, `backups` sink, protects annotation - so every `hg backup`
  // command and BKUP001-008 apply unchanged. What differs is the state:
  // the Workflow world (state/, relocated out of the checkout by boot.sh),
  // the checkout itself and the build stamp; and what is rebuildable from
  // spec.sha (node_modules, .output, caches, eve's build trees) stays out.
  const text = readFileSync(join(PLATFORM_ROOT, "harness/eve/charts/eve-agent/templates/backup.yaml"), "utf8");
  const protects = (text.match(/hermes\.dev\/backup-protects:\s*"([^"]+)"/) ?? [])[1]?.split(",") ?? [];

  test("speaks the routine convention hg discovers by", () => {
    expect(text).toContain('hermes.dev/backup-routine: "true"');
    expect(text).toContain("name: backups");
    expect(text).toContain("claimName: data-{{");
    expect(text).not.toContain("claimName: workspaces-");
  });

  test("protects the world store, the checkout and the stamp", () => {
    for (const required of ["state/", "src/", ".hermes-gitops/installed_sha"]) {
      expect({ required, declared: protects.includes(required) }).toEqual({ required, declared: true });
    }
  });

  test("excludes only what spec.sha rebuilds", () => {
    const flags = text.match(/--exclude=\S+/g) ?? [];
    for (const excluded of ["*/node_modules", "*/.output", "./.npm", "*/.eve/builds", "*/.eve/logs", "*/.eve/traces"]) {
      expect({ excluded, present: flags.includes(`--exclude=${excluded}`) || flags.includes(`--exclude='${excluded}'`) })
        .toEqual({ excluded, present: true });
    }
    for (const keep of ["state", "workflow-data", "sandbox-cache", "installed_sha", "src"]) {
      const swept = flags.filter((f) => f.includes(keep));
      expect({ keep, swept }).toEqual({ keep, swept: [] });
    }
  });

  test("parseRoutines reads an Eve routine exactly like a Hermes one", () => {
    const cron = JSON.parse(JSON.stringify(PLATFORM_ROUTINE));
    cron.metadata.name = "ag-eve-echo-backup";
    cron.metadata.namespace = "ag-eve-echo";
    cron.metadata.annotations["hermes.dev/backup-protects"] = "state/,src/,.hermes-gitops/installed_sha";
    cron.spec.jobTemplate.spec.template.spec.volumes[0].persistentVolumeClaim.claimName = "data-ag-eve-echo-0";
    cron.spec.jobTemplate.spec.template.spec.volumes[1].persistentVolumeClaim.claimName = "ag-eve-echo-backups";
    const [r] = parseRoutines(cronjobList([cron]));
    expect(r!.protects).toEqual(["state/", "src/", ".hermes-gitops/installed_sha"]);
    expect(r!.sinkPvc).toBe("ag-eve-echo-backups");
    expect(r!.dataPvc).toBe("data-ag-eve-echo-0");
  });
});

describe("consistencyOf (#436)", () => {
  test("marker in the listing claims the snapshot; absence stays honest", async () => {
    const { consistencyOf } = await import("../src/backup/platform.ts");
    expect(consistencyOf("./profiles/\n./state.db\n./.hermes-db-snapshot.json\n")).toContain(
      "sqlite3.backup + integrity_check",
    );
    expect(consistencyOf("./profiles/\n./state.db\n")).toBe(
      "filesystem tar only - no sqlite snapshot marker",
    );
    // A name that merely CONTAINS the marker as a prefix does not count.
    expect(consistencyOf("./.hermes-db-snapshot.json.bak\n")).toContain("filesystem tar only");
  });
});

describe("platform restore dispatches by restore shape", () => {
  // The weekly verify died on the hook-shaped DLQ routine every Sunday
  // because restorePlatformBackup called restoreArtifact unconditionally
  // - the platform path must mirror `hg backup restore`'s dispatch.
  const src = readFileSync(new URL("../src/backup/platform.ts", import.meta.url), "utf8");
  test("hook-shaped routines restore through restoreViaHook", () => {
    expect(src).toContain("if (routine.restoreHook) {");
    expect(src).toContain("restoreViaHook(ctx, routine, file)");
    expect(src).toContain("restoreHookError");
  });
});
