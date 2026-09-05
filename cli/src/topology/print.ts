// The topology printer (the human companion to `plan --json`): the
// compiled plan as a readable tree - regions -> targets -> agent
// instances (with their paired apps and endpoints) -> free-standing app
// instances - then capability bindings, cross-region edges marked. Pure:
// plan + environment in, lines out.

import type { Environment } from "./environment.ts";
import type { TopologyPlan } from "./compile.ts";

export function renderTopology(plan: TopologyPlan, env: Environment): string[] {
  const lines: string[] = [];
  const errors = plan.findings.filter((f) => f.severity === "error").length;
  lines.push(
    `layout ${plan.layout} (${plan.sovereignty})  ` +
      `${plan.agents.length} agent instance(s), ${plan.apps.length} app instance(s), ` +
      `${plan.bindings.length} binding(s)${errors ? `, ${errors} ERROR(S)` : ""}`,
  );

  const endpointsOf = (ownerId: string) => plan.endpoints.filter((e) => e.owner === ownerId);
  const pushEndpoints = (ownerId: string, indent: string) => {
    for (const e of endpointsOf(ownerId)) {
      const provides = e.provides ? `  provides ${e.provides}` : "";
      lines.push(`${indent}endpoint ${e.endpoint} (${e.type})  ${e.url ?? e.internalUrl}${provides}`);
    }
  };

  for (const region of env.regions) {
    lines.push(`region ${region.name} (${region.jurisdiction})`);
    for (const target of region.targets) {
      const agents = plan.agents.filter((a) => a.target === target.name);
      const freeApps = plan.apps.filter((a) => a.target === target.name && !a.pairedAgent);
      if (agents.length === 0 && freeApps.length === 0) {
        lines.push(`  target ${target.name} -> ${target.argoDestination}  (nothing placed)`);
        continue;
      }
      lines.push(`  target ${target.name} -> ${target.argoDestination}`);
      for (const agent of agents) {
        lines.push(`    agent ${agent.id}  ns ${agent.namespace}`);
        for (const app of plan.apps.filter((x) => x.pairedAgent === agent.id)) {
          lines.push(`      app ${app.app} (per-agent)`);
          pushEndpoints(app.id, "        ");
        }
        pushEndpoints(agent.id, "      ");
      }
      for (const app of freeApps) {
        lines.push(`    app ${app.id}  ns ${app.namespace}  scope ${app.scope}`);
        pushEndpoints(app.id, "      ");
      }
    }
  }

  if (plan.bindings.length > 0) {
    lines.push("bindings:");
    for (const b of plan.bindings) {
      const cross = b.crossRegion ? `  CROSS-REGION (${b.consumerRegion} -> ${b.providerRegion})` : "";
      const into = b.inject.env ? `env ${b.inject.env}` : `${b.inject.appValue!.app}.${b.inject.appValue!.path}`;
      lines.push(`  ${b.capability}: ${b.consumer} -> ${b.provider}  [${into}]${cross}`);
    }
  }
  return lines;
}
