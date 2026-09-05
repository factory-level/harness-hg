// Stages 1-2 workflow: install the Hermes fork CLI + gitops-emitter plugin
// (stage 1), then `hermes profile install` per configured Hermes agent
// (stage 2), then the push-driven emit per Eve agent (stage 2b, ADR-149 -
// no stage-1 dependency of its own: the emit runs the plugin from its
// checkout). None of these needs a Kubernetes provider at all — they're
// local.Command resources shelling out to `uv`/`hermes`/`git` — so this
// workflow runs unconditionally ahead of the stages.cluster check in
// src/index.ts.

import * as pulumi from "@pulumi/pulumi";
import { HermesInstall, HermesAgents, EveAgents } from "../components/index.ts";
import type { BootstrapConfig } from "./config.ts";

export interface HermesStagesResult {
  stage1Resources: pulumi.Resource[];
  stage2Resources: pulumi.Resource[];
}

export function runHermesStages(
  cfg: BootstrapConfig,
  // The explicit gitops-scaffold step's resources (issue #12 [B1]). Agent
  // installs chain onto these so the plugin's own install-time scaffold
  // fallback finds bootstrap/ already present (and never races the
  // dedicated step for repo creation).
  scaffoldResources: pulumi.Resource[] = [],
): HermesStagesResult {
  let stage1Resources: pulumi.Resource[] = [];
  if (cfg.stages.hermes) {
    stage1Resources = new HermesInstall("hermes-install", { config: cfg }).resources;
  } else {
    pulumi.log.info("stages.hermes is false - bootstrap stage 1 skipped entirely.");
  }

  let stage2Resources: pulumi.Resource[] = [];
  if (cfg.stages.agents) {
    const hermesAgents = new HermesAgents("hermes-agents", {
      config: cfg,
      dependsOn: [...stage1Resources, ...scaffoldResources],
    }).resources;
    // Eve agents emit after every Hermes install (one serial chain into
    // one GitOps branch); gated by stages.agents alone, never by
    // stages.hermes - an Eve-only stack runs no stage 1 at all.
    const eveAgents = new EveAgents("eve-agents", {
      config: cfg,
      dependsOn: [...hermesAgents, ...scaffoldResources],
    }).resources;
    stage2Resources = [...hermesAgents, ...eveAgents];
  } else {
    pulumi.log.info("stages.agents is false - bootstrap stage 2 skipped entirely.");
  }

  return { stage1Resources, stage2Resources };
}
