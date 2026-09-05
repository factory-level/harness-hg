// `hg debug webhook` - the passive debug observer's host half (ADR-74).
// The storage is the existing local webhook sink (webhook-sink.py, JSONL
// at SINK_LOG); the router mirrors metadata-only lifecycle records to
// `<recordingBase>/observer` whenever its emitted values carry a
// recordingBase (topology emit --observer-url). enable/disable manage
// ONLY the host process - Git stays the authority on whether the router
// mirrors anywhere, exactly the boundary the epic draws for the observer:
// passive, never a route target, never able to fail a primary path.

import * as fs from "node:fs";
import {
  CliError,
  SINK_LOG,
  jsonOut,
  loadState,
  log,
  ok,
  pidAlive,
  sh,
} from "../lib.ts";
import { ensureSink, stopSink } from "../platform/index.ts";

/** The host address a pod can reach this machine on: the local-loop
 * gateway IP when the k3d loop set one, else the primary host address
 * (factory-style: k3s pods reach the node IP directly). */
function hostAddress(state: { gatewayIp?: string }): string {
  if (state.gatewayIp) return state.gatewayIp;
  const ip = sh(["sh", "-c", "hostname -I | awk '{print $1}'"], { allowFail: true, quiet: true }).trim();
  return ip || "127.0.0.1";
}

function records(): { raw: string; parsed: unknown }[] {
  if (!fs.existsSync(SINK_LOG)) return [];
  return fs
    .readFileSync(SINK_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((raw) => {
      try {
        return { raw, parsed: JSON.parse(raw) };
      } catch {
        return { raw, parsed: undefined };
      }
    });
}

export function cmdDebugWebhook(json: boolean, args: string[], tail: number, planes?: string): void {
  const [group, sub] = args;
  if (group !== "webhook") {
    throw new CliError("usage: hermes-gitops debug webhook enable|status|tail|clear|disable [--tail <n>] [--planes cron,tool] [--json]");
  }
  // --planes (#476): filter the tail to lifecycle records of the named
  // planes. Foreign sink lines (chatops mirrors, raw receipts) carry no
  // plane and are excluded by construction when the filter is active.
  const planeSet = planes
    ? new Set(planes.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const state = loadState();
  switch (sub ?? "status") {
    case "enable": {
      ensureSink(state);
      const url = `http://${hostAddress(state)}:${state.ports!.sink}`;
      if (json) jsonOut({ command: "debug-webhook", action: "enable", url, log: SINK_LOG });
      else {
        ok(`debug webhook sink up on ${url} (records -> ${SINK_LOG})`);
        log("  the router mirrors here once its emitted values carry this URL:");
        log(`    topology emit ... --observer-url ${url}`);
      }
      return;
    }
    case "status": {
      const alive = pidAlive(state.pids?.sink);
      const count = records().length;
      const url = alive ? `http://${hostAddress(state)}:${state.ports!.sink}` : undefined;
      if (json) jsonOut({ command: "debug-webhook", action: "status", enabled: alive, url, records: count, log: SINK_LOG });
      else {
        log(`sink: ${alive ? `up (${url})` : "down"}   records: ${count}   log: ${SINK_LOG}`);
        if (!alive) log("  enable with: hermes-gitops debug webhook enable");
      }
      return;
    }
    case "tail": {
      // The sink wraps every POST as {ts, method, path, body} - the
      // lifecycle record lives under body (Codex catch). The plane
      // filter unwraps before matching; the unfiltered tail keeps
      // showing raw sink lines unchanged.
      const all = planeSet
        ? records().filter((r) => {
            const p = r.parsed as Record<string, unknown> | undefined;
            const body =
              p && typeof p["path"] === "string" && "body" in p ? (p["body"] as Record<string, unknown>) : p;
            const plane = body?.["plane"];
            return typeof plane === "string" && planeSet.has(plane);
          })
        : records();
      const shown = all.slice(-tail);
      if (json) {
        jsonOut({ command: "debug-webhook", action: "tail", total: all.length, records: shown.map((r) => r.parsed ?? r.raw) });
        return;
      }
      if (!shown.length) log("no records");
      for (const r of shown) log(r.raw);
      return;
    }
    case "clear": {
      const had = records().length;
      fs.writeFileSync(SINK_LOG, "");
      if (json) jsonOut({ command: "debug-webhook", action: "clear", cleared: had });
      else ok(`cleared ${had} record(s)`);
      return;
    }
    case "disable": {
      stopSink(state);
      if (json) jsonOut({ command: "debug-webhook", action: "disable", enabled: false });
      return;
    }
    default:
      throw new CliError(`hg debug webhook ${sub}: unknown - enable|status|tail|clear|disable`);
  }
}
