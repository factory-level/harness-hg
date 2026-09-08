// The single source of truth for the CLI's command surface.
//
// Every command, subcommand and flag the CLI accepts is DATA here, and three
// consumers render it:
//   - main.ts derives VALUE_FLAGS and JSON_COMMANDS from it and prints
//     renderUsage()/renderCommandHelp() — an undocumented value flag now
//     fails to PARSE, so the docs cannot lag the parser.
//   - infra/scripts/generate-cli-docs.py renders _docs/wiki/reference/cli/ from it
//     (`bun src/commands.ts` prints the manifest as JSON) and cross-checks it
//     against main.ts's dispatch switch, exactly, in both directions.
//   - `hg help <command>` / `hg <command> --help` render one command's detail.
//
// Editing rules:
//   - A flag with `value` consumes the next argv token; without it the flag
//     is boolean. Getting this wrong is the classic silent bug (the value
//     lands in positionals) — cli/tests/main-flags.test.ts is the net.
//   - `summary` is one line, shown in the usage listing AND as the doc
//     section lead. `desc` is markdown prose for the doc page only.
//   - A command with no subcommands has one Sub with name "".

export interface Flag {
  /** "--dir" */
  name: string;
  /** Placeholder for the consumed value, e.g. "<repo-path>". ABSENT = boolean flag. */
  value?: string;
  /** Rendered in help and the docs flags table. */
  default?: string;
  /** One sentence. */
  desc: string;
}

export interface Sub {
  /** "inspect"; "" = the bare command form. */
  name: string;
  /** Positional synopsis, e.g. "<./path | repo-url>". */
  args?: string;
  /** One line, shared by usage output and the doc section lead. */
  summary: string;
  /** Longer markdown prose, doc page only. */
  desc?: string;
  flags?: Flag[];
  /** Shell example lines, doc page only. */
  examples?: string[];
  /** Marks a LOOP FRONT DOOR (#673): renderUsage leads with these three
   * before the journey groups, and the docs index mirrors it. */
  frontDoor?: boolean;
}

/** The operator journeys. Every command serves at least one;
 * "harness-legacy" follows the frozen Hermes harness; "all" is meta. */
export type Loop = "ops" | "dev" | "agent-bundle" | "harness-legacy" | "all";

export interface Command {
  /** "topology" — must equal the dispatch `case` label in main.ts. */
  name: string;
  /** Journey membership — the loop map from _docs/design/cli.md, as data.
   * Enforced by tests/commands-grammar.test.ts and generate-cli-docs.py:
   * no loop, no merge. */
  loops: Loop[];
  summary: string;
  /** Markdown prose for the doc page's Description section. */
  desc?: string;
  /** Supports --json (one JSON document on stdout, narration on stderr). */
  json?: boolean;
  subs: Sub[];
  /** Repo-relative doc links for the page's See-also section. */
  see?: string[];
}

// Flags shared by every sub of a command, declared once.
const PROFILE: Flag = { name: "--profile", value: "<name>", desc: "Narrow to one profile; default is every onboarded profile." };
const RECONCILE_INSTANCE: Flag = { name: "--instance", value: "<name>", desc: "Named repository watcher; omitted selects the existing default. All instances share the deployment lock." };
const DIR_REPO: Flag = { name: "--dir", value: "<repo-path-or-git-url>", desc: "The persona/distribution repository to read declarations from." };
const ENVIRONMENT: Flag = { name: "--environment", value: "<file>", desc: "The cluster half, overriding the repo's own: a legacy `topology.yaml`-shaped file (targets inline), or an environment spec (`infra/environments/<env>.yaml`) whose `grants` supply targets, DNS, policy and capability providers for the team's target-free `harness-hg/topology.yaml`. Team files (bundles, communication, capabilities) always come from the repo's `harness-hg/` (legacy: `environment/`)." };
const CONTROL_PLANE: Flag = { name: "--control-plane", value: "<url>", desc: "Base URL of the control plane (the exposed Nexus)." };

/** One meaning per verb, everywhere it appears. A sub's verb is
 * the LAST word of its name; a new sub whose verb is missing here fails
 * tests/commands-grammar.test.ts until a meaning is written. */
export const VERBS: Record<string, string> = {
  list: "enumerate the subject's declared or live items",
  inspect: "resolve ONE item and show it in full",
  show: "resolve ONE live item and show it (inspect's live twin)",
  plan: "the compiled plan — read-only, no cluster required",
  prove: "run the subject's acceptance matrix; emits a ProofResult (unknown is never a pass)",
  doctor: "diagnose declared-vs-actual and name the fix",
  emit: "write generated files into a repository tree",
  publish: "send one thing to a live external surface",
  unpublish: "withdraw what publish sent",
  restore: "replay state from a captured artifact",
  verify: "check an artifact or binding against its declaration",
  "verify-restore": "restore the newest backup and record whether it is restorable",
  test: "exercise the real path end to end, once",
  run: "trigger the subject's job now",
  status: "the subject's current state, summarized",
  errors: "the subject's current failures, itemized",
  create: "make the artifact",
  fetch: "pull an artifact from its sink to local disk",
  export: "write an artifact out for another system",
  evidence: "bundle proofs and artifacts for an auditor",
  validate: "check a document against its schema, offline",
  render: "print the generated form to stdout",
  print: "print the resolved tree to stdout",
  compile: "build the derived artifact from declarations",
  set: "write one value",
  unset: "remove one value",
  use: "select the active target",
  install: "put the component onto this host",
  uninstall: "remove what install put",
  "install-timer": "install the subject's scheduled systemd timers",
  enable: "resume the subject",
  disable: "pause the subject without removing it",
  apply: "push the declared state to the live system",
  import: "one-shot: existing hand-maintained state becomes a declared spec",
  new: "day-0 for a declared thing that does not exist yet - orchestrated, resumable",
  init: "scaffold the declared shape into an empty directory - idempotent, never overwrites",
  exec: "run one command inside the live target",
  sync: "reconcile the live copy with the source now",
  retry: "re-drive the failed deliveries",
  replay: "re-deliver from the dead-letter queue",
  dlq: "the dead-letter queue's contents",
  history: "past runs, newest first",
  tail: "follow the captured stream",
  clear: "empty the captured stream",
  results: "read back stored outcomes",
  evals: "the stored eval outcomes for one agent",
  urls: "the subject's reachable addresses",
  features: "the feature flags the control plane serves",
  preflight: "prove the prerequisites before mutating anything",
  bootstrap: "first-time provisioning of the target",
  register: "record the target with the control plane",
  destroy: "tear the target down permanently",
  upgrade: "migrate the target to the current contract",
};

