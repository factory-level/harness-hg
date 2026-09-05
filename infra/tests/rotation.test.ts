// Secret rotation fails loudly when workloads do not pick up the new
// value (#142, design 05).
//
// These RUN the script against a stub `kubectl` rather than asserting on
// its text. The defect being fixed was entirely about which exit codes
// reach the operator — a text assertion would have passed against the
// broken version too, because the broken version also *mentioned* the
// failure it was swallowing.
//
// What was there before:
//
//     kubectl ... rollout restart ... 2>/dev/null \
//       || echo "no statefulset ... (first install) - skipping" >&2
//
// An RBAC denial, an unreachable API server and a genuinely absent
// StatefulSet were indistinguishable, and all three exited 0. "The value
// is stored" does not imply "every workload consuming it has picked it
// up", and nothing detected or reported the difference.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRestartScript } from "../src/components/agent-secrets/index.ts";

/** A fake `kubectl` on PATH whose behaviour per subcommand we choose.
 *
 * `behaviour` maps the first distinctive word of the invocation to an
 * exit code, so a test can say "get statefulset fails, everything else
 * works" — which is exactly the shape of the states this script has to
 * tell apart. */
function stubKubectl(behaviour: Record<string, number | { code: number; stderr: string }>): string {
  const dir = mkdtempSync(join(tmpdir(), "rot-"));
  const cases = Object.entries(behaviour)
    .map(([pattern, spec]) => {
      const { code, stderr } = typeof spec === "number" ? { code: spec, stderr: "" } : spec;
      // The message matters as much as the exit code now: the script
      // distinguishes NotFound from every other failure by reading what
      // the server actually said.
      const emit = stderr ? `echo ${JSON.stringify(stderr)} >&2; ` : "";
      return `  *"${pattern}"*) ${emit}exit ${code} ;;`;
    })
    .join("\n");
  writeFileSync(
    join(dir, "kubectl"),
    `#!/bin/sh\ncase "$*" in\n${cases}\n  *) exit 0 ;;\nesac\n`,
    { mode: 0o755 },
  );
  chmodSync(join(dir, "kubectl"), 0o755);
  return dir;
}

/** What `kubectl get` prints when the object genuinely is not there. */
const NOT_FOUND = 'Error from server (NotFound): statefulsets.apps "hermes-manager" not found';

