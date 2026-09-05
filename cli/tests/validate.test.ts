// hg validate --dir: the one-shot contract gate (#669, the #161 shape).
// The state is synthesized from the directory - no onboard, nothing
// persisted - so the same gate that guards onboarded profiles can run
// against a repo this machine has never seen. The fixture is the
// shipped reference authoring, which must stay clean by definition.
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { CliError } from "../src/lib.ts";
import { cmdValidate } from "../src/validate/command.ts";

const EXAMPLES = path.join(import.meta.dir, "..", "..", "examples");

describe("validate --dir (one-shot)", () => {
  test("a clean reference authoring validates with no onboarded state", () => {
    // HERMES_GITOPS_HOME is not set up in tests; --dir must never read it.
    expect(() => cmdValidate(true, path.join(EXAMPLES, "eve-agent"))).not.toThrow();
  });

  test("the gate renders records: distributed-profile's deliberate valuesRequired gap fires", () => {
    // persona-echo requires alert.webhookUrl, satisfied only by the
    // operator overrides the local loop supplies - so the one-shot gate
    // must FAIL here, proving record rendering runs without state.
    expect(() => cmdValidate(true, path.join(EXAMPLES, "distributed-profile"))).toThrow(
      /contract error/,
    );
  });

  test("a directory that does not exist is an actionable error", () => {
    expect(() => cmdValidate(true, "/nonexistent/persona-repo")).toThrow(CliError);
  });
});
