// ADR 0195: a PostSync hook Job that never finishes would hold a sync open
// forever. The controller reads its bound from `controller.sync.timeout.seconds`
// in argocd-cmd-params-cm, which the chart populates from `configs.params` -
// verified against the pinned chart (10.1.4 / appVersion v3.4.5), not assumed.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

describe("the Argo CD sync timeout", () => {
  test("is set as a chart parameter, beside the only other one we set", () => {
    const source = readFileSync(join(ROOT, "infra/src/components/argocd/index.ts"), "utf8");
    const params = source.slice(source.indexOf("params: {"), source.indexOf("},", source.indexOf("params: {")));
    expect(params).toContain('"controller.sync.timeout.seconds": "600"');
    expect(params).toContain('"server.insecure": "true"');
  });

  test("leaves the smoke hook room inside the whole operation's budget", () => {
    const source = readFileSync(join(ROOT, "infra/src/components/argocd/index.ts"), "utf8");
    const seconds = Number(/"controller\.sync\.timeout\.seconds": "(\d+)"/.exec(source)?.[1]);
    const chartValues = readFileSync(join(ROOT, "harness/eve/charts/eve-agent/values.yaml"), "utf8");
    const hookDeadline = Number(/activeDeadlineSeconds:\s*(\d+)/.exec(chartValues)?.[1]);
    expect(hookDeadline).toBeGreaterThan(0);
    // Argo CD counts this bound from the START of the operation, not from the
    // hook: shutdown, scheduling, a cold `npm ci` + `eve build` and readiness all
    // come out of the same budget before the hook runs at all. So the bound must
    // leave the hook its full deadline AND a rollout window at least as long
    // again - it is a ceiling on a wedged sync, not a promise that any build fits.
    expect(seconds).toBeGreaterThanOrEqual(hookDeadline * 2);
    expect(seconds).toBeLessThanOrEqual(3600);
  });
});
