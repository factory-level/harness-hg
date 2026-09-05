// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import * as path from "node:path";
import { agentApply } from "../harness/hermes/index.ts";
import { runAgentEvals, summarizeEvalReport } from "../harness/eve/index.ts";
import { driverFor, showAgent } from "../harness/index.ts";
import { proveAgentRuntime } from "./prove.ts";
import { serializeRuntimeManifest } from "../harness/manifest.ts";
import { gitopsRoot, resolveRuntimeManifest } from "../harness/resolve.ts";
import { AgentSnapshot } from "../harness/types.ts";
import { CliError, jsonOut, loadState, log, ok } from "../lib.ts";
import { envTargets, soleTarget } from "../local/shared.ts";

export function renderSnapshot(s: AgentSnapshot): void {
  log(`[${s.profile}]`);
  if (!s.ok) {
    log(`  cannot read: ${s.error}`);
    return;
  }
  // Print these FIRST: everything below understates reality when the probe
  // could not read something, and a reader who sees "(none)" without this
  // line draws exactly the wrong conclusion.
  for (const p of s.problems ?? []) log(`  ! ${p}`);
  log(`  engine:       ${s.engine ?? "?"}${s.instance ? `  (${s.instance})` : ""}`);
  if (s.runtimeRevision) log(`  revision:     ${s.runtimeRevision}`);
  if (s.engine === "eve") return renderEveSnapshot(s);
  const dist = s.distribution?.name
    ? `${s.distribution.name}${s.distribution.version ? ` v${s.distribution.version}` : ""}`
    : "(no distribution.yaml)";
  log(`  distribution: ${dist}`);
  log(`  model:        ${s.model?.provider ?? "(default)"} / ${s.model?.name ?? "(default)"}`);
  // The profile's skills/ also holds Hermes' bundled set, so a raw count
  // proves nothing about the ones this distribution actually ships.
  const declaredSkills = s.declaredSkills ?? [];
  const total = s.skills?.length ?? 0;
  log(`  skills:       ${total} present` +
    (declaredSkills.length
      ? `; this distribution ships ${declaredSkills.join(", ")}`
      : "; none from this distribution"));
  for (const missing of s.missingSkills ?? []) {
    log(`                ${missing} declared but MISSING from the pod`);
  }
  log(`  plugins:      ${s.plugins?.length ? s.plugins.join(", ") : "(none enabled)"}`);
  log(`  mcp servers:  ${s.mcpServers?.length ? s.mcpServers.join(", ") : "(none)"}`);
  log(`  env present:  ${s.envKeys?.length ? s.envKeys.join(", ") : "(none)"}`);

  // Channels the config takes a position on. Reported separately from the
  // env keys above because a token being present and an adapter being
  // wanted are different facts, and several adapters conflate them.
  const platforms = Object.entries(s.platforms ?? {}).filter(([k]) => k !== "webhook");
  log(`  channels:     ${platforms.length
    ? platforms.map(([k, on]) => `${k}=${on ? "on" : "off"}`).join(", ")
    : "(nothing declared - an adapter with a token in env will enable itself)"}`);

  const routes = s.webhookRoutes ?? [];
  const subs = s.webhookSubscriptions ?? [];
  log(`  webhooks:     ${s.webhookEnabled ? "enabled" : "disabled"}` +
    (routes.length ? `, routes: ${routes.join(", ")}` : ", no routes") +
    (subs.length ? `, dynamic: ${subs.join(", ")}` : ""));

  const jobs = s.cron ?? [];
  const declared = s.cronDeclarations ?? [];
  if (!jobs.length && !declared.length) {
    log("  cron:         (none declared)");
  } else {
    log(`  cron:`);
    for (const j of jobs) {
      const mark = j.enabled ? "ACTIVE" : "PAUSED";
      const next = j.enabled && j.nextRun ? `, next ${j.nextRun}` : "";
      const src = j.declaredBy ? ` [${j.declaredBy}]` : " [created by hand]";
      log(`    ${j.name}  ${j.schedule}  ${mark}${next}${src}`);
    }
    // The failure this whole command exists to make visible: a declaration
    // sitting on the PVC that nothing ever turned into a job.
    const activated = new Set(jobs.map((j) => j.declaredBy).filter(Boolean));
    const inert = declared.filter((f) => !activated.has(f));
    for (const f of inert) {
      log(`    ${f} declared but NOT activated - run: hermes-gitops agent apply --profile ${s.profile}`);
    }
  }
  log(`  sessions:     ${s.sessions ?? 0}`);
}

