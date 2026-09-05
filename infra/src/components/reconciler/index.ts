// The destination-host reconciler (#271, ADR-54): declared state for the
// `hg reconcile` systemd user timer. One local.Command whose
// create/update runs `hg reconcile install` on the operator host and
// whose delete runs `hg reconcile uninstall` — so the timer's version,
// cadence, checks and apply command are all stack config, and "upgrade
// the reconciler" is `pulumi config set --path reconcile.version <rev>`
// followed by `pulumi up`, like every other declared thing here.
//
// dependsOn the stage-1 resources on purpose: hermes-profile-config is
// what upserts GITOPS_GIT_TOKEN into the operating profile's .env, and
// installing a timer that polls an authenticated remote BEFORE its
// credential exists would tick straight into authentication-required.

import * as path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { local } from "@pulumi/command";
import type { BootstrapConfig } from "../../control-flow/config.ts";

export interface ReconcilerArgs {
  config: BootstrapConfig;
  dependsOn?: pulumi.Resource[];
}

export class Reconciler extends pulumi.ComponentResource {
  public readonly resources: pulumi.Resource[] = [];

  constructor(name: string, args: ReconcilerArgs, opts?: pulumi.ComponentResourceOptions) {
    super("hermes-gitops:bootstrap:Reconciler", name, {}, opts);
    const rc = args.config.reconcile;
    if (!rc.enabled) {
      pulumi.log.info("reconcile.enabled is false - no destination-host reconciler is managed.");
      this.registerOutputs({});
      return;
    }

    // import.meta.dirname, not __dirname: bun defines the latter even in
    // ESM, node does not - and Pulumi's runtime is node (found live).
    const cliMain = path.resolve(import.meta.dirname, "..", "..", "..", "..", "cli", "src", "main.ts");
    const flags = [
      `--repo ${shellQuote(rc.repoUrl)}`,
      `--branch ${shellQuote(rc.branch)}`,
      `--interval ${rc.intervalSeconds}`,
      `--version ${shellQuote(rc.version)}`,
      rc.checks.length > 0 ? `--checks ${shellQuote(rc.checks.join(","))}` : "",
      rc.apply ? `--apply ${shellQuote(rc.apply)}` : "",
      rc.statusNamespace ? `--status-namespace ${shellQuote(rc.statusNamespace)}` : "",
      rc.kubeContext ? `--kube-context ${shellQuote(rc.kubeContext)}` : "",
      "--now",
    ]
      .filter(Boolean)
      .join(" ");

    const install = new local.Command(
      `${name}-install`,
      {
        create: `bun ${shellQuote(cliMain)} reconcile install ${flags}`,
        // Same command on update: `install` is idempotent and rewrites
        // units + daemon-reloads, which IS the upgrade path.
        update: `bun ${shellQuote(cliMain)} reconcile install ${flags}`,
        delete: `bun ${shellQuote(cliMain)} reconcile uninstall`,
        // Rerun exactly when the declared reconciler config changes -
        // the JSON is the trigger, so no field can change silently.
        triggers: [JSON.stringify(rc)],
      },
      { parent: this, dependsOn: args.dependsOn },
    );
    this.resources.push(install);
    this.registerOutputs({ resources: this.resources });
  }
}

/** Single-quote for sh, the minimal correct way. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
