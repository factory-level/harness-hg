// The explicit GitOps repo scaffold step (issue #12 [B1] — target control
// flow step 1). Creates the configured GitOps repo if missing (github.com
// only) and seeds it with the app-of-apps bootstrap/ tree (AppProject +
// ApplicationSet + cluster-values), as its OWN Pulumi resource — sequenced
// BEFORE Argo CD's hermes-gitops-root Application and independent of any
// agent install. Previously the scaffold only happened as a side-effect of
// the first `hermes profile install`, so `hermes-gitops-root` could point at
// a repo whose bootstrap/ tree was never written (agents: [] or the
// plugin's scaffold toggle off); with this step the root Application
// hard-depends on a resource that guarantees the tree exists.
//
// Runs `python -m gitops_emitter.scaffold_cli` inside the plugin repo's
// own uv project (`uv run --project <pluginPath>`), so it works whether or
// not stage 1 has installed the hermes tool venv yet — uv materializes the
// plugin's environment (PyYAML etc.) on demand. Idempotent: an
// already-scaffolded repo is left untouched (no commit, no push — the
// early return in gitops_emitter/scaffold.py), so a second `pulumi up` is
// a no-op. The plugin's own install-time scaffold remains as a defensive
// fallback and no-ops for the same reason.
//
// The control-flow layer skips constructing this component entirely when
// gitopsRepoUrl is a placeholder (same gate as the root Application).

import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";
import { resolvePluginPath, shellQuote } from "../harness/hermes-install/index.ts";
import type { BootstrapConfig } from "../../control-flow/config.ts";

export interface GitopsScaffoldArgs {
  config: BootstrapConfig;
}

export class GitopsScaffold extends pulumi.ComponentResource {
  readonly command: local.Command;

  constructor(name: string, args: GitopsScaffoldArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:GitopsScaffold", name, {}, opts);
    const cfg = args.config;
    const pluginPath = resolvePluginPath(cfg);

    const script = `set -eu
uv run --project ${shellQuote(pluginPath)} python -m gitops_emitter.scaffold_cli
`;

    const environment: Record<string, pulumi.Input<string>> = {
      GITOPS_REPO_URL: cfg.gitopsRepoUrl,
      GITOPS_BRANCH: cfg.gitopsBranch,
      HERMES_GITOPS_REPO_URL: cfg.hermesGitopsRepoUrl,
      CHART_REVISION: cfg.chartRevision,
    };
    // scaffold_cli reads the image tokens from ITS env - the plugin
    // config file is the emitter hook's source, not this one's. Omitting
    // them stranded a real fleet on the template's ghcr default.
    if (cfg.pluginConfig.imageRepository !== null) {
      environment["IMAGE_REPOSITORY"] = cfg.pluginConfig.imageRepository;
    }
    if (cfg.pluginConfig.imageTag !== null) {
      environment["IMAGE_TAG"] = cfg.pluginConfig.imageTag;
    }
    if (cfg.gitopsGitToken !== null) {
      environment["GITOPS_GIT_TOKEN"] = cfg.gitopsGitToken;
    }
    // Server-side pull-request enforcement (ADR-95, #179). Emitted ONLY
    // when the operator set it, so an unset stack shows no such variable
    // and no protection is attempted - the whole feature ships disabled.
    //
    // This is the BOOTSTRAP path deliberately. The emitter's runtime
    // `ensure_repo_and_scaffold` never receives this key, so the runtime
    // identity has no way to protect - or unprotect - the branch it
    // pushes to. An agent that can lift its own limit does not have one.
    if (cfg.gitopsBranchProtection !== null) {
      environment["GITOPS_BRANCH_PROTECTION"] = cfg.gitopsBranchProtection ? "true" : "false";
      environment["GITOPS_REQUIRED_REVIEWERS"] = String(cfg.gitopsRequiredReviewers ?? 0);
    }

    this.command = new local.Command(
      "gitops-scaffold",
      {
        create: script,
        update: script,
        environment,
        triggers: [
          cfg.gitopsRepoUrl,
          cfg.gitopsBranch,
          cfg.hermesGitopsRepoUrl,
          cfg.chartRevision,
          pluginPath,
          // The scaffold's cluster-values carries the agent image tokens -
          // an image change that never re-runs the scaffold strands every
          // profile on the old image (found live: fleet stuck pulling a
          // ghcr default that does not exist).
          cfg.pluginConfig.imageRepository,
          cfg.pluginConfig.imageTag,
        ],
      },
      { parent: this },
    );

    this.registerOutputs({});
  }
}
