// Offline unit tests for the hermes-install component's pure surface
// (issues #2 [D1] / #3 [D2]).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ENTRYPOINT_CHECK_PY,
  SUBSCRIPTION_CHECK_PY,
  probeHermesInstallHealth,
  resolveShimInterpreter,
} from "../src/components/harness/hermes-install/index.ts";

describe("resolveShimInterpreter", () => {
  test("plain shebang shim", () => {
    expect(resolveShimInterpreter("#!/opt/tools/hermes/bin/python\nrest\n")).toBe(
      "/opt/tools/hermes/bin/python",
    );
  });

  test("sh polyglot shim (path too long for a shebang)", () => {
    const shim = `#!/bin/sh\n'''exec' '/very/long/path/bin/python' "$0" "$@"\n' '''\n`;
    expect(resolveShimInterpreter(shim)).toBe("/very/long/path/bin/python");
  });

  test("unrecognized shape returns null", () => {
    expect(resolveShimInterpreter("echo not-a-shim\n")).toBeNull();
  });
});

describe("probeHermesInstallHealth", () => {
  test("no shim anywhere -> unhealthy naming the reason", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "d2-probe-"));
    const savedBin = process.env["UV_TOOL_BIN_DIR"];
    const savedPath = process.env["PATH"];
    try {
      process.env["UV_TOOL_BIN_DIR"] = empty;
      process.env["PATH"] = empty;
      const health = probeHermesInstallHealth();
      expect(health.healthy).toBe(false);
      expect(health.reason).toContain("no hermes shim");
    } finally {
      if (savedBin === undefined) delete process.env["UV_TOOL_BIN_DIR"];
      else process.env["UV_TOOL_BIN_DIR"] = savedBin;
      process.env["PATH"] = savedPath;
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test("shim pointing at a deleted interpreter -> unhealthy (venv deleted)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "d2-probe-"));
    const savedBin = process.env["UV_TOOL_BIN_DIR"];
    try {
      const shim = path.join(dir, "hermes");
      fs.writeFileSync(shim, "#!/nonexistent/venv/bin/python\n", { mode: 0o755 });
      process.env["UV_TOOL_BIN_DIR"] = dir;
      const health = probeHermesInstallHealth();
      expect(health.healthy).toBe(false);
      expect(health.reason).toContain("missing/not executable");
    } finally {
      if (savedBin === undefined) delete process.env["UV_TOOL_BIN_DIR"];
      else process.env["UV_TOOL_BIN_DIR"] = savedBin;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verify snippets (D1)", () => {
  test("structural check names both failure modes distinctly", () => {
    expect(ENTRYPOINT_CHECK_PY).toContain("plugin not discoverable");
    expect(ENTRYPOINT_CHECK_PY).toContain("host Hermes cannot fire profile hooks");
    for (const hook of ["profile_install", "profile_update", "profile_install_failed"]) {
      expect(ENTRYPOINT_CHECK_PY).toContain(hook);
    }
  });

  test("subscription check discovers then asserts has_hook per hook", () => {
    expect(SUBSCRIPTION_CHECK_PY).toContain("discover_plugins(force=True)");
    expect(SUBSCRIPTION_CHECK_PY).toContain("has_hook");
  });

  // A Hermes without `cron sync` fails silently: pods come up healthy and the
  // distribution's declared jobs are simply never scheduled. The probe has to
  // name the fix (move BOTH pins), because moving only hermes.ref leaves the
  // agent image behind and the symptom is identical.
  test("structural check also proves cron activation, naming both pins", () => {
    expect(ENTRYPOINT_CHECK_PY).toContain("hermes_cli.cron_sync");
    expect(ENTRYPOINT_CHECK_PY).toContain("cannot activate declared cron jobs");
    expect(ENTRYPOINT_CHECK_PY).toContain("agent image tag");
  });
});
