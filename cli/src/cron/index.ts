// `hg cron` — the operator's view of the NATIVE Hermes scheduler (#349).
//
// Scheduled work stays native to Hermes. The gateway owns job
// registration, schedule evaluation, fresh cron sessions, tool and skill
// attachment, execution history and result delivery; this file wraps it
// so an operator does not have to know `hermes`'s own argument shape, and
// so the platform can add the two things the fork's CLI has no concept
// of: a fleet-wide view, and temporary schedules that expire.
//
// It is DELIBERATELY a wrapper. Reimplementing scheduling here would give
// the platform a second scheduler with its own drift, and #349's
// non-goals rule exactly that out.
//
// Two vocabulary gaps between `hg` and the fork, mapped here rather than
// papered over:
//
//   enable/disable   the fork says `resume`/`pause`. `hg` uses the words
//                    the cron declaration uses (`enabled: false`), so an
//                    operator reading a distribution's cron/ directory
//                    and an operator typing a command use one vocabulary.
//
//   history          the fork has no `history` verb. Job records carry
//                    `last_run_at`, `enabled`, `paused_at`,
//                    `paused_reason` and `enabled_toolsets`, so history
//                    is PROJECTED from `cron list --json` rather than
//                    invented - and it says so, because "last run" is a
//                    weaker fact than "every run".

import { CliError, log, ok, type ProfileCtx } from "../lib.ts";
import { execInAgent } from "../harness/hermes/index.ts";

/** How long a cron control call may take. Generous: `cron run` schedules
 * onto the next tick rather than blocking on the run itself, but a busy
 * agent's CLI can be slow to answer. */
const CRON_TIMEOUT_SEC = 120;

export interface CronJob {
  name: string;
  schedule?: string;
  enabled: boolean;
  state?: string;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
  pausedReason?: string | null;
  toolsets?: string[];
}

/** Parse `hermes cron list --json` into the shape `hg` reports.
 *
 * Pure, so the vocabulary mapping is a unit test rather than something
 * only a live agent can exercise. The fork's field names are snake_case
 * and its enabled/paused pair is two facts about one thing; both are
 * normalised here so nothing downstream has to know either.
 */
export function parseCronList(stdout: string): CronJob[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new CliError(
      "hg cron: could not parse `hermes cron list --json` output as JSON.\n" +
        "  This usually means the agent's hermes is older than the cron JSON surface, or the\n" +
        "  command printed a warning before its output. Run it directly to see:\n" +
        "    hg agent exec -- cron list --json",
    );
  }
  const jobs = Array.isArray(raw) ? raw : (raw as { jobs?: unknown[] })?.jobs;
  if (!Array.isArray(jobs)) {
    throw new CliError("hg cron: `hermes cron list --json` did not return a list of jobs");
  }
  return jobs.map((j) => {
    const o = j as Record<string, unknown>;
    const name = String(o["name"] ?? "");
    if (!name) throw new CliError("hg cron: a job in the list has no name");
    // `enabled` and `state: "paused"` are two ways to say the same thing
    // and the fork sets both. Treat either as disabled: trusting only one
    // would report a paused job as schedulable.
    const enabled = o["enabled"] !== false && o["state"] !== "paused";
    return {
      name,
      ...(o["schedule"] !== undefined ? { schedule: String(o["schedule"]) } : {}),
      enabled,
      ...(o["state"] !== undefined ? { state: String(o["state"]) } : {}),
      lastRunAt: (o["last_run_at"] as string | null | undefined) ?? null,
      nextRunAt: (o["next_run_at"] as string | null | undefined) ?? null,
      pausedReason: (o["paused_reason"] as string | null | undefined) ?? null,
      ...(Array.isArray(o["enabled_toolsets"])
        ? { toolsets: (o["enabled_toolsets"] as unknown[]).map(String) }
        : {}),
    };
  });
}

/** Seconds for a `--temporary` duration like `30m`, `2h`, `90s`.
 *
 * Bounded at 24h deliberately. A "temporary" schedule that outlives the
 * session that set it is just an undeclared schedule, and #349 requires
 * temporary enablement to leave no persistent desired-state drift.
 */
