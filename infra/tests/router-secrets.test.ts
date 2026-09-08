// ADR-53: the bootstrap provisions the event router's signing secrets.
//
// These tests pin a CONVENTION COUPLING rather than a behaviour of this
// component alone. The Secret key format is owned by the communication
// compiler; if it changes there and not here, the router looks healthy and
// silently fails every delivery `no-secret`. That failure is invisible in
// a `pulumi up` and invisible in a chart render, so it gets a unit test.

import { describe, expect, test } from "bun:test";
import {
  ROUTER_NS,
  ROUTER_SECRET,
  routerSecretEntries,
  routerSecretKey,
} from "../src/components/router-secrets/index.ts";

describe("router signing secrets (ADR-53)", () => {
  test("the key matches communication.ts's `${inst.namespace}-env`", () => {
    // cli/src/topology/communication.ts:448 builds the key from the
    // profile namespace, which cli/src/topology/compile.ts:219 renders as
    // `hermes-<profile>` under the single layout. Change either and this
    // test is the thing that tells you.
    expect(routerSecretKey("marketing-manager")).toBe("hermes-marketing-manager-env");
  });

  test("Eve signing keys match the runtime namespace rather than the retired Hermes namespace", () => {
    expect(routerSecretKey("marketing-sre", "eve")).toBe("ag-eve-marketing-sre-env");
    expect(routerSecretEntries({"marketing-sre":{WEBHOOK_SECRET:"fixture"}}, {}, [
      {name:"marketing-sre",runtime:"eve",source:"github.com/example/team",ref:"main",subdir:"agents/eve/marketing-sre/src",overrides:null},
    ])).toEqual({"ag-eve-marketing-sre-env":"fixture"});
  });

  test("the namespace matches the single-layout router scope", () => {
    // cli/src/topology/communication.ts:224.
    expect(ROUTER_NS).toBe("hermes-system");
    // The chart's default secretsName - control-plane/event-router/chart
    // /values.yaml - and what `hg up` creates (cli/src/platform.ts:1629).
    expect(ROUTER_SECRET).toBe("hermes-event-router-secrets");
  });

  test("only agents declaring WEBHOOK_SECRET contribute a key", () => {
    const entries = routerSecretEntries({
      "marketing-manager": { WEBHOOK_SECRET: "s1", ANTHROPIC_API_KEY: "nope" },
      "marketing-sre": { WEBHOOK_SECRET: "s2" },
      // A profile that is not a delivery target declares no webhook
      // secret; the router must not hold a key for it.
      "marketing-research": { ANTHROPIC_API_KEY: "nope" },
    });
    expect(entries).toEqual({
      "hermes-marketing-manager-env": "s1",
      "hermes-marketing-sre-env": "s2",
    });
  });

  test("KNOWN GAP: the derivation is single-layout only", () => {
    // Under a multi-region layout the compiler namespaces a profile as
    // `hermes-<profile>-<scope>` (compile.ts:219) and puts its router in
    // `hermes-system-<scope>` (communication.ts:224), so the real key is
    // `hermes-<profile>-<scope>-env`. Pulumi never compiles topology and
    // so cannot know the scopes; a multi-region fleet still depends on
    // `hg up` for its signing secrets. Asserted, not just commented, so
    // the day someone teaches this component about scopes the test fails
    // and points at the ADR instead of the gap going quiet.
    expect(routerSecretKey("marketing-manager")).not.toBe("hermes-marketing-manager-eu-west-1-env");
    expect(ROUTER_NS).not.toContain("-eu-west-1");
  });

  test("operator routerSecrets merge in; a collision with a derived key refuses (#357)", () => {
    const entries = routerSecretEntries(
      { "marketing-manager": { WEBHOOK_SECRET: "s1" } },
      { "company-info-webhook-url": "https://discord.invalid/hook", "vision-update-github": "gh" },
    );
    expect(entries).toEqual({
      "hermes-marketing-manager-env": "s1",
      "company-info-webhook-url": "https://discord.invalid/hook",
      "vision-update-github": "gh",
    });
    // A typo that silently replaced an agent's signing secret would break
    // deliveries three hops from the config edit - refuse instead.
    expect(() =>
      routerSecretEntries(
        { "marketing-manager": { WEBHOOK_SECRET: "s1" } },
        { "hermes-marketing-manager-env": "shadow" },
      ),
    ).toThrow(/collides with the derived signing-secret key/);
  });

  test("no WEBHOOK_SECRET anywhere yields no Secret at all", () => {
    // Mirrors `hg up`'s `if (secretEntries.size > 0)` - a fleet with no
    // agent-edge routes needs no Secret, and an empty one would be a
    // confusing artifact.
    expect(routerSecretEntries({ "marketing-research": { FOO: "bar" } })).toEqual({});
    expect(routerSecretEntries({})).toEqual({});
  });
});
