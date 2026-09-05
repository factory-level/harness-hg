// Extracted from main.ts (final-pass #657): see the subject directory contract.
import * as fs from "node:fs";
import * as path from "node:path";
import { CliError, HG_HOME, HgState, loadState, log, ok, saveState, sh } from "../lib.ts";
import { discoverProfiles } from "./shared.ts";

export function cmdOnboard(
  target: string | undefined,
  onlyProfile: string | undefined,
  envFileFlag: string | undefined,
): void {
  if (!target) {
    throw new CliError(
      "usage: hermes-gitops onboard <./path | repo-url> [--profile <name>] [--env <path/.env>]",
    );
  }
  let profileDir: string;
  let trusted: boolean;
  let sourceUrl: string | undefined;
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(target)) {
    // External repo: cloned locally; repo-shipped reset scripts will need
    // explicit consent (spec §27 trust boundary).
    const cloneName = path.basename(target).replace(/\.git$/, "");
    const dest = path.join(HG_HOME, "clones", cloneName);
    if (fs.existsSync(dest)) {
      sh(["git", "-C", dest, "pull", "--ff-only"], { allowFail: true });
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      sh(["git", "clone", target, dest]);
    }
    profileDir = dest;
    trusted = false;
    sourceUrl = target;
  } else {
    profileDir = path.resolve(target);
    trusted = true;
  }

  // The whole catalogue by default; --profile narrows to one member
  // (matched by profile name or subdir basename).
  let profiles = discoverProfiles(profileDir);
  if (onlyProfile) {
    // The agent-team layout's subdir ends in /src - match the agent dir.
    const dirName = (subdir: string) =>
      path.basename(subdir) === "src" ? path.basename(path.dirname(subdir)) : path.basename(subdir);
    profiles = profiles.filter(
      (p) => p.name === onlyProfile || dirName(p.subdir) === onlyProfile,
    );
    if (profiles.length === 0) {
      throw new CliError(
        `--profile ${JSON.stringify(onlyProfile)} matches nothing in ${profileDir} ` +
          `(known: ${discoverProfiles(profileDir).map((p) => p.name).join(", ")})`,
      );
    }
  }

  // --env pins an explicit dotenv file for every profile; without it,
  // <root>/.env (shared) and per-profile <subdir>/.env apply (see lib.ts).
  let envFile: string | undefined;
  if (envFileFlag) {
    envFile = path.resolve(envFileFlag);
    if (!fs.existsSync(envFile)) throw new CliError(`--env ${envFile} does not exist`);
  }

  // Re-onboarding switches WHICH profiles are under test, not the
  // platform: carry the host-server infrastructure over from any previous
  // state so `up` reuses the running daemons instead of leaking a fresh
  // set per onboard (switching around a catalogue is the normal loop).
  let prior: Partial<HgState> = {};
  try {
    const { ports, pids, gatewayIp, platformSha } = loadState();
    prior = { ports, pids, gatewayIp, platformSha };
  } catch {
    /* first onboard - nothing to carry over */
  }
  const profileName =
    profiles.length === 1 && !profiles[0]!.subdir
      ? profiles[0]!.name
      : path.basename(profileDir);
  const state: HgState = {
    ...prior,
    profileDir,
    profileName,
    profiles,
    trusted,
    sourceUrl,
    envFile,
  };
  saveState(state);
  ok(
    `onboarded ${profiles.length} profile(s): ${profiles.map((p) => p.name).join(", ")} ` +
      `(${trusted ? "local path, trusted" : "cloned, untrusted scripts"})`,
  );
  log(`root: ${profileDir}`);
  if (envFile) log(`env file pinned: ${envFile}`);
  else log(`env default: ${path.join(profileDir, ".env")} (shared) + per-profile .env, if present`);
  log("next: hermes-gitops up");
}
