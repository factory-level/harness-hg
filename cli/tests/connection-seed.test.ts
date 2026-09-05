// The env overlay seeds a connection key the store has not set.
//
// The rule this file holds: `.env` is the operator's one authoring file,
// `hg connection set` is the stronger statement a file cannot overwrite,
// and neither can silently disagree with what the pod reads. It exists
// because the failure it prevents already happened - a real seven-digit
// GITHUB_APP_ID sat in .env while the pod ran a one-character placeholder
// from the connection, and every surface reported the placeholder as
// "set".

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let home: string;
let prev: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "hg-conn-seed-"));
  prev = process.env["HERMES_GITOPS_HOME"];
  process.env["HERMES_GITOPS_HOME"] = home;
});

afterEach(() => {
  if (prev === undefined) delete process.env["HERMES_GITOPS_HOME"];
  else process.env["HERMES_GITOPS_HOME"] = prev;
  fs.rmSync(home, { recursive: true, force: true });
});

/** A profile tree with an `.env` beside it, onboarded-shaped. */
function profile(dir: string, env: Record<string, string>): { name: string; dir: string; subdir: string; runtime: "eve" } {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".env"),
    Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  );
  return { name: path.basename(dir), dir, subdir: path.basename(dir), runtime: "eve" };
}

describe("boundEnvOverlay", () => {
  test("collects the overlay of every profile bound to the connection", async () => {
    const { boundEnvOverlay } = await import("../src/platform/index.ts");
    const dir = path.join(home, "echo");
    const ctx = profile(dir, { DISCORD_BOT_TOKEN: "tok", DISCORD_PUBLIC_KEY: "pub" });
    const state: any = { profileDir: home, profileName: "echo", profiles: [], dir };
    // profileCtxs() reads the state's own shape; give it the one profile.
    state.profiles = [{ name: "echo", subdir: "echo", runtime: "eve" }];
    const bindings: any[] = [{ connection: "company-discord", provider: "discord", profile: "echo" }];
    const { values, conflicts } = boundEnvOverlay(state, "company-discord", bindings);
    expect(values["DISCORD_BOT_TOKEN"]).toBe("tok");
    expect(values["DISCORD_PUBLIC_KEY"]).toBe("pub");
    expect(conflicts).toEqual([]);
    expect(ctx.name).toBe("echo");
  });

  test("an empty value in the overlay is not a value", async () => {
    const { boundEnvOverlay } = await import("../src/platform/index.ts");
    const dir = path.join(home, "echo");
    profile(dir, { DISCORD_BOT_TOKEN: "", DISCORD_PUBLIC_KEY: "pub" });
    const state: any = { profileDir: home, profileName: "echo", profiles: [{ name: "echo", subdir: "echo", runtime: "eve" }] };
    const bindings: any[] = [{ connection: "company-discord", provider: "discord", profile: "echo" }];
    const { values } = boundEnvOverlay(state, "company-discord", bindings);
    expect("DISCORD_BOT_TOKEN" in values).toBe(false);
    expect(values["DISCORD_PUBLIC_KEY"]).toBe("pub");
  });

  test("two bound profiles that disagree are REPORTED, never silently resolved", async () => {
    const { boundEnvOverlay } = await import("../src/platform/index.ts");
    profile(path.join(home, "echo"), { DISCORD_BOT_TOKEN: "one" });
    profile(path.join(home, "greeter"), { DISCORD_BOT_TOKEN: "two" });
    const state: any = {
      profileDir: home,
      profileName: "echo",
      profiles: [
        { name: "echo", subdir: "echo", runtime: "eve" },
        { name: "greeter", subdir: "greeter", runtime: "eve" },
      ],
    };
    const bindings: any[] = [
      { connection: "company-discord", provider: "discord", profile: "echo" },
      { connection: "company-discord", provider: "discord", profile: "greeter" },
    ];
    const { values, conflicts } = boundEnvOverlay(state, "company-discord", bindings);
    // A shared credential quietly taking one of two values is the failure
    // a connection exists to remove - so the last binding wins AND says so.
    expect(values["DISCORD_BOT_TOKEN"]).toBe("two");
    expect(conflicts.join("")).toContain("DISCORD_BOT_TOKEN");
  });

  test("only the connection's own bindings contribute", async () => {
    const { boundEnvOverlay } = await import("../src/platform/index.ts");
    profile(path.join(home, "echo"), { DISCORD_BOT_TOKEN: "mine" });
    profile(path.join(home, "other"), { DISCORD_BOT_TOKEN: "theirs" });
    const state: any = {
      profileDir: home,
      profileName: "echo",
      profiles: [
        { name: "echo", subdir: "echo", runtime: "eve" },
        { name: "other", subdir: "other", runtime: "eve" },
      ],
    };
    const bindings: any[] = [
      { connection: "company-discord", provider: "discord", profile: "echo" },
      { connection: "another-discord", provider: "discord", profile: "other" },
    ];
    const { values } = boundEnvOverlay(state, "company-discord", bindings);
    expect(values["DISCORD_BOT_TOKEN"]).toBe("mine");
  });
});
