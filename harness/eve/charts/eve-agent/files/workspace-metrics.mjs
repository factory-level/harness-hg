// harness/eve/charts/eve-agent/files/workspace-metrics.mjs - tracked-workspace
// freshness as Prometheus text (ADR 0197). Started by files/workspace-sync.sh in
// the workspace-sync container and scraped through the pod's prometheus.io
// annotations. Every scrape re-reads .stamps/<name>.json, so a sync loop that is
// stuck still reports a growing age, and a tracked binding with no stamp at all
// reports a last success of 0 - never an absent series that reads as healthy.
// Dependency-free: node:http and node:fs only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = process.env.EVE_WORKSPACES_DIR || "/app/workspaces";
const port = Number(process.env.HG_WORKSPACE_METRICS_PORT || 9464);

// "name source branch access tracked intervalSeconds" - the chart's line format.
function trackedBindings(lines) {
  return lines
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((fields) => fields[4] === "tracked")
    .map((fields) => ({ name: fields[0], branch: fields[2], interval: Number(fields[5]) || 0 }));
}

function readStamp(name) {
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(root, ".stamps", `${name}.json`), "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
  } catch {
    return null;
  }
}

const label = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function render(bindings, stampOf, nowSeconds) {
  const families = [
    ["hg_workspace_last_success_timestamp_seconds", "Unix time of the last refresh that confirmed the live tree is the branch tip (0 = never)."],
    ["hg_workspace_refresh_interval_seconds", "The tracked workspace's declared refresh interval."],
    ["hg_workspace_consecutive_failures", "Refresh attempts that failed since the last success."],
    ["hg_workspace_stale", "1 when there is no success within twice the refresh interval."],
    ["hg_workspace_info", "The branch a tracked workspace follows and the commit it serves."],
  ].map(([name, help]) => ({ name, help, samples: [] }));
  const [lastSuccess, interval, failures, stale, info] = families;
  for (const binding of bindings) {
    const stamp = stampOf(binding.name);
    const parsed = typeof stamp?.lastSuccessAt === "string" ? Date.parse(stamp.lastSuccessAt) / 1000 : Number.NaN;
    const last = Number.isFinite(parsed) ? Math.floor(parsed) : 0;
    const failed = Number.isFinite(stamp?.consecutiveFailures) ? stamp.consecutiveFailures : 0;
    const workspace = `workspace="${label(binding.name)}"`;
    lastSuccess.samples.push(`{${workspace}} ${last}`);
    interval.samples.push(`{${workspace}} ${binding.interval}`);
    failures.samples.push(`{${workspace}} ${failed}`);
    stale.samples.push(`{${workspace}} ${last === 0 || nowSeconds - last > 2 * binding.interval ? 1 : 0}`);
    info.samples.push(`{${workspace},branch="${label(binding.branch)}",sha="${label(stamp?.sha ?? "")}"} 1`);
  }
  const out = [];
  for (const family of families) {
    out.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} gauge`);
    for (const sample of family.samples) out.push(`${family.name}${sample}`);
  }
  return `${out.join("\n")}\n`;
}

const bindings = trackedBindings(process.env.EVE_WORKSPACE_BINDINGS || "");
http
  .createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "GET" && (url === "/metrics" || url.startsWith("/metrics?"))) {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(render(bindings, readStamp, Date.now() / 1000));
      return;
    }
    res.writeHead(404);
    res.end();
  })
  .listen(port, "0.0.0.0", () => {
    console.log(`[workspace-metrics] ${bindings.length} tracked workspace(s) on :${port}/metrics`);
  });
