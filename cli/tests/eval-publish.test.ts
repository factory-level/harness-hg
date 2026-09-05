// #280: the publisher client. The two properties worth pinning are the
// derived runId (which is what makes a retry a no-op rather than a
// duplicate) and the refusal to take a token from argv.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessHeaders, readToken, recordsFromReport, latestReport } from "../src/eval/publish.ts";
import type { EvalReport } from "../src/eval/index.ts";

function report(over: Partial<EvalReport> = {}): EvalReport {
  return {
    command: "eval",
    dir: "/repo",
    root: "/repo/evals",
    ok: true,
    suite: "behaviour",
    stamp: "2026-08-01T07-00-00-000Z",
    scenarios: [
      {
        name: "greets",
        profile: "marketing-manager",
        required: true,
        status: "pass",
        runs: [
          { run: 1, status: "pass", durationMs: 1200, artifacts: "/a" },
          { run: 2, status: "fail", durationMs: 900, artifacts: "/b" },
        ],
      },
    ],
    failed: [],
    summary: { total: 1, passed: 1, failed: 0 },
    ...over,
  } as EvalReport;
}

describe("eval publish", () => {
  test("runIds are derived from the run's own identity, so a retry dedupes", () => {
    const a = recordsFromReport(report());
    const b = recordsFromReport(report());
    expect(a.map((r) => r.runId)).toEqual(b.map((r) => r.runId));
    expect(a[0]!.runId).toBe("2026-08-01T07-00-00-000Z/greets/run-1");
    expect(a[1]!.runId).toBe("2026-08-01T07-00-00-000Z/greets/run-2");
  });

  test("every run becomes a record, carrying its own status", () => {
    const records = recordsFromReport(report());
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.status)).toEqual(["pass", "fail"]);
    expect(records[0]!.componentId).toBe("marketing-manager");
    expect(records[0]!.suite).toBe("behaviour");
  });

  test("--component overrides the profile-derived component id", () => {
    expect(recordsFromReport(report(), "other-agent")[0]!.componentId).toBe("other-agent");
  });

  test("a report that never ran cannot be published", () => {
    // Schema errors stop everything before a stamp exists; publishing that
    // would invent runIds for runs that never happened.
    expect(() => recordsFromReport(report({ suite: undefined, stamp: undefined }))).toThrow(/never ran/);
  });

  test("a token is never accepted from argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-eval-"));
    const file = join(dir, "token");
    writeFileSync(file, "  hgev_from-a-file\n");
    expect(readToken(file)).toBe("hgev_from-a-file");
    const saved = process.env["HG_EVAL_TOKEN"];
    delete process.env["HG_EVAL_TOKEN"];
    try {
      expect(() => readToken()).toThrow(/world-readable/);
      process.env["HG_EVAL_TOKEN"] = "hgev_from-env";
      expect(readToken()).toBe("hgev_from-env");
    } finally {
      if (saved === undefined) delete process.env["HG_EVAL_TOKEN"];
      else process.env["HG_EVAL_TOKEN"] = saved;
    }
  });

  test("Cloudflare Access headers ride only when BOTH env halves are set", () => {
    // The service token lets the publisher traverse an Access-guarded
    // edge (remote factory Nexus). Absent = no headers, so the local
    // loop and port-forward paths are byte-identical to before.
    const saved = {
      id: process.env["HG_CF_ACCESS_CLIENT_ID"],
      secret: process.env["HG_CF_ACCESS_CLIENT_SECRET"],
    };
    delete process.env["HG_CF_ACCESS_CLIENT_ID"];
    delete process.env["HG_CF_ACCESS_CLIENT_SECRET"];
    try {
      expect(accessHeaders()).toEqual({});
      process.env["HG_CF_ACCESS_CLIENT_ID"] = "tok.access";
      // Half a credential is a misconfiguration, not a mode - fail loudly.
      expect(() => accessHeaders()).toThrow(/HG_CF_ACCESS_CLIENT_SECRET/);
      process.env["HG_CF_ACCESS_CLIENT_SECRET"] = "s3cret";
      expect(accessHeaders()).toEqual({
        "CF-Access-Client-Id": "tok.access",
        "CF-Access-Client-Secret": "s3cret",
      });
    } finally {
      if (saved.id === undefined) delete process.env["HG_CF_ACCESS_CLIENT_ID"];
      else process.env["HG_CF_ACCESS_CLIENT_ID"] = saved.id;
      if (saved.secret === undefined) delete process.env["HG_CF_ACCESS_CLIENT_SECRET"];
      else process.env["HG_CF_ACCESS_CLIENT_SECRET"] = saved.secret;
    }
  });

  test("latestReport picks the newest run directory", () => {
    const root = mkdtempSync(join(tmpdir(), "hg-runs-"));
    for (const stamp of ["2026-01-01T00-00-00Z", "2026-08-01T00-00-00Z"]) {
      const dir = join(root, stamp);
      require("node:fs").mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "report.json"), "{}");
    }
    expect(latestReport(root)).toContain("2026-08-01T00-00-00Z");
    expect(latestReport(join(root, "nope"))).toBeUndefined();
  });
});