async function run(script: string, pathDir: string | null) {
  // /bin/sh by absolute path: the missing-kubectl case sets a PATH with
  // no real bin dirs on it, and a bare "sh" would fail to launch instead
  // of exercising the script.
  const proc = Bun.spawn(["/bin/sh", "-c", script], {
    // An EMPTY temp dir rather than a bogus path - `command -v kubectl`
    // has to search somewhere real and find nothing, not fail to search.
    env: { PATH: pathDir === null ? mkdtempSync(join(tmpdir(), "nokubectl-")) : `${pathDir}:/usr/bin:/bin` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  return { code, stderr };
}

const SCRIPT = buildRestartScript("hermes-manager");

describe("rotation reports completion, not intent (#142)", () => {
  test("a healthy roll succeeds and says the workload is running the new value", async () => {
    const { code, stderr } = await run(SCRIPT, stubKubectl({}));
    expect(code).toBe(0);
    expect(stderr).toContain("is running the rotated secret values");
  });

  test("a first install is a distinct, non-fatal state", async () => {
    // Argo CD creates the StatefulSet later; the pod starts against the
    // already-written Secret. This is the ONE case the old script was
    // right about - and the only reason it could claim it for every
    // other failure too.
    const { code, stderr } = await run(
      SCRIPT,
      stubKubectl({ "get statefulset": { code: 1, stderr: NOT_FOUND } }),
    );
    expect(code).toBe(0);
    expect(stderr).toContain("first install");
  });

  test("an unreachable cluster FAILS rather than claiming a first install", async () => {
    // The defect, precisely: with the API server unreachable, every
    // kubectl fails - and the old script reported "no statefulset yet
    // (first install) - skipping" and exited 0. A rotation appeared to
    // succeed while the old credential kept running.
    const { code, stderr } = await run(
      SCRIPT,
      stubKubectl({
        "get statefulset": { code: 1, stderr: "Unable to connect to the server: dial tcp: i/o timeout" },
      }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("cannot determine whether");
    // The success path's exact phrase. The message may (and does) SAY
    // "rather than a first install" - what must not happen is it
    // reporting one.
    expect(stderr).not.toContain("(first install)");
    // It names what is and is not true, because the operator's next
    // question is "so is the credential rotated or not?".
    expect(stderr).toContain("has the OLD value");
  });

  test("a refused restart FAILS", async () => {
    // RBAC denial on the rollout itself. `set -eu` plus no `|| true` is
    // what makes this fatal now.
    const { code } = await run(
      SCRIPT,
      stubKubectl({ "rollout restart": 1 }),
    );
    expect(code).toBe(1);
  });

  test("a rollout that never completes FAILS", async () => {
    // The subtler half of #142: the restart was ACCEPTED, so the old
    // script returned 0 - but a pod that cannot start on the new value
    // means the credential is not rotated. "We asked" is not "it
    // happened".
    const { code, stderr } = await run(
      SCRIPT,
      stubKubectl({ "rollout status": 1 }),
    );
    expect(code).toBe(1);
    expect(stderr).toContain("did not finish rolling");
    expect(stderr).toContain("NOT yet running the new value");
    // And it hands over the two commands that diagnose it.
    expect(stderr).toContain("rollout status statefulset");
    expect(stderr).toContain("describe pod");
  });

  test("a missing kubectl FAILS rather than silently skipping", async () => {
    // Previously this exited 0 with "skipping (the Secret is updated;
    // pods pick it up on their next restart)" - true, but the operator
    // was told rotation had succeeded when nothing had restarted.
    const { code, stderr } = await run(SCRIPT, null);
    expect(code).toBe(1);
    expect(stderr).toContain("kubectl not found");
    // It tells them how to finish the job by hand.
    expect(stderr).toContain("rollout restart statefulset hermes-manager");
  });

  test("the script waits with a bounded timeout", () => {
    // A rollout still going after the timeout is not "slow" - it is a pod
    // that cannot start on the new value, which is what rotation has to
    // report. An unbounded wait would hang `pulumi up` instead.
    expect(SCRIPT).toContain("rollout status");
    expect(SCRIPT).toMatch(/--timeout=\d+s/);
  });

  test("no failure path is swallowed", () => {
    // The regression guard. `|| true` and `2>/dev/null` on the restart
    // are exactly how this defect was written the first time.
    expect(SCRIPT).not.toContain("|| true");
    expect(SCRIPT).toContain("set -eu");
    const restartLine = SCRIPT.split("\n").find((l) => l.includes("rollout restart"));
    expect(restartLine).toBeDefined();
    expect(restartLine!).not.toContain("2>/dev/null");
  });
});

describe("only the server saying NotFound counts as absence (#142)", () => {
  // Codex found this reviewing wave 2: the first version proved
  // reachability with a namespace probe, and a role that can read
  // NAMESPACES but not STATEFULSETS satisfies it. That reports a first
  // install, exits 0, and leaves a running pod on the old credential -
  // #142's exact failure, re-entered through a narrower door.
  //
  // Absence is now read out of the error text, not inferred from a
  // non-zero exit.

  const stub = (stderr: string) =>
    stubKubectl({ "get statefulset": { code: 1, stderr } });

  test("a forbidden read is fatal, not a first install", async () => {
    const { code, stderr } = await run(
      SCRIPT,
      stub('Error from server (Forbidden): statefulsets.apps "hermes-manager" is forbidden: User "system:serviceaccount:default:deployer" cannot get resource "statefulsets"'),
    );
    expect(code).toBe(1);
    // The success path's exact phrase. The message may (and does) SAY
    // "rather than a first install" - what must not happen is it
    // reporting one.
    expect(stderr).not.toContain("(first install)");
    expect(stderr).toContain("permissions or connectivity");
    // The operator's next question is whether the credential rotated.
    expect(stderr).toContain("has the OLD value");
    // And it quotes the server, because "permissions or connectivity" is
    // two guesses and the error names which.
    expect(stderr).toContain("Forbidden");
  });

  test("an unauthorized read is fatal", async () => {
    const { code } = await run(SCRIPT, stub("error: You must be logged in to the server (Unauthorized)"));
    expect(code).toBe(1);
  });

  test("a refused connection is fatal", async () => {
    const { code } = await run(SCRIPT, stub("The connection to the server localhost:8080 was refused"));
    expect(code).toBe(1);
  });

  test("NotFound in either casing is absence", async () => {
    // kubectl's wording differs across verbs and versions; both forms
    // mean the same thing and neither should fail an install.
    for (const msg of [
      'Error from server (NotFound): statefulsets.apps "hermes-manager" not found',
      'statefulsets.apps "hermes-manager" not found',
    ]) {
      const { code } = await run(SCRIPT, stub(msg));
      expect({ msg, code }).toEqual({ msg, code: 0 });
    }
  });

  test("the namespace probe is gone", () => {
    // It was the proxy that made a forbidden read look like absence.
    // Keeping it would leave the same hole open behind the new check.
    expect(SCRIPT).not.toContain("get namespace");
  });
});
