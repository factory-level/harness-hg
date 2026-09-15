import { expect, test } from "bun:test";
import { applyBootstrapChartSource } from "../src/team/compiler.ts";

test("private platform chart opt-in leaves other owners untouched", () => {
  const record = { spec: { persona: "owner" } };
  applyBootstrapChartSource(record, undefined, "owner");
  expect(record).toEqual({ spec: { persona: "owner" } });
  applyBootstrapChartSource(record, { repository: "https://github.com/example/private-platform.git", revision: "a".repeat(40) }, "owner");
  expect(record).toMatchObject({ platformRepo: { url: "https://github.com/example/private-platform.git", revision: "a".repeat(40) } });
});
test("chart opt-in rejects mutable refs and embedded credentials", () => {
  for (const [url, revision] of [["https://github.com/example/platform", "main"], ["https://token@github.com/example/platform", "a".repeat(40)], ["http://example.org/chart", "a".repeat(40)], ["https://example.org/chart?secret=x", "a".repeat(40)]]) {
    expect(() => applyBootstrapChartSource({}, { repository: url!, revision: revision! }, "owner")).toThrow();
  }
});
