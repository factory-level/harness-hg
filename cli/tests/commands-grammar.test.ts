// The grammar gate (ADR 0161, issue #656): the manifest is the single
// source, and these assertions are what "no loop, no merge" and "one
// meaning per verb" mean mechanically. Bidirectional on VERBS, the same
// shape as main-flags.test.ts: a new sub with an unregistered verb fails
// until a meaning is written, and a verb nothing uses fails until it is
// removed — the register can neither lag nor hoard.

import { describe, expect, test } from "bun:test";
import { COMMANDS, VERBS, type Loop } from "../src/commands.ts";

const LOOPS: Loop[] = ["ops", "dev", "agent-bundle", "harness-legacy", "all"];

describe("journeys (ADR 0159)", () => {
  test("every command declares at least one valid loop", () => {
    for (const c of COMMANDS) {
      expect(c.loops.length, `${c.name} has no loop — no loop, no merge`).toBeGreaterThan(0);
      for (const l of c.loops) expect(LOOPS).toContain(l);
    }
  });

  test("harness-legacy carries no whole command since ADR 0177 (cron/discord went engine-neutral)", () => {
    const legacy = COMMANDS.filter((c) => c.loops.includes("harness-legacy")).map((c) => c.name);
    expect(legacy).toEqual([]);
  });
});

describe("verbs (ADR 0161)", () => {
  const usedVerbs = new Set<string>();
  for (const c of COMMANDS) {
    for (const s of c.subs) {
      if (s.name === "") continue; // the bare command form carries no verb
      usedVerbs.add(s.name.split(" ").pop()!);
    }
  }

  test("every sub's verb has exactly one registered meaning", () => {
    for (const c of COMMANDS) {
      for (const s of c.subs) {
        if (s.name === "") continue;
        const verb = s.name.split(" ").pop()!;
        expect(VERBS[verb], `hg ${c.name} ${s.name}: verb "${verb}" has no registered meaning`).toBeDefined();
      }
    }
  });

  test("no registered verb is unused", () => {
    for (const verb of Object.keys(VERBS)) {
      expect(usedVerbs.has(verb), `VERBS["${verb}"] is registered but no sub uses it`).toBe(true);
    }
  });

  test("the four historically-colliding verbs read as one meaning each", () => {
    // The #656 mess, pinned: emit writes files (event sends via publish),
    // prove emits a ProofResult, doctor diagnoses, restore replays.
    expect(VERBS["emit"]).toContain("repository");
    expect(VERBS["publish"]).toContain("live");
    expect(VERBS["prove"]).toContain("ProofResult");
    expect(VERBS["doctor"]).toContain("diagnose");
    expect(VERBS["restore"]).toContain("artifact");
    // and the renames hold: no sub spells the deprecated forms.
    for (const c of COMMANDS) {
      for (const s of c.subs) {
        if (c.name === "event") expect(s.name).not.toBe("emit");
        if (c.name === "chatops") expect(s.name).not.toBe("inspect");
        expect(s.name.endsWith("prove-recovery")).toBe(false);
      }
    }
  });
});