export function parseTemporary(spec: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(spec.trim());
  if (!m) {
    throw new CliError(
      `hg cron: invalid --temporary ${JSON.stringify(spec)} - expected a duration like 30m, 2h or 90s`,
    );
  }
  const n = Number(m[1]);
  const seconds = n * (m[2] === "s" ? 1 : m[2] === "m" ? 60 : 3600);
  if (seconds <= 0) throw new CliError("hg cron: --temporary must be greater than zero");
  if (seconds > 24 * 3600) {
    throw new CliError(
      `hg cron: --temporary ${spec} exceeds the 24h maximum.\n` +
        "  A temporary enablement that outlives the session which set it is an undeclared\n" +
        "  schedule. For anything longer, change `enabled` in the distribution's cron/\n" +
        "  declaration and let it deploy - production schedules stay Git-backed (#349).",
    );
  }
  return seconds;
}

/** Reduce a job list to the one named, failing with the available names.
 *
 * An unknown job id has to be ACTIONABLE (#349's negative tests): the
 * common cause is a typo or a job that never deployed, and both are
 * answered by showing what does exist.
 */
export function requireJob(jobs: CronJob[], name: string): CronJob {
  const found = jobs.find((j) => j.name === name);
  if (found) return found;
  const known = jobs.map((j) => j.name).sort();
  throw new CliError(
    `hg cron: no job named ${JSON.stringify(name)} on this profile.\n` +
      (known.length > 0
        ? `  Jobs here: ${known.join(", ")}`
        : "  This profile has no cron jobs at all - check that its distribution ships a cron/ directory\n" +
          "  and that `hg platform apply` has run."),
  );
}

function listJobs(ctx: ProfileCtx): CronJob[] {
  const r = execInAgent(ctx, ["-p", ctx.name, "cron", "list", "--json"], CRON_TIMEOUT_SEC);
  if (!r.ok) {
    throw new CliError(
      `hg cron: \`hermes cron list\` failed on ${ctx.name} (exit ${r.exitCode}).\n` +
        `  ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`,
    );
  }
  return parseCronList(r.stdout);
}

/** The fork's verb for a vocabulary `hg` deliberately does not use. */
function forkVerb(action: "enable" | "disable"): string {
  return action === "enable" ? "resume" : "pause";
}