export function renderManifest(profile: string, resolved: ReturnType<typeof resolveRuntimeManifest>): void {
  log(`[${profile}]`);
  if (!resolved) {
    log("  not rendered yet - no emitted record for this profile");
    return;
  }
  const s = resolved.manifest.spec;
  log(`  engine:       ${s.engine}  (${s.instance} in ${s.namespace}${s.bundle ? `, bundle ${s.bundle}` : ""})`);
  log(`  image:        ${s.runtimeImage || "(none)"}`);
  log(`  source:       ${s.source.repository}${s.source.subdir ? `#${s.source.subdir}` : ""}`);
  log(`  revision:     ${s.source.revision}`);
  log(`  workspaces:   ${s.workspaces.length
    ? s.workspaces.map((w) => `${w.name} -> ${w.path} [${w.access}] @ ${w.revision.slice(0, 12)}`).join("\n                ")
    : "(none bound)"}`);
  log(`  secrets:      ${s.requiredSecrets.length ? s.requiredSecrets.join(", ") : "(none required)"} (names only)`);
  log(`  connections:  ${s.connections.length ? s.connections.map((c) => `${c.name} (${c.provider})`).join(", ") : "(none bound)"}`);
  log(`  apps:         ${s.apps.length ? s.apps.join(", ") : "(none)"}`);
  log(`  built from:   ${resolved.sources.join(", ")}`);
}

export function renderEveSnapshot(s: AgentSnapshot): void {
  log(`  model:        ${s.model?.name ?? "(not reported)"}`);
  log(`  channels:     ${s.channels?.length ? s.channels.join(", ") : "(none reported)"}`);
  log(`  subagents:    ${s.subagents?.length ? s.subagents.join(", ") : "(none declared)"}`);
  const schedules = s.schedules ?? [];
  log(`  schedules:    ${schedules.length
    ? schedules.map((x) => `${x.id}${x.cron ? ` (${x.cron})` : ""}`).join(", ")
    : "(none declared)"}`);
  const ws = s.workspaces ?? [];
  log(`  workspaces:   ${ws.length
    ? ws.map((w) => `${w.name} -> ${w.path} [${w.access}]`).join(", ")
    : "(none bound)"}`);
  const conns = s.connections ?? [];
  log(`  connections:  ${conns.length ? conns.map((c) => `${c.name} (${c.provider})`).join(", ") : "(none bound)"}`);
  log(`  tools:        ${s.tools?.length ? `${s.tools.length}: ${s.tools.join(", ")}` : "(not reported)"}`);
  const empty = new Set(s.emptyEnvKeys ?? []);
  log(`  env present:  ${s.envKeys?.length
    ? s.envKeys.map((k) => (empty.has(k) ? `${k} (EMPTY)` : k)).join(", ")
    : "(none)"}`);
  if (empty.size) {
    log(`                ${empty.size} key(s) reached the pod with no value - the name being there is not the credential being there`);
  }
}

export async function cmdAgent(
  args: string[],
  json: boolean,
  onlyProfile: string | undefined,
  dryRun: boolean,
  gitopsDir?: string,
  renderOutput?: string,
  deep = false,
  strict = false,
): Promise<void> {
  const state = loadState();
  const [sub, ...rest] = args;
  // `inspect` and `render` are offline by contract (ADR-153): they read the
  // emitted overlay, so they must work in CI where no platform ever ran.
  if (sub !== "inspect" && sub !== "render" && !state.ports) {
    throw new CliError("platform not up yet - run: hermes-gitops up");
  }

  switch (sub ?? "show") {
    case "show": {
      const snapshots = [];
      for (const ctx of envTargets(state, onlyProfile, "show")) snapshots.push(await showAgent(ctx));
      if (json) {
        jsonOut({ command: "agent-show", profiles: snapshots });
      } else {
        for (const s of snapshots) renderSnapshot(s);
      }
      const broken = snapshots.filter((s) => !s.ok);
      if (broken.length) {
        throw new CliError(`could not read ${broken.map((s) => s.profile).join(", ")}`);
      }
      break;
    }
    case "inspect": {
      const rows = envTargets(state, onlyProfile, "inspect").map((ctx) => ({
        ctx,
        resolved: resolveRuntimeManifest(state, ctx, gitopsDir),
      }));
      if (json) {
        jsonOut({
          command: "agent-inspect",
          profiles: rows.map((r) => ({
            profile: r.ctx.name,
            ...(r.resolved ? { ...r.resolved.manifest, sources: r.resolved.sources } : { rendered: false }),
          })),
        });
      } else {
        for (const { ctx, resolved } of rows) renderManifest(ctx.name, resolved);
      }
      const missing = rows.filter((r) => !r.resolved).map((r) => r.ctx.name);
      if (missing.length) {
        throw new CliError(
          `no emitted record for ${missing.join(", ")} - run: hermes-gitops up (or point --gitops at a clone that has one)`,
        );
      }
      break;
    }
    case "render": {
      const out = renderOutput;
      if (!out) throw new CliError("usage: hermes-gitops agent render --profile <name> --output <dir>");
      const ctx = soleTarget(state, onlyProfile, "render");
      const resolved = resolveRuntimeManifest(state, ctx, gitopsDir);
      if (!resolved) {
        throw new CliError(`no emitted record for ${ctx.name} - run: hermes-gitops up`);
      }
      const dir = path.resolve(out);
      fs.mkdirSync(dir, { recursive: true });
      const recordSource = path.join(gitopsRoot(gitopsDir), resolved.sources[0]!);
      const recordOut = path.join(dir, path.basename(resolved.sources[0]!));
      fs.copyFileSync(recordSource, recordOut);
      const manifestOut = path.join(dir, "runtime-manifest.json");
      fs.writeFileSync(manifestOut, serializeRuntimeManifest(resolved.manifest));
      if (json) {
        jsonOut({ command: "agent-render", profile: ctx.name, output: dir, files: [recordOut, manifestOut], sources: resolved.sources });
      } else {
        ok(`${ctx.name}: wrote ${path.relative(process.cwd(), recordOut)} and ${path.relative(process.cwd(), manifestOut)}`);
      }
      break;
    }
    case "apply": {
      const targets = envTargets(state, onlyProfile, "apply");
      // Activating declared cron is a Hermes verb: an Eve agent's schedules
      // are compiled into the project by `eve build` and fire in-process,
      // so there is nothing to converge from out here. Say that, rather
      // than exec-ing a binary the pod does not have.
      const eveTargets = targets.filter((c) => c.runtime === "eve");
      if (eveTargets.length) {
        throw new CliError(
          `agent apply is a Hermes verb; ${eveTargets.map((c) => c.name).join(", ")} run on Eve, ` +
            "whose schedules are declared in agent/schedules/ and compiled by `eve build` " +
            "(see `hg agent prove`, leg EVE015)",
        );
      }
      const results = targets.map((ctx) => agentApply(ctx, dryRun));
      if (json) {
        jsonOut({ command: "agent-apply", dryRun, profiles: results });
      } else {
        for (const r of results) {
          if (!r.ok) {
            log(`[${r.profile}] ${r.error}`);
            continue;
          }
          const rep = r.report as {
            created: { name: string }[];
            updated: { name: string }[];
            pruned: { name: string }[];
            unchanged: { name: string }[];
          };
          const summary = [
            `${rep.created.length} created`,
            `${rep.updated.length} updated`,
            `${rep.pruned.length} removed`,
            `${rep.unchanged.length} unchanged`,
          ].join(", ");
          ok(`[${r.profile}] ${dryRun ? "would be: " : ""}${summary}`);
          if (rep.created.length && !dryRun) {
            log(`  new jobs are PAUSED - enable one with: ` +
              `hermes-gitops agent exec --profile ${r.profile} -- cron resume <name>`);
          }
        }
      }
      const failed = results.filter((r) => !r.ok);
      if (failed.length) throw new CliError(`apply failed for ${failed.map((r) => r.profile).join(", ")}`);
      break;
    }
    case "exec": {
      // `--` is required, not optional: without it a hermes flag like
      // `--json` would be eaten by hg's own parser and the user would be
      // debugging the wrong CLI.
      if (rest.length === 0) {
        throw new CliError(
          "usage: hermes-gitops agent exec [--profile <name>] -- <hermes args...>\n" +
            "  e.g. hermes-gitops agent exec --profile research -- cron resume research-pass",
        );
      }
      const ctx = soleTarget(state, onlyProfile, "exec");
      // Echo the SUBCOMMAND only, never the operands. `config set
      // ANTHROPIC_API_KEY sk-...` and `webhook subscribe --secret ...` are
      // both ordinary uses of this verb, and echoing them would put a live
      // credential in a terminal scrollback and any CI log capturing it.
      const shown = rest.filter((a) => !a.startsWith("-")).slice(0, 2).join(" ");
      const argv = ctx.runtime === "eve" ? rest : ["-p", ctx.name, ...rest];
      log(`[${ctx.name}] ${ctx.runtime === "eve" ? "eve" : `hermes -p ${ctx.name}`} ${shown}${rest.length > 2 ? " …" : ""}`);
      const r = await driverFor(ctx).exec(ctx, argv, 300);
      if (r.stdout) console.log(r.stdout);
      if (r.stderr) console.error(r.stderr);
      if (!r.ok) throw new CliError(`${ctx.runtime} exited ${r.exitCode}`);
      break;
    }
    case "prove": {
      const targets = envTargets(state, onlyProfile, "prove");
      const proof = await proveAgentRuntime(targets, { deep });
      if (json) jsonOut(proof);
      else {
        for (const f of proof.findings) {
          const mark = f.status === "pass" ? "✓" : f.status === "fail" ? "✗" : "?";
          console.log(`  ${mark} [${f.id}] ${f.component}: ${f.message}`);
        }
      }
      if (!proof.ok) throw new CliError(`agent prove: ${proof.summary.fail} finding(s) failed`);
      break;
    }
    case "evals": {
      const targets = envTargets(state, onlyProfile, "evals");
      const hermesTargets = targets.filter((c) => c.runtime !== "eve");
      if (hermesTargets.length) {
        throw new CliError(
          `agent evals is an Eve mechanism; ${hermesTargets.map((c) => c.name).join(", ")} run on the ` +
            "frozen legacy Hermes harness, which has none - its behaviour suite is `hg eval` (ADR 0177)",
        );
      }
      const ids = rest.filter((a) => !a.startsWith("--"));
      let failed = 0;
      const results: Record<string, unknown> = {};
      for (const ctx of targets) {
        log(`agent evals [${ctx.name}]: eve eval --url inside the pod${ids.length ? ` (${ids.join(", ")})` : ""}`);
        const r = runAgentEvals(ctx, { strict, ids });
        results[ctx.name] = { ok: r.ok, exitCode: r.exitCode, report: r.report };
        if (!json) {
          const { lines, counts } = summarizeEvalReport(r.report);
          if (lines.length > 0) {
            for (const l of lines) console.log(`  ${l}`);
            const c = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
            if (c) log(`  ${c}`);
          } else {
            console.log(r.raw.split("\n").map((l: string) => `  ${l}`).join("\n"));
          }
          if (r.ok) ok(`${ctx.name}: every eval passed its gates`);
          else console.error(`  ✗ ${ctx.name}: eve eval exited ${r.exitCode}`);
        }
        if (!r.ok) failed++;
      }
      if (json) jsonOut({ command: "agent-evals", ok: failed === 0, profiles: results });
      if (failed > 0) throw new CliError(`agent evals: ${failed} agent(s) failed`);
      break;
    }
    default:
      throw new CliError(`unknown agent subcommand ${JSON.stringify(sub)} (show|inspect|render|apply|exec|prove|evals)`);
  }
}
