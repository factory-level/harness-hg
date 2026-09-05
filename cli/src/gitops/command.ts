// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, jsonOut, ok } from "../lib.ts";
import { printFindings } from "../local/shared.ts";
import { gitopsDoctor, gitopsUpgrade } from "./index.ts";

// ---------------------------------------------------------------------------
// gitops - verify a bootstrapped GitOps repository (ADR-37). Read-only in
// this PR; `upgrade` (the legacy-repo adoption) is the named follow-up.

export function cmdGitops(json: boolean, args: string[]): void {
  const [sub, repoArg] = args;
  switch (sub ?? "doctor") {
    case "doctor": {
      if (!repoArg) throw new CliError("gitops doctor requires a repository path: hg gitops doctor <gitops-repo-dir>");
      const repo = path.resolve(repoArg);
      if (!fs.existsSync(repo)) throw new CliError(`gitops doctor: no such directory ${repo}`);
      const findings = gitopsDoctor(repo);
      const okDoctor = !findings.some((f) => f.severity === "error");
      if (json) jsonOut({ command: "gitops-doctor", ok: okDoctor, repo, findings });
      else {
        printFindings(findings);
        const warnings = findings.filter((f) => f.severity === "warning").length;
        if (okDoctor) ok(`gitops doctor: ${findings.length - warnings} error(s), ${warnings} warning(s)`);
      }
      if (!okDoctor) {
        throw new CliError(`gitops doctor: ${findings.filter((f) => f.severity === "error").length} error(s)`);
      }
      return;
    }
    case "upgrade": {
      if (!repoArg) throw new CliError("gitops upgrade requires a repository path: hg gitops upgrade <gitops-repo-dir>");
      const repo = path.resolve(repoArg);
      if (!fs.existsSync(repo)) throw new CliError(`gitops upgrade: no such directory ${repo}`);
      const result = gitopsUpgrade(repo);
      const okUpgrade = !result.findings.some((f) => f.severity === "error") && result.written.length > 0;
      if (json) jsonOut({ command: "gitops-upgrade", ok: okUpgrade, repo, ...result });
      else {
        for (const f of result.written) console.log(`  + ${f}`);
        for (const f of result.deleted) console.log(`  - ${f}`);
        printFindings(result.findings);
        if (result.preflight.length) {
          console.log("");
          for (const line of result.preflight) console.log(line);
        }
        if (okUpgrade) {
          ok(
            `gitops upgrade: ${result.written.length} written, ${result.deleted.length} deleted - ` +
              "REVIEW the working tree, run the pre-flight above, then commit and push",
          );
        }
      }
      if (!okUpgrade) {
        throw new CliError("gitops upgrade: refused (see findings) - nothing was changed");
      }
      return;
    }
    default:
      throw new CliError(`unknown gitops subcommand ${JSON.stringify(sub)} (doctor|upgrade)`);
  }
}