export function cmdCron(json: boolean, args: string[], ctx: ProfileCtx): void {
  const sub = args[0];
  const rest = args.slice(1);

  switch (sub) {
    case "list": {
      const jobs = listJobs(ctx);
      if (json) {
        console.log(JSON.stringify({ profile: ctx.name, jobs }, null, 2));
        return;
      }
      if (jobs.length === 0) {
        log(`[${ctx.name}] no cron jobs`);
        return;
      }
      for (const j of jobs) {
        const state = j.enabled ? "enabled" : `disabled${j.pausedReason ? ` (${j.pausedReason})` : ""}`;
        log(`[${ctx.name}] ${j.name}  ${j.schedule ?? "?"}  ${state}  last=${j.lastRunAt ?? "never"}`);
      }
      return;
    }

    case "show": {
      const name = rest[0];
      if (!name) throw new CliError("usage: hg cron show <job> --profile <name>");
      const job = requireJob(listJobs(ctx), name);
      if (json) {
        console.log(JSON.stringify({ profile: ctx.name, job }, null, 2));
        return;
      }
      log(`[${ctx.name}] ${job.name}`);
      log(`  schedule   ${job.schedule ?? "(none)"}`);
      log(`  state      ${job.enabled ? "enabled" : "disabled"}${job.pausedReason ? ` - ${job.pausedReason}` : ""}`);
      log(`  last run   ${job.lastRunAt ?? "never"}`);
      log(`  next run   ${job.nextRunAt ?? "(not scheduled)"}`);
      if (job.toolsets) log(`  toolsets   ${job.toolsets.join(", ")}`);
      return;
    }

    case "history": {
      // PROJECTED, and it says so. The fork keeps `last_run_at` per job
      // and no run log, so this is the honest subset - claiming a run
      // history the scheduler does not keep would be worse than a thin
      // one that names its own limit. Full history arrives with the
      // lifecycle records (#349's observer half), which is where a run
      // log actually belongs.
      const jobs = listJobs(ctx);
      if (json) {
        console.log(
          JSON.stringify(
            {
              profile: ctx.name,
              source: "cron list (last_run_at per job)",
              complete: false,
              jobs: jobs.map((j) => ({ name: j.name, lastRunAt: j.lastRunAt, nextRunAt: j.nextRunAt })),
            },
            null,
            2,
          ),
        );
        return;
      }
      log(`[${ctx.name}] last run per job - the scheduler keeps no run log:`);
      for (const j of jobs) {
        log(`  ${j.name}  last=${j.lastRunAt ?? "never"}  next=${j.nextRunAt ?? "(not scheduled)"}`);
      }
      log(`  For a full trace of a run, use: hg communication trace <trace-id>`);
      return;
    }

    case "run": {
      const name = rest[0];
      if (!name) throw new CliError("usage: hg cron run <job> --profile <name>");
      const job = requireJob(listJobs(ctx), name);
      // Through the native registry and scheduler, never a direct prompt
      // shortcut (#349): a manual run has to exercise the same path a
      // scheduled one does, or proving the path proves nothing.
      const r = execInAgent(ctx, ["-p", ctx.name, "cron", "run", job.name], CRON_TIMEOUT_SEC);
      if (!r.ok) {
        throw new CliError(
          `hg cron: \`hermes cron run ${job.name}\` failed (exit ${r.exitCode}).\n` +
            `  ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`,
        );
      }
      ok(`[${ctx.name}] ${job.name} queued for the next scheduler tick`);
      return;
    }

    case "enable":
    case "disable": {
      const name = rest[0];
      if (!name) throw new CliError(`usage: hg cron ${sub} <job> --profile <name> [--temporary 30m]`);
      const job = requireJob(listJobs(ctx), name);

      const tempIdx = rest.indexOf("--temporary");
      let seconds: number | null = null;
      if (tempIdx !== -1) {
        if (sub !== "enable") {
          throw new CliError("hg cron: --temporary applies to `enable` only");
        }
        const spec = rest[tempIdx + 1];
        if (!spec) throw new CliError("hg cron: --temporary needs a duration, e.g. 30m");
        seconds = parseTemporary(spec);
      }

      // A temporary enablement carries its deadline INTO the scheduler
      // (fork `cron resume --until`, #476): the tick re-pauses the job
      // once it passes. Before this, the deadline was announced here and
      // revoked by nothing.
      const untilArgs =
        seconds !== null ? ["--until", new Date(Date.now() + seconds * 1000).toISOString()] : [];
      const r = execInAgent(
        ctx,
        ["-p", ctx.name, "cron", forkVerb(sub), job.name, ...untilArgs],
        CRON_TIMEOUT_SEC,
      );
      if (!r.ok) {
        throw new CliError(
          `hg cron: \`hermes cron ${forkVerb(sub)} ${job.name}\` failed (exit ${r.exitCode}).\n` +
            `  ${(r.stderr || r.stdout || "").trim().slice(0, 400)}`,
        );
      }

      if (seconds === null) {
        ok(`[${ctx.name}] ${job.name} ${sub}d`);
        // Production schedules stay Git-backed (#349). A local enable is
        // drift the next deploy silently reverts, and saying so here is
        // cheaper than the operator discovering it.
        log(`  This is a LOCAL change. The distribution's cron/ declaration still says` +
          ` enabled: ${job.enabled}, and the next \`hg platform apply\` restores it.`);
        return;
      }

      ok(`[${ctx.name}] ${job.name} enabled for ${seconds}s`);
      log(`  The scheduler re-pauses it once the deadline passes (cron.disabled record emitted).`);
      log(`  The declared cron/ state still governs the next \`hg platform apply\`.`);
      return;
    }

    default:
      throw new CliError(
        `unknown cron subcommand ${JSON.stringify(sub ?? "")} ` +
          "(list|show|history|run|enable|disable)",
      );
  }
}
