// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, envOverlayFile, loadEnvOverlay, loadState, loadTestConfig, log, ok, parseDotenv, profileCtxs, saveEnvOverlay, saveState } from "../lib.ts";
import { envTargets, reapplyEnv } from "../local/shared.ts";

export function cmdEnvfile(args: string[], restart: boolean, onlyProfile: string | undefined): void {
  const state = loadState();
  const [sub, ...rest] = args;
  switch (sub ?? "list") {
    case "list": {
      for (const ctx of envTargets(state, onlyProfile, "list")) {
        const testCfg = loadTestConfig(ctx.dir);
        const overlay = loadEnvOverlay(state, ctx);
        const file = envOverlayFile(state, ctx);
        log(`[${ctx.name}]`);
        log(`  committed dev defaults (hermes-gitops.test.yaml): ${
          Object.keys(testCfg.secrets).join(", ") || "(none)"}`);
        log(`  overlay file: ${file}${fs.existsSync(file) ? "" : " (absent)"}${
          state.envFile ? " (pinned via \`env use\`)" : ""}`);
        log(`  overlay values: ${Object.keys(overlay).join(", ") || "(none)"}`);
      }
      break;
    }
    case "use": {
      if (!rest[0]) throw new CliError("usage: hg envfile use <path/to/.env>");
      const target = path.resolve(rest[0]);
      if (!fs.existsSync(target)) throw new CliError(`${target} does not exist`);
      state.envFile = target;
      saveState(state);
      ok(`env file pinned for every profile: ${target}`);
      reapplyEnv(state, profileCtxs(state), restart);
      break;
    }
    case "set": {
      if (rest.length === 0) throw new CliError("usage: hg envfile set KEY=value [KEY=value ...] [--profile <name>]");
      const targets = envTargets(state, onlyProfile, "set");
      for (const ctx of targets) {
        // Edit ONLY the write-target file - never bake the merged view
        // (shared + per-profile + pinned) into it.
        const file = envOverlayFile(state, ctx);
        const overlay = fs.existsSync(file)
          ? parseDotenv(fs.readFileSync(file, "utf8"))
          : {};
        for (const pair of rest) {
          const eq = pair.indexOf("=");
          if (eq <= 0) throw new CliError(`not KEY=value: ${JSON.stringify(pair)}`);
          overlay[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        saveEnvOverlay(state, ctx, overlay);
        ok(`[${ctx.name}] ${rest.length} value(s) set in ${file}`);
      }
      reapplyEnv(state, targets, restart);
      break;
    }
    case "unset": {
      if (rest.length === 0) throw new CliError("usage: hg envfile unset KEY [KEY ...] [--profile <name>]");
      const targets = envTargets(state, onlyProfile, "unset");
      for (const ctx of targets) {
        const file = envOverlayFile(state, ctx);
        const overlay = fs.existsSync(file)
          ? parseDotenv(fs.readFileSync(file, "utf8"))
          : {};
        for (const key of rest) delete overlay[key];
        saveEnvOverlay(state, ctx, overlay);
        ok(`[${ctx.name}] ${rest.length} value(s) removed from ${file}`);
      }
      reapplyEnv(state, targets, restart);
      break;
    }
    default:
      throw new CliError(`unknown envfile subcommand ${JSON.stringify(sub)} (list|use|set|unset)`);
  }
}
