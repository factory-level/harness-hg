// The ops aggregate (ADR-103): alerts are THE signal; missing telemetry
// can only WORSEN the aggregate, never launder to green. Pure - fixture
// tested.
import type { FiringAlert, HealthOverlay, NexusData } from "../../stores/data";

export type OpsLevel = "quiet" | "attention" | "unknown";

export interface OpsModel {
  level: OpsLevel;
  count: number;
  hasControlPlane: boolean;
  reason: string;
  staleSources: string[];
}

export function opsModel(data: NexusData | null, health: HealthOverlay | null, stale: boolean): OpsModel {
  const alerts = data?.alerts;
  const firing: FiringAlert[] = (alerts?.firing ?? []).filter((a) => a.severity !== "none");
  const staleSources = Object.entries(health?.sources ?? {})
    .filter(([, s]) => s.status !== "ok")
    .map(([k]) => k);
  const sourcesEmpty = health !== null && Object.keys(health.sources ?? {}).length === 0;
  const pipelineDown = alerts ? alerts.configured && alerts.reachable === false : false;

  if (firing.length > 0) {
    return {
      level: "attention",
      count: firing.length,
      hasControlPlane: firing.some((a) => a.ownership === "control-plane"),
      reason: `${firing.length} alert${firing.length === 1 ? "" : "s"} firing`,
      staleSources,
    };
  }
  if (stale || staleSources.length > 0 || sourcesEmpty || pipelineDown || !alerts?.configured) {
    return {
      level: "unknown",
      count: 0,
      hasControlPlane: false,
      reason: pipelineDown
        ? "alert pipeline unreachable"
        : sourcesEmpty
          ? "no telemetry sources answered"
          : !alerts?.configured
            ? "alerting not configured"
            : `telemetry stale: ${staleSources.join(", ") || "health poll failing"}`,
      staleSources,
    };
  }
  return { level: "quiet", count: 0, hasControlPlane: false, reason: "nothing needs attention", staleSources };
}