export const COMMANDS: Command[] = [
  {
    name: "onboard",
    loops: ["dev"],
    summary: "register a repo, or one agent, with the local loop",
    desc:
      "Registers a profile directory OR a whole catalogue (`distributions/*` + `.hermes-dist/*`). " +
      "All discovered profiles boot on the next `hg up` unless `--profile` narrows to one.",
    subs: [
      {
        name: "",
        args: "<./path | repo-url>",
        summary: "register a profile directory or catalogue",
        flags: [
          { name: "--profile", value: "<name>", desc: "Narrow a catalogue to one profile." },
          { name: "--env", value: "<path/.env>", desc: "Pin a dotenv file (default: `<root>/.env` plus per-profile `.env`)." },
        ],
        examples: ["hg onboard ../my-team", "hg onboard ../repo --profile research"],
      },
    ],
  },
  {
    name: "up",
    loops: ["dev"],
    summary: "start the local loop: cluster, Argo CD, Grafana, git remotes, every onboarded agent",
    subs: [{ name: "", summary: "boot the full local environment" }],
  },
  {
    name: "dev",
    loops: ["dev"],
    summary: "watch loop: an edit commits, renders and syncs through the real Git \u2192 Argo CD path",
    desc: "Chart edits ship as `-dev.N` builds; everything still flows through the real git → Argo CD path, so what works in `dev` works deployed. Cold (nothing onboarded), `hg dev <repo-path>` runs the whole onramp - onboard → up → dev - narrating each command.",
    subs: [{ name: "", args: "[<repo-path>]", summary: "start the hot-reload REPL (cold: onboard → up → dev)", frontDoor: true }],
  },
  {
    name: "validate",
    loops: ["dev", "agent-bundle"],
    summary: "the contract gate, no cluster: every failure at once",
    json: true,
    subs: [
      {
        name: "",
        summary: "validate every onboarded profile's contracts, or one repo one-shot with --dir",
        examples: ["hg validate", "hg validate --dir ../my-team --json"],
        flags: [DIR_REPO],
      },
    ],
  },
  {
    name: "test",
    loops: ["dev"],
    summary: "run the acceptance tiers against every agent",
    json: true,
    subs: [
      {
        name: "",
        summary: "run one tier (or the default set) against every profile",
        examples: ["hg test --tier smoke", "hg test --tier workspace-bindings --json"],
        flags: [
          { name: "--tier", value: "register|smoke|backup|behavioral|workspace-bindings", desc: "Which tier to run. The `behavioral` tier is deprecated: use `hg eval`." },
          { name: "--allow-repo-scripts", desc: "Permit repo-provided test scripts to execute." },
          { name: "--gitops", value: "<clone>", desc: "GitOps clone for tiers that assert against the emitted repo." },
        ],
      },
    ],
  },
  {
    name: "logs",
    loops: ["dev", "ops"],
    summary: "container logs, crash context and Argo conditions for one pod",
    json: true,
    subs: [
      {
        name: "",
        summary: "collect logs and failure context",
        flags: [
          PROFILE,
          { name: "--app", value: "<name>", desc: "Narrow to one app's containers." },
          { name: "--tail", value: "<n>", default: "50", desc: "Lines per container." },
        ],
      },
    ],
  },
  {
    name: "prompt",
    loops: ["dev", "agent-bundle"],
    summary: "send one prompt to a deployed agent",
    json: true,
    subs: [
      {
        name: "",
        args: '"<text>"',
        summary: "send one prompt and print the reply",
        flags: [PROFILE, { name: "--timeout", value: "<seconds>", default: "300", desc: "How long to wait for the reply." }],
      },
    ],
  },
  {
    name: "dash",
    loops: ["dev", "ops"],
    summary: "declared dashboards and alerts vs what Grafana actually imported",
    desc:
      "Compares declared dashboard ConfigMaps with what Grafana actually imported (by uid, params typed). " +
      "Unrelated to `hg nexus`, which compiles the Nexus canvas.",
    json: true,
    subs: [
      { name: "list", summary: "declared vs imported dashboards and alerts", flags: [PROFILE, { name: "--app", value: "<name>", desc: "Narrow to one app's dashboards." }] },
      { name: "errors", summary: "broken datasources and expressions", flags: [PROFILE] },
    ],
  },
  {
    name: "platform",
    loops: ["ops"],
    summary: "the environment backup: create, schedule, fetch, restore, verify, prove",
    desc:
      "Environment-level backup: fresh routine archives plus the host Nexus overlay, scaffolded into one " +
      "manifest-ed directory. `restore` replays it onto a re-bootstrapped cluster; `backup prove` emits the " +
      "design-16 ProofResult (available/restorable).",
    json: true,
    subs: [
      {
        name: "backup create",
        summary: "scaffold a full platform backup into a directory",
        examples: ["hg platform backup create --to ~/platform-backups", "hg platform backup prove --from ~/platform-backups/<id>"],
        flags: [
          { name: "--to", value: "<dir>", desc: "Where the backup directory is written." },
          { name: "--sink", value: "gs://<bucket>/<prefix>|emulated", desc: "Also upload the backup to a sink." },
        ],
      },
      {
        name: "install-timer",
        summary: "schedule the backup AND a weekly restore verification",
        desc:
          "Schedules BOTH the backup and a weekly restore VERIFICATION: without the second, restorable is " +
          "a state reached once by hand that then drifts while every surface shows the last one.",
        flags: [
          { name: "--to", value: "<dir>", desc: "Backup destination the timer writes into." },
          { name: "--now", desc: "Enable and start the timer immediately." },
          { name: "--schedule", value: "<oncalendar>", desc: "systemd OnCalendar expression for the backup." },
          { name: "--verify-schedule", value: "<oncalendar>", desc: "systemd OnCalendar expression for the weekly restore verification." },
        ],
      },
      {
        name: "fetch",
        args: "[<backup-id>|latest]",
        summary: "download a backup from the sink",
        flags: [
          { name: "--sink", value: "gs://<bucket>/<prefix>|emulated", desc: "Sink to read from." },
          { name: "--to", value: "<dir>", desc: "Where to place the fetched backup." },
        ],
      },
      { name: "restore", summary: "replay a backup onto a re-bootstrapped cluster", flags: [{ name: "--from", value: "<backup-dir>", desc: "The backup directory to restore from." }] },
      {
        name: "verify-restore",
        summary: "restore into a scratch environment and assert the result",
        flags: [
          { name: "--from", value: "<backup-dir>", desc: "Backup directory to verify." },
          { name: "--sink", value: "gs://<bucket>/<prefix>|emulated", desc: "Verify the newest backup in a sink instead." },
        ],
      },
      {
        name: "backup prove",
        summary: "PLAT001..007: the fleet is REBUILDABLE, not merely backed up",
        flags: [
          { name: "--from", value: "<backup-dir>", desc: "The backup to prove recovery from." },
          { name: "--timeout", value: "<seconds>", default: "300", desc: "Per-step timeout." },
        ],
      },
      {
        name: "evidence",
        summary: "bundle versions, SHAs, server identity and proofs into one directory",
        desc:
          "Evidence bundles versions+SHAs+server identity, the SCRUBBED backup record, and any ProofResult `*.json` " +
          "the operator saved under `--to`; sweeps for secret shapes before writing. `--sink` uploads it so it " +
          "survives the machine it describes.",
        flags: [
          { name: "--to", value: "<dir>", desc: "Where the evidence bundle is written." },
          { name: "--from", value: "<backup-dir>", desc: "The backup the evidence describes." },
          { name: "--sink", value: "gs://<bucket>/<prefix>", desc: "Upload the bundle off-machine." },
        ],
      },
    ],
    see: ["../../platform/backups.md"],
  },
  {
    name: "backup",
    loops: ["ops", "agent-bundle"],
    summary: "app-owned backup routines: list, run, verify, export, restore",
    desc:
      "App-owned backup ROUTINES (CronJobs labelled `hermes.dev/backup-routine`), platform-owned invocation. " +
      "A routine whose artifact is NOT a volume tarball declares `hermes.dev/backup-restore-hook` (JSON: workload, " +
      "container, command, stagePath, quiesce) and needs `--allow-restore-hook`, since the command comes from the " +
      "cluster. A routine with neither is reported unrestorable, never restored wrongly.",
    json: true,
    subs: [
      { name: "list", summary: "routines with staleness", flags: [PROFILE, { name: "--routine", value: "<name>", desc: "Narrow to one routine." }] },
      {
        name: "run",
        summary: "trigger a routine now",
        examples: ["hg backup list", "hg backup run --profile manager --routine postiz-db --verify"],
        flags: [
          PROFILE,
          { name: "--routine", value: "<name>", desc: "The routine to trigger." },
          { name: "--verify", desc: "Verify the produced artifact after the run." },
          { name: "--timeout", value: "<seconds>", default: "180", desc: "How long to wait for the job." },
        ],
      },
      { name: "verify", summary: "open the newest artifact and assert it contains what it claims", flags: [PROFILE, { name: "--routine", value: "<name>", desc: "The routine whose artifact to verify." }] },
      {
        name: "export",
        summary: "copy the newest artifact off-cluster (checksummed)",
        flags: [PROFILE, { name: "--routine", value: "<name>", desc: "The routine to export." }, { name: "--to", value: "<dir>", desc: "Destination directory." }],
      },
      {
        name: "restore",
        summary: "quiesce the writer, wipe the data PVC, untar the archive, resume",
        flags: [
          PROFILE,
          { name: "--routine", value: "<name>", desc: "The routine to restore." },
          { name: "--from", value: "<archive.tar.gz>", desc: "Restore from a local archive instead of the newest artifact." },
          { name: "--allow-restore-hook", desc: "Permit a cluster-declared restore hook to run." },
          { name: "--timeout", value: "<seconds>", default: "180", desc: "How long to wait for each step." },
        ],
      },
    ],
    see: ["../../platform/backups.md"],
  },
  {
    name: "eval",
    loops: ["agent-bundle", "dev"],
    see: ["../contracts/evals.md", "../contracts/eval-result.md"],
    summary: "run the repo's eval suite; publish and read back results",
    json: true,
    subs: [
      {
        name: "",
        summary: "run the repo's OPTIONAL deterministic eval suite against the deployed profiles",
        examples: ["hg eval --dir ./evals", "hg eval --dir ../persona --scenario greets --repeat 3"],
        desc: "Suite schema: `cli/schemas/evals/` (see the contract reference).",
        flags: [
          { name: "--dir", value: "<repo-or-evals-dir>", desc: "The repo (or its `evals/` directory) holding the suite." },
          PROFILE,
          { name: "--scenario", value: "<name>", desc: "Run one scenario only." },
          { name: "--repeat", value: "<n>", default: "1", desc: "Repeat the suite N times." },
          { name: "--timeout", value: "<seconds>", default: "300", desc: "Per-scenario timeout." },
          { name: "--allow-repo-scripts", desc: "Permit repo-provided scripts to execute." },
        ],
      },
      {
        name: "publish",
        summary: "publish a run's report to the control plane's eval store",
        desc:
          "Token from `HG_EVAL_TOKEN` or `--token-file`, never argv; an Access-guarded edge needs " +
          "`HG_CF_ACCESS_CLIENT_ID`/`_SECRET` too.",
        flags: [
          CONTROL_PLANE,
          { name: "--report", value: "<report.json>", desc: "The run report to publish (default: the newest local run)." },
          { name: "--component", value: "<id>", desc: "Component id the results are recorded under." },
          { name: "--token-file", value: "<path>", desc: "File holding the publish token — a FILE, never the token itself: argv is world-readable through /proc." },
        ],
      },
      {
        name: "results",
        args: "<component>",
        summary: "read back the published results for a component",
        flags: [
          CONTROL_PLANE,
          { name: "--suite", value: "<name>", desc: "Narrow to one suite." },
          { name: "--scenario", value: "<name>", desc: "Narrow to one scenario." },
          { name: "--limit", value: "<n>", default: "50", desc: "Maximum rows returned." },
        ],
      },
      {
        name: "prove",
        summary: "EVALPUB001..004: anonymous publish refused, forged token refused, readback complete, no credential material served",
        flags: [CONTROL_PLANE, { name: "--component", value: "<id>", desc: "Component to prove against." }],
      },
    ],
  },
  {
    name: "gitops",
    loops: ["agent-bundle"],
    summary: "verify or upgrade a destination repo",
    json: true,
    subs: [
      {
        name: "doctor",
        args: "<gitops-repo-dir>",
        summary: "verify the scaffold: ownership manifest, generator set, catalogue twins, deployments/ vs plan.yaml",
        desc: "Edited or deleted managed files are refused via the `scaffold.yaml` ownership manifest.",
      },
      {
        name: "upgrade",
        args: "<gitops-repo-dir>",
        summary: "adopt a legacy repo IN THE WORKING TREE",
        desc:
          "`environment/` synthesized, records moved to the catalogue, fleet compiled, generators swapped, " +
          "`scaffold.yaml` written. Never commits or pushes — prints the cluster pre-flight the operator runs before push.",
      },
    ],
  },
  {
    name: "topology",
    loops: ["agent-bundle"],
    see: ["../contracts/environment-topology.md", "../contracts/topology-plan.md"],
    summary: "compile the declarations against an environment, no cluster",
    desc:
      "Compiles the repo's declarations against an environment topology, offline. `emit` materializes `catalog/` + " +
      "`deployments/` into a GitOps repo (refuses on errors). `--layout` simulates a different layout without " +
      "touching the file.",
    json: true,
    subs: [
      {
        name: "inspect",
        summary: "validated declarations only",
        flags: [DIR_REPO, ENVIRONMENT],
        examples: ["hg topology inspect --dir ../my-team", "hg topology doctor --dir ."],
      },
      { name: "plan", summary: "the full physical plan (instances, bindings, findings)", flags: [DIR_REPO, ENVIRONMENT, { name: "--layout", value: "single|replicated|hub-spoke", desc: "Simulate a layout without touching the file." }] },
      { name: "urls", summary: "the endpoint URL matrix", flags: [DIR_REPO, ENVIRONMENT] },
      { name: "print", summary: "the plan as a region → target → instance tree", flags: [DIR_REPO, ENVIRONMENT] },
      {
        name: "doctor",
        summary: "plan findings + repo lint",
        flags: [
          DIR_REPO,
          ENVIRONMENT,
          { name: "--deep", desc: "Also render the pinned charts." },
          { name: "--fix", desc: "Upgrade v1 environment files to contract v2 in place." },
        ],
      },
      {
        name: "emit",
        summary: "materialize catalog/ + deployments/ into a GitOps repo",
        flags: [
          DIR_REPO,
          ENVIRONMENT,
          { name: "--output", value: "<gitops-dir>", desc: "The GitOps repo to write into (alias `--repo`)." },
          { name: "--repo", value: "<gitops-dir>", desc: "Alias of `--output` (the DevX-contract spelling)." },
          { name: "--source", value: "<repo-path-or-git-url>", desc: "Alias of `--dir` (the DevX-contract spelling)." },
          { name: "--router-image", value: "<image>", desc: "Environment knob written as a top-level chart value beside spec." },
          { name: "--observer-url", value: "<url>", desc: "Debug observer URL the router mirrors lifecycle records to." },
          { name: "--argo-destinations", value: "<mode>", desc: "How Argo CD destinations are written into the emitted applications." },
        ],
      },
    ],
  },
  {
    name: "observability",
    loops: ["agent-bundle"],
    summary: "the observability overlay: inventory and proof",
    json: true,
    subs: [
      { name: "inspect", summary: "the canonical workload inventory joined with live source levels", flags: [CONTROL_PLANE] },
      { name: "prove", summary: "OBS001..OBS010: schema, all 7 sources, never-green, links, secret scan, promised dashboard uids", flags: [CONTROL_PLANE] },
    ],
  },
  {
    name: "launch",
    loops: ["ops"],
    summary: "the whole acceptance matrix for an environment, aggregated",
    desc:
      "LAUNCH001..006: aggregates the auth/grafana/backup/recovery subjects. A subject that cannot be run reads " +
      "`unknown` — never a pass.",
    json: true,
    subs: [
      { name: "prove", summary: "run every subject's matrix and aggregate", flags: [{ name: "--browser", desc: "Add the Nexus browser acceptance run (playwright against the exposed Nexus)." }] },
    ],
    see: ["../../platform/testing.md"],
  },
  {
    name: "reconcile",
    loops: ["ops"],
    summary: "the destination host's reconcile timer",
    desc:
      "`install` writes and starts the timer, `run` applies once in the foreground, `sync` forces a cycle — and is " +
      "SKIPPED, never queued, while the timer holds the lock. `status` reports the last outcome; `prove` verifies " +
      "the loop actually applies.",
    json: true,
    subs: [
      {
        name: "install",
        summary: "write and start the reconcile timer",
        examples: ["hg reconcile install --repo https://github.com/org/persona.harness-hg --now", "hg reconcile status"],
        desc: "A re-install (a version bump through pulumi) may omit flags and keep the stored config; a first install must name the repo.",
        flags: [
          RECONCILE_INSTANCE,
          { name: "--repo", value: "<url>", desc: "The repository the loop applies." },
          { name: "--branch", value: "<name>", default: "main", desc: "Branch to track." },
          { name: "--interval", value: "<seconds>", default: "60", desc: "Tick interval." },
          { name: "--checks", value: "'a,b'", desc: "Comma-separated pre-apply check commands." },
          { name: "--apply", value: "<cmd>", desc: "The apply command the loop runs." },
          { name: "--version", value: "<rev>", desc: "Version the install is pinned to." },
          { name: "--harness-home", value: "<dir>", default: "~/.hermes", desc: "The harness home whose `.env` carries `GITOPS_GIT_TOKEN` (the legacy Hermes home by default)." },
          { name: "--kube-context", value: "<name>", desc: "Kube context for post-apply health checks." },
          { name: "--status-namespace", value: "<ns>", desc: "Namespace status records are published into." },
          { name: "--timeout", value: "<seconds>", default: "900", desc: "Argo CD health timeout after an apply." },
          { name: "--now", desc: "Enable and start immediately (`--enable` is a value flag elsewhere; mirrors `systemctl enable --now`)." },
        ],
      },
      { name: "run", summary: "apply once in the foreground (the timer's tick)", flags: [RECONCILE_INSTANCE] },
      { name: "status", summary: "the last outcome — read-only, safe while a run is in flight", flags: [RECONCILE_INSTANCE] },
      { name: "sync", summary: "force a cycle; SKIPPED, never queued, while the timer holds the lock", flags: [RECONCILE_INSTANCE] },
      { name: "retry", summary: "clear the blocked gate and force a cycle", flags: [RECONCILE_INSTANCE] },
      { name: "prove", summary: "verify the loop actually applies", flags: [RECONCILE_INSTANCE] },
      { name: "uninstall", summary: "remove the timer and its units", flags: [RECONCILE_INSTANCE] },
    ],
  },
  {
    name: "nexus",
    loops: ["agent-bundle"],
    see: ["../contracts/dashboard-contribution.md", "../contracts/dashboard-plan.md"],
    summary: "the Nexus UI plan compiler",
    desc:
      "Compiles authored `dashboard/` contributions against the topology plan into the Nexus canvas. " +
      "(`hg dash` reconciles Grafana ConfigMaps — unrelated.)",
    json: true,
    subs: [
      { name: "validate", summary: "authored dashboard/ files against their schemas", flags: [{ name: "--source", value: "<repo-path-or-git-url>", desc: "The contributing repo (alias `--dir`)." }] },
      {
        name: "compile",
        summary: "join contributions × the topology plan",
        examples: ["hg nexus compile --source ../persona --gitops ../gitops", "hg nexus prove --source ../persona"],
        desc: "With `--gitops` it also writes the plan — `emit`'s contract spelling.",
        flags: [
          { name: "--source", value: "<repo-path-or-git-url>", desc: "The contributing repo (alias `--dir`)." },
          { name: "--dir", value: "<repo-path-or-git-url>", desc: "Alias of `--source`." },
          { name: "--gitops", value: "<gitops-repo-dir>", desc: "GitOps repo to write the plan into (alias `--output`)." },
          { name: "--output", value: "<gitops-repo-dir>", desc: "Alias of `--gitops`." },
          ENVIRONMENT,
          { name: "--workload-endpoints", value: "<file.yaml>", desc: "Workload endpoint declarations." },
          { name: "--layout", value: "single|replicated|hub-spoke", desc: "Simulate a layout." },
        ],
      },
      { name: "print", summary: "the canvas as a component tree", flags: [{ name: "--source", value: "<repo-path-or-git-url>", desc: "The contributing repo (alias `--dir`)." }, ENVIRONMENT] },
      {
        name: "emit",
        summary: "write deployments/control-plane/nexus-plan.json (refuses on findings; prunes only its own tree)",
        flags: [
          { name: "--source", value: "<repo-path-or-git-url>", desc: "The contributing repo (alias `--dir`)." },
          { name: "--gitops", value: "<gitops-repo-dir>", desc: "The GitOps repo to write into (alias `--output`)." },
          ENVIRONMENT,
          { name: "--workload-endpoints", value: "<file.yaml>", desc: "Workload endpoint declarations." },
        ],
      },
      { name: "inspect", args: "<id>", summary: "one component's bindings + destinations", flags: [{ name: "--plan", value: "<nexus-plan.json>", desc: "The compiled plan to inspect." }] },
      {
        name: "install",
        summary: "copy the dashboard plugin into the local control-plane Hermes and point it at --gitops",
        flags: [
          { name: "--source", value: "<repo-path-or-git-url>", desc: "The repo providing the dashboard plugin (alias `--dir`)." },
          { name: "--gitops", value: "<gitops-repo-dir>", desc: "The GitOps clone the installed plugin reads." },
        ],
      },
      {
        name: "prove",
        summary: "the DevX acceptance matrix; artifacts under .hg/proofs/nexus/<timestamp>/",
        desc: "Offline legs always run; live legs run against `--control-plane`.",
        flags: [{ name: "--source", value: "<repo-path-or-git-url>", desc: "The contributing repo (alias `--dir`)." }, CONTROL_PLANE],
      },
      {
        name: "features",
        summary: "list or flip workspace flags on the local install",
        desc: "Needs no `--source`; applies without a restart.",
        flags: [
          { name: "--enable", value: "id,..|all", desc: "Flags to enable." },
          { name: "--disable", value: "id,..|all", desc: "Flags to disable." },
          { name: "--reset", desc: "Restore registry defaults." },
        ],
      },
      {
        name: "set",
        args: "<key=value>...",
        summary: "charts/nexus value overrides for the local install, applied on the next `up`",
        desc: "Parity rule: anything the Pulumi bootstrap can configure must be configurable here too. An empty value clears; no args lists.",
      },
    ],
  },
  {
    name: "event",
    loops: ["ops", "agent-bundle"],
    summary: "the event router: list, trace, publish, prove the queue, dead letters",
    desc:
      "`list`/`inspect`/`plan`/`payload validate` are OFFLINE; `emit` publishes through the REAL router " +
      "(schema-gated, waits for queued deliveries to settle); `status` traces receipts.",
    json: true,
    subs: [
      { name: "list", summary: "declared events", flags: [{ name: "--dir", value: "<repo>", desc: "The declaring repo." }, ENVIRONMENT] },
      { name: "inspect", args: "<event>|<binding>", summary: "one event or binding, resolved", flags: [{ name: "--dir", value: "<repo>", desc: "The declaring repo." }, ENVIRONMENT] },
      { name: "plan", summary: "the compiled delivery plan", flags: [{ name: "--dir", value: "<repo>", desc: "The declaring repo." }, ENVIRONMENT] },
      { name: "payload validate", args: "<event>", summary: "validate a payload file against the event's schema, offline", flags: [{ name: "--payload", value: "<file.json>", desc: "The payload to validate." }] },
      {
        name: "publish",
        args: "<event>",
        summary: "publish through the REAL router; waits for queued deliveries to settle (was: emit)",
        examples: ["hg event list --dir .", "hg event publish content.published --payload evt.json --from manager/postiz#published"],
        flags: [
          { name: "--payload", value: "<file.json>", desc: "The event payload." },
          { name: "--from", value: "<p>/<app>#<out>", desc: "The emitting output binding." },
          { name: "--to-agent", value: "<profile>", desc: "Deliver to one agent profile." },
          { name: "--to-chatops", value: "<space>", desc: "Deliver to one ChatOps space." },
          { name: "--correlation", value: "<id>", desc: "Correlation id threaded through the delivery records." },
          { name: "--ordering-key", value: "<k>", desc: "Same-key deliveries are FIFO." },
          { name: "--duplicate", desc: "Send the same delivery twice to prove dedup." },
        ],
      },
      { name: "status", args: "[<event>]", summary: "trace receipts", flags: [{ name: "--correlation", value: "<id>", desc: "Trace one correlation." }, { name: "--delivery", value: "<id>", desc: "Trace one delivery." }] },
      {
        name: "queue test",
        summary: "durable acceptance + same-key FIFO + cross-key concurrency + an empty DLQ",
        flags: [{ name: "--count", value: "<n>", default: "3", desc: "Deliveries per leg." }, { name: "--ordering-key", value: "<k>", desc: "Key for the FIFO leg." }],
      },
      { name: "dlq", summary: "list the dead letters" },
      { name: "dlq replay", args: "<deliveryId>", summary: "re-queue one dead letter" },
      {
        name: "ingress test",
        summary: "the ingress signature matrix",
        flags: [{ name: "--signature", value: "valid|invalid|missing|stale", desc: "Which signature case to send." }, { name: "--payload", value: "<file.json>", desc: "The payload to send." }],
      },
    ],
    see: ["../../platform/webhooks-events.md", "../contracts/environment-communication.md"],
  },
  {
    name: "chatops",
    loops: ["agent-bundle"],
    see: ["../contracts/environment-communication.md"],
    summary: "ChatOps spaces: list, plan, render, tail, test",
    desc: "`list`/`plan`/`render` are OFFLINE (`render` never sends); `test` delivers one message through the environment's REAL provider binding.",
    json: true,
    subs: [
      { name: "list", summary: "declared spaces", flags: [{ name: "--dir", value: "<repo>", desc: "The declaring repo." }] },
      { name: "plan", summary: "the compiled space plan", flags: [{ name: "--dir", value: "<repo>", desc: "The declaring repo." }] },
      {
        name: "render",
        args: "[<alias>#<destination>]",
        summary: "render a message offline — never sends",
        flags: [
          { name: "--event", value: "<event>", desc: "The event to render." },
          { name: "--payload", value: "<file.json>", desc: "The payload to render with." },
          { name: "--dir", value: "<repo>", desc: "The declaring repo." },
        ],
      },
      { name: "tail", summary: "the recording sink's captured messages (was: inspect)" },
      { name: "test", args: "[<alias>#<destination>]", summary: "deliver one message through the REAL provider binding", flags: [{ name: "--dir", value: "<repo>", desc: "The declaring repo." }] },
    ],
  },
  {
    name: "communication",
    loops: ["ops"],
    see: ["../contracts/environment-communication.md"],
    summary: "the communication acceptance matrix as one command",
    desc:
      "Compile + emit determinism + fan-out + incident sessions + queue conformance + consumer restart + DLQ replay + " +
      "the ingress signature matrix + the recording provider's captures + secret redaction. The live flags add a real " +
      "Discord sandbox message and a real Grafana fire/resolve cycle.",
    json: true,
    subs: [
      {
        name: "prove",
        summary: "run the whole matrix",
        flags: [
          { name: "--dir", value: "<repo>", desc: "The declaring repo." },
          ENVIRONMENT,
          { name: "--require-live-chatops", desc: "Fail (instead of unknown) when the live Discord leg cannot run." },
          { name: "--require-live-grafana", desc: "Fail (instead of unknown) when the live Grafana leg cannot run." },
          { name: "--to-chatops", value: "<alias>#<channel>", desc: "Where the live sandbox message is sent." },
          { name: "--since", value: "<iso-time>", desc: "Only consider captures after this time." },
          { name: "--stage", value: "<stage>", desc: "Run one stage of the matrix." },
        ],
      },
    ],
  },
  {
    name: "discord",
    loops: ["ops", "dev"],
    summary: "the Discord gateway, observed from outside (Hermes-native; Eve's Discord is the connection gateway's)",
    desc:
      "Declaration, token/authz env BINDING (names only, never values), and the adapter's own `gateway.log` " +
      "connect lines from the pod. Refuses on an Eve profile - the connection gateway owns Discord there " +
      "(`hg connection prove`, and `hg agent prove` legs EVE021/EVE024).",
    json: true,
    subs: [{ name: "status", summary: "gateway declaration + binding + connect evidence", flags: [PROFILE] }],
  },
  {
    name: "cron",
    loops: ["ops", "dev"],
    summary: "the agent's scheduler surface - Hermes wrapped natively, Eve projected read-only",
    desc:
      "Every cron verb acts on ONE profile's job registry — a fleet-wide `cron run` would be a different, more " +
      "dangerous verb than the one an operator is asking for. With more than one profile deployed, `--profile` is required. " +
      "On an Eve profile, `list|show|history` project the declared `agent/schedules/`; the mutating verbs refuse - " +
      "Eve compiles schedules at build (`hg agent prove`, leg EVE015).",
    subs: [
      { name: "list", summary: "the profile's cron jobs (paused jobs included)", flags: [PROFILE] },
      { name: "show", args: "<job>", summary: "one job's definition and state", flags: [PROFILE] },
      { name: "history", args: "[<job>]", summary: "recent runs", flags: [PROFILE] },
      { name: "run", args: "<job>", summary: "trigger a job now", flags: [PROFILE] },
      { name: "enable", args: "<job>", summary: "resume a paused job", flags: [PROFILE] },
      { name: "disable", args: "<job>", summary: "pause a job", flags: [PROFILE] },
    ],
  },
  {
    name: "debug",
    loops: ["dev", "ops"],
    summary: "the passive debug observer",
    desc:
      "Manage the host webhook sink and read its JSONL. The router mirrors metadata-only lifecycle records here only " +
      "when its emitted values carry the URL (`topology emit --observer-url`) — Git decides, never this command.",
    json: true,
    subs: [
      { name: "webhook enable", summary: "start the host webhook sink" },
      { name: "webhook status", summary: "sink state and URL" },
      {
        name: "webhook tail",
        summary: "read the captured records",
        flags: [
          { name: "--tail", value: "<n>", default: "20", desc: "How many records." },
          { name: "--planes", value: "<plane,..>", desc: "Filter by plane." },
        ],
      },
      { name: "webhook clear", summary: "truncate the capture file" },
      { name: "webhook disable", summary: "stop the sink" },
    ],
  },
  {
    name: "edge",
    loops: ["ops"],
    summary: "the tunnel and access policy: prove, publish, unpublish, list",
    json: true,
    subs: [
      {
        name: "prove",
        summary: "live-verify the tunnel + Access the Pulumi stack provisioned, against the REAL account",
        desc:
          "API-token permission preflight, stack outputs, DNS propagation, unauth + bogus-token denial " +
          "on every Access-gated hostname, no-Access webhook hostnames reachable unauthenticated, " +
          "undeclared hostnames unpublished, no public Service bypass (`--kubeconfig`), " +
          "`pulumi preview --expect-no-changes`.",
        flags: [
          { name: "--stack", value: "<stack>", desc: "The Pulumi stack to verify." },
          { name: "--infra-dir", value: "<path>", desc: "The Pulumi program directory." },
          { name: "--kubeconfig", value: "<path>", desc: "Also assert no public Service bypasses the edge." },
          { name: "--skip-idempotency", desc: "Skip the `pulumi preview --expect-no-changes` leg." },
        ],
      },
      {
        name: "publish",
        summary: "publish a TEMPORARY test URL for one in-cluster Service",
        examples: ["hg edge publish --app nexus --email ops@example.com", "hg edge unpublish --all"],
        desc:
          "Gated by a Zero Trust Access app admitting only `--email`; the connector runs in namespace `hg-edge-test` " +
          "(plain kubectl, no Helm). Prints the `https://` URL.",
        flags: [
          { name: "--app", value: "<match>", desc: "The in-cluster app to expose." },
          { name: "--email", value: "<a>[,b]", desc: "Who the Access policy admits." },
          { name: "--hostname", value: "<label>", desc: "Hostname label under the zone." },
          { name: "--zone", value: "<name>", desc: "The Cloudflare zone." },
          { name: "--service", value: "<ns>/<name>:<port>", desc: "Expose a Service directly instead of matching an app." },
        ],
      },
      {
        name: "unpublish",
        summary: "tear a published test URL down as one unit: DNS, Access app+policy, tunnel, connector",
        flags: [
          { name: "--hostname", value: "<label>", desc: "Which published URL to tear down." },
          { name: "--all", desc: "Tear down every published test URL." },
        ],
      },
      { name: "list", summary: "the currently published test URLs" },
    ],
  },
  {
    name: "envfile",
    loops: ["ops"],
    summary: "profile environment files: list, use, set, unset (values never print)",
    subs: [
      { name: "list", summary: "sources + names (values never print)", flags: [PROFILE] },
      { name: "use", args: "<path/.env>", summary: "pin the env file for every profile" },
      { name: "set", args: "K=V [K=V ...]", summary: "set variables", flags: [PROFILE, { name: "--restart", desc: "Restart the profile so the change takes effect now." }] },
      { name: "unset", args: "K [K ...]", summary: "remove variables", flags: [PROFILE, { name: "--restart", desc: "Restart the profile so the change takes effect now." }] },
    ],
  },

  {
    name: "env",
    loops: ["ops"],
    summary: "the environment spec \u2192 generated Pulumi stack config",
    desc:
      "One environment.yaml (infra/environments/<name>.yaml, schema cli/schemas/environment/v1alpha1) is the " +
      "source of truth for BOTH Pulumi stacks; the Pulumi.<name>.yaml files are generated projections with a " +
      "do-not-edit banner. Secret values never live in the spec - {secret: true} leaves mark values that exist " +
      "only as pulumi-encrypted ciphertext in the generated file, carried through regeneration untouched.",
    json: true,
    subs: [
      {
        name: "new",
        frontDoor: true,
        summary: "day-0 from the root-of-trust coordinates: stacks init'd, config generated, pulumi up, hand-off (#676)",
        examples: ["hg env new scratch --dry-run", "hg env new scratch"],
        flags: [
          { name: "--spec", value: "<file>", desc: "Spec path override (default infra/environments/<name>.yaml)." },
          { name: "--dry-run", desc: "Print the exact command sequence (env prefixes included, hand-executable); apply nothing." },
        ],
      },
      {
        name: "plan",
        summary: "diff the spec against the generated stack config - exit 1 on drift (the doctor finding)",
        examples: ["hg env plan factory"],
        flags: [{ name: "--spec", value: "<file>", desc: "Spec path override (default infra/environments/<name>.yaml)." }],
      },
      {
        name: "apply",
        summary: "regenerate both stack config files from the spec",
        flags: [{ name: "--spec", value: "<file>", desc: "Spec path override." }],
      },
      {
        name: "import",
        summary: "one-shot: existing hand-written stack config -> environment.yaml (the migration path)",
        examples: ["hg env import factory"],
        flags: [
          { name: "--state", value: "<file>", desc: "State stack config (default state/Pulumi.<name>.yaml)." },
          { name: "--infra", value: "<file>", desc: "Infra stack config (default infra/Pulumi.<name>.yaml)." },
          { name: "--out", value: "<file>", desc: "Where to write the spec (default infra/environments/<name>.yaml)." },
        ],
      },
    ],
  },
  {
    name: "agent",
    loops: ["ops", "dev"],
    summary: "what the platform resolved for an agent, and what the running one reports",
    desc:
      "Engine-neutral: every sub dispatches on the profile's runtime. `inspect` and " +
      "`render` are OFFLINE and need no cluster — they read the same value documents the " +
      "ApplicationSet layers onto the chart and build the agent runtime manifest from them, so " +
      "they are safe in CI and `render` is byte-identical run twice. `show` adds what only the " +
      "running pod knows.",
    json: true,
    see: ["../contracts/agent-runtime.md", "../../platform/runtime-eve.md"],
    subs: [
      { name: "show", summary: "as CONFIGURED in the pod — Hermes: model/skills/plugins/MCP/cron; Eve: model/channels/subagents/schedules/tools", flags: [PROFILE] },
      {
        name: "inspect",
        summary: "OFFLINE: the resolved runtime manifest — engine, source revision, workspaces, required secret NAMES, connections",
        flags: [PROFILE, { name: "--gitops", value: "<clone>", desc: "Read the overlay from a GitOps checkout instead of the local staging tree." }],
      },
      {
        name: "render",
        args: "--output <dir>",
        summary: "OFFLINE: write the record and the runtime manifest for one profile — deterministic, CI-safe",
        flags: [
          PROFILE,
          { name: "--output", value: "<dir>", desc: "Directory to write profile.yaml + runtime-manifest.json into (created if absent)." },
          { name: "--gitops", value: "<clone>", desc: "Read the overlay from a GitOps checkout instead of the local staging tree." },
        ],
      },
      { name: "apply", summary: "activate declared cron — the same `hermes cron sync` the chart's boot script runs (Hermes only)", flags: [PROFILE, { name: "--dry-run", desc: "Print what would change without applying." }] },
      { name: "exec", args: "-- <args...>", summary: "DEBUG ESCAPE HATCH: `hermes` in the pod (Hermes) or `eve` in the project dir (Eve)", flags: [PROFILE] },
      {
        name: "prove",
        summary: "the agent-runtime acceptance matrix, per harness",
        desc:
          "Partitions the selection by harness and runs each harness's own matrix — one merged ProofResult. " +
          "Eve: EVE001..011 platform legs (health, Workflow callback route, Basic challenge, an " +
          "authenticated real turn (`unknown` on a dev-placeholder credential), byte-identical record render) " +
          "plus the documented eve channel contract; EVE012..020 behaviours around the routes " +
          "(cancel on the stream, --deep durability across a pod restart, compaction, schedules firing " +
          "in-process, subagents + a delegation eval, the backup ledger and a --deep restore round-trip, " +
          "workspace bindings at the resolved sha, child Applications Synced+Healthy); EVE021 the Discord " +
          "interactions route refuses unsigned and forged requests; EVE022..023 the mounted runtime " +
          "manifest equals the offline resolve and `hg agent show` answers; EVE024 exactly ONE live " +
          "Gateway session. Hermes: HRM001 the running pod answers `agent show` with a coherent snapshot and " +
          "every declared cron job is activated; HRM002 the smoke tier passes — deliberately shallow, deep " +
          "Hermes acceptance stays `hg test`. A leg whose precondition is absent reports `unknown`, never a " +
          "pass. `hg launch prove` aggregates this subject whenever any agent is onboarded.",
        flags: [
          PROFILE,
          { name: "--deep", desc: "Also run EVE013 (pod restart) and EVE018 (backup/restore round-trip) - minutes, and the pod rolls." },
        ],
      },
      {
        name: "evals",
        args: "[<eval-id>...]",
        summary: "run an Eve agent's OWN eve evals (evals/ beside agent/) against its deployment",
        desc:
          "Runs `eve eval --url` from inside the agent's pod, against the served process, with the platform's " +
          "minted credential - eve's own acceptance mechanism (docs/evals), needing no local toolchain. " +
          "Positional ids select evals by id or directory prefix. Exit code is eve's: 0 every gate passed, " +
          "1 a failure, 2 a configuration error. Refuses on a Hermes selection - the frozen legacy harness " +
          "has no such mechanism; its behaviour suite is `hg eval`.",
        flags: [
          PROFILE,
          { name: "--strict", desc: "Soft below-threshold assertions also fail (eve eval --strict)." },
        ],
      },
    ],
  },
  {
    name: "expose",
    loops: ["dev"],
    summary: "refresh or stop the auto-started local URLs",
    subs: [{ name: "", summary: "refresh the local exposures", flags: [{ name: "--stop", desc: "Stop them instead." }] }],
  },
  {
    name: "down",
    loops: ["dev"],
    summary: "stop every host-side process (cluster untouched)",
    subs: [{ name: "", summary: "stop host-side processes" }],
  },
  {
    name: "open",
    loops: ["dev"],
    summary: "every profile's console/service URLs",
    json: true,
    subs: [{ name: "", summary: "print the URLs", flags: [PROFILE] }],
  },
  {
    name: "reset",
    loops: ["dev"],
    summary: "tear the local environment down",
    subs: [
      {
        name: "",
        summary: "reset local state",
        flags: [
          { name: "--nuclear", desc: "Also delete the cluster and every artifact." },
          { name: "--allow-repo-scripts", desc: "Permit repo-provided teardown scripts to execute." },
        ],
      },
    ],
  },
  {
    name: "status",
    loops: ["dev"],
    summary: "the local environment's state: profiles, ports, exposures",
    json: true,
    subs: [{ name: "", summary: "print the state" }],
  },
  {
    name: "connection",
    loops: ["ops"],
    see: ["../contracts/environment-connections.md", "../../platform/inbound-events.md"],
    summary: "third-party app connections: list, plan, set, prove",
    desc:
      "A connection is one third-party app registration (a Discord application, a GitHub App) declared once and " +
      "bound to profiles. Its keys live in ONE platform Secret (hermes-secrets/connection-<name>), " +
      "projected into every bound profile's namespace and mounted by the event router, whose gateway verifies " +
      "the provider's signature on /v1/connect/<provider>/<name> and forwards verbatim to the bound agent. " +
      "Values never print - `list` shows which keys are SET, by name.",
    json: true,
    subs: [
      { name: "list", summary: "every declared connection: provider, which keys are set, bindings and routes" },
      { name: "plan", summary: "the compiled bindings and the compiler's findings (CONN001..)" },
      {
        name: "set",
        args: "<connection> KEY=value|KEY=@file ...",
        summary: "set a connection's keys locally ($HG_HOME/connections/<name>.json, 0600) and re-apply its platform Secret",
        desc:
          "`KEY=@path` reads the value from a FILE — the only sound way to supply a GitHub App's " +
          "multi-line PEM, and the right way to supply any credential: a value on a command line " +
          "is readable by every process on the host through /proc and lands in the shell history.",
        examples: [
          "hg connection set company-discord DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_PUBLIC_KEY=...",
          "hg connection set platform-github GITHUB_APP_PRIVATE_KEY=@~/Downloads/my-app.private-key.pem",
        ],
      },
      {
        name: "prove",
        summary: "CONN001 compile clean; CONN002 platform Secret + every projection carry the provider's key set; CONN003 the gateway refuses unsigned and forged requests (GitHub: and answers a correctly signed ping); CONN004 a signed event for a bound repository forwards to the routed profile",
      },
    ],
  },
  {
    name: "workspace",
    loops: ["ops", "agent-bundle"],
    see: ["../contracts/environment-workspaces.md"],
    summary: "repository mounts: plan, list, verify, doctor, test",
    json: true,
    subs: [
      { name: "plan", summary: "bindings as normalized records with resolved revisions + per-profile shape/classification" },
      { name: "list", summary: "the bindings, listed" },
      {
        name: "verify",
        summary: "desired vs OBSERVED: mounts, revisions, read-only, markers, credentials, absence for unbound profiles",
        examples: ["hg workspace plan", "hg workspace verify --profile research"],
        flags: [
          PROFILE,
          { name: "--repository", value: "<r>", desc: "Narrow to one repository binding." },
          { name: "--gitops", value: "<clone>", desc: "The GitOps clone to verify against." },
          { name: "--record", desc: "Write the verification record." },
        ],
      },
      { name: "doctor", summary: "generated records reproduce from the declaration", flags: [DIR_REPO, { name: "--deep", desc: "Add the runtime probes." }] },
      { name: "test", summary: "the reference scenarios (the workspace-bindings tier)", flags: [{ name: "--scenario", value: "business-context|sre-operation-source", desc: "Which reference scenario." }] },
    ],
  },
  {
    name: "server",
    loops: ["ops"],
    summary: "destination server lifecycle: preflight, bootstrap, register, destroy",
    json: true,
    subs: [
      {
        name: "preflight",
        summary: "SRV00x readiness findings for a destination server",
        flags: [
          { name: "--host", value: "<user@host>", desc: "The server, over SSH." },
          { name: "--home", value: "<sync-root>", default: "/mnt/ssd/hermes-gitops", desc: "The sync-root on the server." },
          { name: "--allow-local-state", desc: "Permit local (non-sink) Pulumi state." },
        ],
      },
      {
        name: "bootstrap",
        summary: "pinned k3s + kubectl/helm/bun (checksummed, from versions.json), sync-root layout, server identity — idempotent",
        flags: [
          { name: "--host", value: "<user@host>", desc: "The server, over SSH." },
          { name: "--home", value: "<sync-root>", desc: "The sync-root on the server." },
        ],
      },
      {
        name: "register",
        summary: "register the environment with its operations channel (idempotent — never duplicates the permanent message)",
        flags: [
          { name: "--channel", value: "<discord-channel-id>", desc: "The operations channel." },
          { name: "--role", value: "<role-id>", desc: "Role mentioned on lifecycle events." },
          { name: "--environment", value: "<name>", desc: "The environment name registered." },
        ],
      },
      {
        name: "destroy",
        summary: "Harness Hg-scoped destruction: timers, k3s, sync-root entries, kubeconfig — NOTHING else",
        desc:
          "Gated on the sink saying the named backup is RESTORABLE (read with the reader identity); refuses without " +
          "`--nuclear`; DSTR001–006 verify the result.",
        flags: [
          { name: "--host", value: "<user@host>", desc: "The server, over SSH." },
          { name: "--backup", value: "<backup-id>", desc: "The backup that must be RESTORABLE before anything is destroyed." },
          { name: "--sink", value: "gs://...", desc: "The sink holding that backup." },
          { name: "--nuclear", desc: "Required. There is no non-nuclear destroy." },
        ],
      },
    ],
  },
  {
    name: "grafana",
    loops: ["ops"],
    summary: "prove the promised Grafana panels exist",
    desc:
      "Reads the panel routes as a real viewer would, and asks Grafana (as admin, deliberately) whether each promised " +
      "panel EXISTS — a question about the dashboard, not about what any particular human may see. The RBAC half is " +
      "`hg auth prove`.",
    json: true,
    subs: [{ name: "prove", summary: "panel-existence proof against the local exposure" }],
  },
  {
    name: "auth",
    loops: ["ops"],
    summary: "prove sign-in and RBAC on the control plane",
    json: true,
    subs: [{ name: "prove", summary: "the auth acceptance matrix", flags: [CONTROL_PLANE] }],
  },
  {
    name: "slack",
    loops: ["ops"],
    summary: "prove the provisioned Slack surface: apps, secrets, channels, events edge",
    desc:
      "Provisioning itself is Pulumi's: the SlackWorkspace provision Command creates each app through " +
      "the raw manifest API and captures the signing secret + bot token into encrypted state — nothing is pasted. " +
      "This matrix asks whether the result HOLDS: SLK001 each app's pod Secret carries both SLACK_* keys; SLK002 " +
      "each app answers auth.test as the bot in the declared workspace; SLK003 each bot is a member of every " +
      "pinned channel that names it; SLK004 each events endpoint refuses an unsigned POST with 401 (the no-Access " +
      "edge is up and eve verifies signatures). A leg that cannot run reports unknown, never a pass.",
    json: true,
    subs: [
      {
        name: "prove",
        args: "<environment>",
        summary: "the Slack acceptance matrix against an environment spec",
        examples: ["hg slack prove factory", "hg slack prove factory --agent marketing-manager-eve"],
        flags: [
          { name: "--agent", value: "<name>", desc: "Restrict the matrix to one app." },
          { name: "--spec", value: "<file>", desc: "Spec path override (default infra/environments/<env>.yaml)." },
        ],
      },
    ],
  },
  {
    name: "harness",
    loops: ["ops"],
    summary: "the declared harnesses",
    desc:
      "The registry the platform deploys agents through: every runtime driver carries a " +
      "schema-validated declaration. `list` reads them from the platform checkout - name, status " +
      "(active | frozen-legacy), gateway kind.",
    json: true,
    subs: [{ name: "list", summary: "name, status and gateway kind of every declared harness" }],
  },
  {
    name: "bundle",
    loops: ["agent-bundle"],
    summary: "front door: scaffold a new Agent Team Repo",
    desc:
      "The agent-bundle loop's entry. `init` scaffolds an agent-team repo in the `harness-hg/` tree - the team's " +
      "`harness-hg/{team,destination,workspaces}.yaml` and one Eve agent per `--agents` entry under " +
      "`agents/eve/<name>/{harness-hg,src}` (Hermes is frozen legacy and is refused with the copy-from-examples " +
      "path) - writes only what it can fill honestly (an absent `harness-hg/*.yaml` is a feature that is off, " +
      "listed in the README), proves the scaffold passes `hg validate --dir` on its own output, and prints the " +
      "loop. Unrelated to profile bundles (harness-hg/bundles.yaml - many profiles, one pod).",
    json: true,
    subs: [
      {
        name: "init",
        args: "<dir>",
        frontDoor: true,
        summary: "scaffold a new agent-bundle repo and prove it validates",
        examples: [
          "hg bundle init ../my-team --agents eve:manager,eve:research --gitops https://github.com/org/my-team.gitops.git",
          "hg bundle init ../solo --agent solo",
        ],
        flags: [
          { name: "--agents", value: "<list>", desc: "The agents to scaffold, `<harness>:<name>` comma-separated (`eve:manager,eve:research`; a bare name is Eve). Hermes is refused." },
          { name: "--agent", value: "<name>", desc: "One Eve agent by name (DNS-1123, ≤40; default: the team name, the directory basename minus `.harness-hg`). Alternative to --agents." },
          { name: "--gitops", value: "<url>", desc: "The GitOps destination repo written into harness-hg/destination.yaml." },
          { name: "--dry-run", desc: "Print the steps; write nothing." },
        ],
      },
    ],
  },
  {
    name: "identity",
    loops: ["dev"],
    summary: "the local identity provider's issuer, clients and users",
    desc:
      "Re-establishes the port-forward before reporting — it dies with every pod roll, and a status command that " +
      "reports a dead issuer as configured is the same lie every other surface here refuses. Secrets live in " +
      "`~/.hermes-gitops/identity-secrets.json` (0600) and are never printed.",
    json: true,
    subs: [{ name: "", summary: "issuer, clients, users" }],
  },
  {
    name: "help",
    loops: ["all"],
    summary: "full flags and subcommands for one command",
    desc: "`hg help <command>` and `hg <command> --help` print the same thing. `hg help` prints the command list.",
    subs: [{ name: "", args: "[<command>]", summary: "print detailed help" }],
  },
];

