// Extracted from main.ts (final-pass #657): see the subject directory contract.
import { publishStatusConfigMap } from "../backup/platform.ts";
import { CliError, jsonOut, loadState, log, ok, toRfc3339 } from "../lib.ts";
import { oneShotState } from "../validate/command.ts";
import { desiredWorkspaces, runWorkspaceTier, workspaceDoctor, workspaceList, workspaceVerify } from "./index.ts";

// ---------------------------------------------------------------------------
// workspace - the operator surface for #361's repository bindings (#365).
// `plan`/`list` are the desired-state views; `verify` compares desired
// against OBSERVED (one exec per profile: mounts, revisions, read-only,
// markers, credentials, and ABSENCE for unbound profiles); `doctor`
// proves the generated records reproduce from the declaration; `test`
// runs the reference scenarios - the same engine `hg test --tier
// workspace-bindings` speaks. Data assembly lives in workspace.ts.
// ---------------------------------------------------------------------------

export async function cmdWorkspace(
  sub: string | undefined,
  json: boolean,
  opts: { profile?: string; repository?: string; scenario?: string; gitops?: string; dir?: string; deep: boolean; record: boolean },
): Promise<void> {
  const usage =
    "usage: hermes-gitops workspace plan|list|verify|doctor|test " +
    "[--profile <p>] [--repository <r>] [--scenario <s>] [--deep] [--record] [--json]";
  if (!sub || !["plan", "list", "verify", "doctor", "test"].includes(sub)) {
    throw new CliError(usage);
  }
  // --dir = the one-shot form (#673): state synthesized from the repo,
  // nothing persisted - the same seam hg validate --dir uses, so the
  // agent-bundle loop can gate a repo this machine never onboarded.
  const state = opts.dir ? oneShotState(opts.dir) : loadState();
  const requireResolution = opts.dir === undefined;
  const desired = desiredWorkspaces(state, opts.gitops, { requireResolution });
  const errors = desired.findings.filter((finding) => finding.severity === "error");
  const renderFindings = (findings: { severity: string; profile?: string; check?: string; message: string; fix?: string }[]): void => {
    for (const finding of findings) {
      const mark = finding.severity === "error" ? "  ✗" : "  !";
      const prefix = finding.profile ? `[${finding.profile}] ` : "";
      console.log(`${mark} ${prefix}${finding.check ? `${finding.check}: ` : ""}${finding.message}`);
      if (finding.fix) console.log(`      fix:  ${finding.fix}`);
    }
  };

  if (sub === "plan" || sub === "list") {
    const rows = workspaceList(state, desired);
    if (json) {
      jsonOut({
        command: `workspace-${sub}`,
        declaration: desired.declaration,
        ok: errors.length === 0,
        bindings: desired.bindings,
        repositories: rows,
        findings: desired.findings,
      });
    } else if (!desired.declaration) {
      ok(`workspace ${sub}: no environment/workspaces.yaml - no repository bindings declared`);
    } else {
      for (const row of rows.filter(
        (r) =>
          (!opts.repository || r.repository === opts.repository) &&
          (!opts.profile || r.profiles.some((p) => p.profile === opts.profile)),
      )) {
        const revisions = row.resolvedRevision.split(" | ").map((r) => r.slice(0, 12)).join(" | ");
        console.log(
          `  ${row.repository}  (${row.classification}, ${row.access}, ` +
            `${revisions}, ${row.purpose}` +
            `${row.authSecretRef ? `, secret ${row.authSecretRef}` : ""})`,
        );
        for (const p of row.profiles) {
          console.log(
            `    → ${p.profile}  [${p.shape}]  ${row.mountPath}` +
              `${p.terminalCwd ? `  cwd ${p.terminalCwd}` : ""}`,
          );
        }
      }
      renderFindings(desired.findings);
      if (errors.length === 0) ok(`workspace ${sub}: ${desired.bindings.length} binding(s)`);
    }
    if (errors.length > 0) throw new CliError(`workspace ${sub}: ${errors.length} error(s)`);
    return;
  }

  if (sub === "verify") {
    if (errors.length > 0) {
      renderFindings(desired.findings);
      throw new CliError(`workspace verify: the declaration does not compile (${errors.length} error(s))`);
    }
    const result = workspaceVerify(state, desired, { profile: opts.profile, repository: opts.repository });
    if (opts.record) {
      const published = publishStatusConfigMap("hermes-workspace-status", "workspace-verify", {
        verifiedAt: toRfc3339(),
        ok: result.ok,
        rows: result.rows,
        unreachable: result.unreachable,
      });
      log(published.ok ? "status record published (hermes-workspace-status)" : `! status record NOT published (${published.reason})`);
    }
    if (json) {
      jsonOut({ command: "workspace-verify", ok: result.ok, rows: result.rows, unreachable: result.unreachable });
    } else {
      for (const row of result.rows) {
        const mark = row.ok ? "  ✓" : "  ✗";
        const observed = row.probe
          ? row.expected === "mounted"
            ? `${row.probe.present ? "mounted" : "ABSENT"} ${row.probe.revision?.slice(0, 12) ?? "-"}` +
              `${row.probe.writable === false ? " ro" : row.probe.writable === true ? " rw" : ""}` +
              `${row.probe.marker !== "sha" ? ` marker=${row.probe.marker}` : ""}`
            : row.probe.present
              ? "VISIBLE"
              : "absent"
          : "unobservable";
        console.log(
          `${mark} ${row.profile} × ${row.repository}  expected ${row.expected}, observed ${observed}` +
            (row.problems.length ? `  (${row.problems.join("; ")})` : ""),
        );
      }
      for (const profile of result.unreachable) console.log(`  ✗ ${profile}: no running pod`);
      if (result.ok) ok(`workspace verify: ${result.rows.length} check(s) clean`);
    }
    if (!result.ok) throw new CliError("workspace verify FAILED");
    return;
  }

  if (sub === "doctor") {
    // One-shot (--dir) without --gitops: there is no emitted tree yet,
    // so the reproduce-diff has nothing truthful to compare - the gate
    // is the compiled declaration's findings, and the skip is stated.
    const preDeploy = opts.dir !== undefined && opts.gitops === undefined;
    const findings = preDeploy ? [...desired.findings] : workspaceDoctor(state, desired, opts.gitops);
    if (preDeploy) {
      console.log("  (pre-deploy: declaration compiled; the records-reproduce diff runs once a tree exists - pass --gitops <clone> or deploy)");
    }
    let deepOk = true;
    if (opts.deep && desired.bindings.length > 0 && errors.length === 0) {
      const result = workspaceVerify(state, desired, {});
      deepOk = result.ok;
      for (const row of result.rows.filter((r) => !r.ok)) {
        findings.push({
          severity: "error",
          message: `${row.profile} × ${row.repository}: ${row.problems.join("; ")}`,
        });
      }
      for (const profile of result.unreachable) {
        findings.push({ severity: "error", message: `${profile}: no running pod` });
      }
    }
    const doctorErrors = findings.filter((f) => f.severity === "error");
    if (json) {
      jsonOut({ command: "workspace-doctor", ok: doctorErrors.length === 0, deep: opts.deep, findings });
    } else {
      renderFindings(findings);
      if (doctorErrors.length === 0) {
        ok(`workspace doctor: ${desired.bindings.length} binding(s) healthy${opts.deep ? " (deep)" : ""}`);
      }
    }
    if (doctorErrors.length > 0 || !deepOk) {
      throw new CliError(`workspace doctor: ${doctorErrors.length} error(s)`);
    }
    return;
  }

  // test - the reference scenarios through the shared tier engine.
  const tier = await runWorkspaceTier(state, { scenario: opts.scenario, gitopsDir: opts.gitops });
  if (json) {
    jsonOut({ command: "workspace-test", ...tier });
  } else {
    for (const s of tier.scenarios) {
      console.log(`  ${s.pass ? "✓" : "✗"} ${s.name} (${s.repository})`);
      console.log(
        `      revisionMatched=${s.revisionMatched} readOnlyVerified=${s.readOnlyVerified} ` +
          `visible=[${s.expectedVisibleProfiles.join(", ")}] unexpected=[${s.unexpectedVisibleProfiles.join(", ")}]`,
      );
      if (s.alertTraceId !== undefined) {
        console.log(
          `      alertTraceId=${s.alertTraceId} sourceReads=${s.sourceReadToolRuns} ` +
            `runtimeDiagnostics=${s.runtimeDiagnosticToolRuns}`,
        );
      }
      for (const p of s.problems) console.log(`      ! ${p}`);
    }
    if (tier.pass) ok(`workspace test: ${tier.scenarios.length} scenario(s) pass (run ${tier.testRunId})`);
  }
  if (!tier.pass) throw new CliError("workspace test FAILED");
}