// ---------------------------------------------------------------------------
// Renderers. main.ts prints these; the doc generator renders its own pages
// from the JSON dump below and never calls them.
// ---------------------------------------------------------------------------

/** One line per command: name + subcommand shape + summary. */
export function renderUsage(): string {
  const lines: string[] = ["hermes-gitops (hg) - the operator CLI, organized by journey", ""];
  // The three loop front doors lead (#673): one command per journey that
  // orchestrates the rest, so nobody has to already know the order.
  const doors: string[] = [];
  for (const c of COMMANDS) {
    for (const sub of c.subs) {
      if (sub.frontDoor) {
        const cmd = ["hg", c.name, sub.name].filter(Boolean).join(" ");
        doors.push(`  ${cmd.padEnd(20)}${c.loops[0]}: ${sub.summary}`);
      }
    }
  }
  if (doors.length > 0) {
    lines.push("Start here - one front door per loop:", ...doors, "");
  }
  const left = (c: Command): string => {
    const subNames = c.subs.map((s) => s.name).filter(Boolean);
    const shape = subNames.length > 0 ? ` ${subNames.join("|")}` : c.subs[0]?.args ? ` ${c.subs[0].args}` : "";
    return `  hg ${c.name}${shape}`;
  };
  // Fixed summary column; a longer left side wraps its summary onto the
  // next line instead of pushing every row's summary to the right margin.
  const width = 46;
  const row = (c: Command): void => {
    const l = left(c);
    if (l.length + 2 <= width) {
      lines.push(l.padEnd(width) + c.summary);
    } else {
      lines.push(l, " ".repeat(width) + c.summary);
    }
  };
  // The three journeys first: a command appears under its
  // FIRST loop; harness-legacy and meta close the list.
  const JOURNEYS: [Loop, string][] = [
    ["dev", "dev - iterate on the platform locally"],
    ["ops", "ops - run your own environment"],
    ["agent-bundle", "agent-bundle - configure an external repo against the contract"],
    ["harness-legacy", "legacy harness (Hermes)"],
    ["all", "meta"],
  ];
  for (const [loop, title] of JOURNEYS) {
    const members = COMMANDS.filter((c) => c.loops[0] === loop);
    if (members.length === 0) continue;
    lines.push(`${title}:`);
    for (const c of members) row(c);
    lines.push("");
  }
  lines.push(
    "  hg help <command> (or hg <command> --help) prints one command's full",
    "  flags and subcommands. A command may serve more than one journey; it",
    "  is listed under its primary one.",
    "",
    "--json prints ONE JSON document on stdout (narration goes to stderr) for",
    "programmatic use; see the hermes-dev Claude Code plugin.",
  );
  return lines.join("\n");
}

/** Full detail for one command: every sub, every flag, defaults. */
export function renderCommandHelp(name: string): string {
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) {
    throw new Error(`unknown command ${JSON.stringify(name)} - run \`hg help\` for the list`);
  }
  const lines: string[] = [`hg ${c.name} - ${c.summary}`];
  if (c.desc) lines.push("", c.desc);
  for (const s of c.subs) {
    const head = ["hg", c.name, s.name, s.args].filter(Boolean).join(" ");
    lines.push("", `  ${head}`, `      ${s.summary}`);
    for (const f of s.flags ?? []) {
      const spec = f.value ? `${f.name} ${f.value}` : f.name;
      const dflt = f.default ? ` (default: ${f.default})` : "";
      const padded = spec.length >= 34 ? `${spec}  ` : spec.padEnd(34);
      lines.push(`      ${padded}${f.desc}${dflt}`);
    }
  }
  if (c.json) lines.push("", "  --json prints ONE JSON document on stdout (narration goes to stderr).");
  return lines.join("\n");
}

if (import.meta.main) console.log(JSON.stringify(COMMANDS));
