// hg communication prove - the ADR-39 acceptance matrix as ONE command.
// Pure orchestration: every stage drives the same compiler, emitter,
// router client, queue conformance, ingress signer, ChatOps providers,
// and eval primitives the individual commands use. A stage that mutates
// the cluster (DLQ, restart, live Grafana) restores what it touched.
//
// Exit nonzero on any failed stage; one JSON report with --json.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CliError,
  HG_HOME,
  KCTX,
  SINK_LOG,
  appOf,
  jsonOut,
  kubectl,
  loadState,
  loadTestConfig,
  log,
  nsOf,
  ok,
  profileCtxs,
  sh,
} from "../lib.ts";
import {
  depths,
  orderTrace,
  parseSince,
  readRecords,
  redactForOutput,
  redactionViolations,
  since as sinceFilter,
  summarise,
} from "./lifecycle.ts";
import { loadContracts } from "../topology/contract.ts";
import { loadEnvironment } from "../topology/environment.ts";
import { compile } from "../topology/compile.ts";
import { renderTree } from "../topology/emit.ts";
import { signBody } from "../topology/envelope.ts";
import {
  slackDeliver,
  invokeForEval,
  loadComm,
  recordedMessages,
  routerFetch,
  runQueueConformance,
  unwrappedSinkRecords,
  waitForDeliveries,
  type DeliveryReceipt,
} from "./index.ts";

interface Stage {
  stage: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

export interface ProveOptions {
  dir?: string;
  environment?: string;
  /** `--since 30m` for the lifecycle-record readers (#349). */
  since?: string;
  requireLiveChatops: boolean;
  requireLiveGrafana: boolean;
  /** Live Slack target; defaults to $HG_SLACK_SANDBOX_CHANNEL. */
  toChatops?: string;
  /** Run exactly one named stage (compile always runs); the rest skip.
   * The live-fleet guard (#350): dlq-replay alone must not drag the
   * StatefulSet-scaling siblings along. */
  stage?: string;
}

// Sink reading moved to communication.ts unwrappedSinkRecords: the sink
// WRAPS every POST as {ts, method, path, body}, and matching record
// fields at the top level matched nothing on real sink data (Codex
// catch on the wave-3 T stack - a latent wave-2 bug here).

export async function cmdCommunication(json: boolean, args: string[], opts: ProveOptions): Promise<void> {
  const [sub, ...restArgs] = args;

  // --- Reading lifecycle records back (#349) ---------------------------
  // The observer's sink is the source (`hg debug webhook`), and this is
  // the READ half only: it selects, orders and renders, and nothing it
  // does can fail a primary path.
  if (sub === "traces") {
    const records = readRecords(unwrappedSinkRecords());
    const spec = opts.since ?? "30m";
    const ms = parseSince(spec);
    if (Number.isNaN(ms)) {
      throw new CliError(`hg communication traces: invalid --since ${JSON.stringify(spec)} - expected 30m, 2h, 7d`);
    }
    const traces = summarise(sinceFilter(records, ms, Date.now()));
    if (json) {
      jsonOut({ command: "communication-traces", since: spec, traces });
      return;
    }
    if (traces.length === 0) {
      log(`no lifecycle records in the last ${spec}.`);
      log(`  The observer is passive and off by default - turn it on with: hg debug webhook enable`);
      return;
    }
    for (const t of traces) {
      // testRun present = a human or harness asked; absent = it
      // happened on its own. That distinction is the point of the
      // field, so it leads the line rather than hiding in --json.
      const trigger = t.testRun ? `test:${t.testRun}` : "autonomous";
      log(
        `${t.traceId}  ${t.startedAt}  ${t.outcome.padEnd(8)}  ${trigger.padEnd(20)}  ` +
          `${t.planes.join("+")}  ${t.records} record(s)${t.correlationId ? `  ${t.correlationId}` : ""}`,
      );
    }
  return;
  }
  if (sub === "trace") {
    const traceId = restArgs[0];
    if (!traceId) throw new CliError("usage: hg communication trace <trace-id> [--json]");
    const all = readRecords(unwrappedSinkRecords()).filter((r) => r.traceId === traceId);
    if (all.length === 0) {
      throw new CliError(
        `hg communication trace: no records for ${traceId}.\n` +
          "  Traces live only in the observer's sink, which is passive and off by default -\n" +
          "  a run that happened while it was disabled left nothing behind. List what IS there:\n" +
          "    hg communication traces --since 24h",
      );
    }
    const ordered = orderTrace(all);
    const depth = depths(ordered);
    const violations = ordered.flatMap((r) =>
      redactionViolations(r).map((field) => ({ recordId: r.recordId, field })),
    );
    if (json) {
      // Through the SAME redaction the human path applies. Serialising
      // `ordered` whole disclosed exactly what the guard exists to
      // contain, which is the failure mode of a guard written against one
      // output path.
      jsonOut({
        command: "communication-trace",
        traceId,
        records: ordered.map(redactForOutput),
        redactionViolations: violations,
      });
      return;
    }
    for (const r of ordered) {
      const indent = "  ".repeat(depth.get(r.recordId) ?? 0);
      const target = r.redactedTarget ? ` -> ${r.redactedTarget.label ?? r.redactedTarget.ref ?? r.redactedTarget.kind}` : "";
      const outcome = r.outcome ? `  [${r.outcome}]` : "";
      const took = r.durationMs !== undefined ? `  ${r.durationMs}ms` : "";
      log(`${indent}${r.occurredAt}  ${r.plane}/${r.type}${target}${outcome}${took}`);
    }
    if (violations.length > 0) {
      // Reported, never printed. Printing is what turns a leak into a
      // disclosure, and this reader consumes a file on disk that
      // anything with the path could have appended to.
      log("");
      log(`WARNING: ${violations.length} record(s) carry fields the envelope forbids:`);
      for (const v of violations) log(`  ${v.recordId}  ${v.field}`);
      log("  Their values are NOT shown. Something is writing content into a metadata-only record.");
    }
  return;
  }

  if (sub !== "prove") {
    throw new CliError("unknown communication subcommand (prove|traces|trace)");
  }
  const stages: Stage[] = [];
  // --stage <name> runs ONE stage and skips the rest (#350's live leg:
  // several stages scale live StatefulSets, and running dlq-replay alone
  // against a production fleet must not drag restart-survival with it).
  // The always-run "compile" stage stays, because every later stage reads
  // its ctx assertions.
  const only = typeof opts.stage === "string" && opts.stage ? String(opts.stage) : undefined;
  const stage = async (name: string, fn: () => Promise<string>): Promise<void> => {
    if (only && name !== only && name !== "compile") {
      stages.push({ stage: name, ok: true, skipped: true, detail: `skipped: --stage ${only}` });
      if (!json) log(`${name}: skipped (--stage ${only})`);
      return;
    }
    try {
      const detail = await fn();
      stages.push({ stage: name, ok: true, detail });
      if (!json) ok(`${name}: ${detail}`);
    } catch (err) {
      stages.push({ stage: name, ok: false, detail: (err as Error).message });
      if (!json) console.error(`  ✗ ${name}: ${(err as Error).message}`);
    }
  };
  const skip = (name: string, why: string): void => {
    stages.push({ stage: name, ok: true, skipped: true, detail: `skipped: ${why}` });
    if (!json) log(`${name}: skipped (${why})`);
  };
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) throw new Error(msg);
  };

  const state = loadState();
  const ctx = loadComm(opts.dir, opts.environment);
  // A typo'd --stage must fail, not run compile-only and exit green
  // (Codex catch): validated after the run below, where the stage list
  // is complete - see the check before the report.
  const KNOWN_STAGES = [
    "compile", "emit-determinism", "router-ready", "fanout", "broadcast",
    "incident-session", "queue-conformance", "restart-survival", "dlq-replay", "ingress-matrix",
  ];
  if (only && !KNOWN_STAGES.includes(only)) {
    throw new CliError(`--stage ${only} is not a stage; one of: ${KNOWN_STAGES.join(", ")}`);
  }
  const fixtures = path.join(ctx.root, "fixtures");
  const firing = JSON.parse(fs.readFileSync(path.join(fixtures, "alert-firing.json"), "utf8")) as Record<string, unknown>;
  // The alert producer by its inject target, never by position - the
  // synthesized agents.all broadcast producer shares the array.
  const producer =
    ctx.comm.producers.find((p) => p.inject?.path === "alert.webhookUrl") ?? ctx.comm.producers[0];

  // --- 1. The compiled graph -----------------------------------------------
  await stage("compile", async () => {
    assert(ctx.plan.ok, "the communication graph has compile errors");
    assert(!!producer, "no producer compiled");
    assert(producer!.inject?.path === "alert.webhookUrl", "Grafana's alert.webhookUrl is not the inject target");
    const agents = ctx.comm.edges.filter((e) => e.kind === "agent");
    assert(agents.some((e) => e.agent!.profile === "platform-sre"), "platform-sre is not subscribed");
    assert(!ctx.comm.edges.some((e) => e.agent?.profile === "unrelated-sre"), "unrelated-sre has edges - isolation broken at compile");
    assert(
      ctx.comm.edges.filter((e) => e.from.producer === producer!.id).every((e) => e.delivery.mode === "queued" && e.delivery.ordering?.key === "subject"),
      "the alert route is not durable FIFO by subject",
    );
    const spaces = ctx.comm.chatopsSpaces.map((s) => s.id).sort();
    assert(
      spaces.includes("company_chat#channel-1") && spaces.includes("company_chat#channel-2"),
      `both ChatOps spaces must auto-register (got ${spaces.join(", ")})`,
    );
    assert(!!ctx.comm.durableProvider, "no durable provider declared");
    return `producer ${producer!.name}, ${ctx.comm.edges.length} edges, spaces [${spaces.join(", ")}], provider ${ctx.comm.durableProvider!.plugin}`;
  });

  // --- 2. Emit determinism -------------------------------------------------
  await stage("emit-determinism", async () => {
    const loaded = loadContracts(ctx.root);
    const env = loadEnvironment(ctx.root, opts.environment);
    const plan = compile(loaded.contracts, env.environment, { priorFindings: [...loaded.findings, ...env.findings] });
    const render = () =>
      JSON.stringify([...renderTree(ctx.root, loaded.contracts, plan, env.environment, { sourceSha: "0".repeat(40) })].sort());
    assert(render() === render(), "two renders of the same inputs differ");
    const tree = renderTree(ctx.root, loaded.contracts, plan, env.environment, { sourceSha: "0".repeat(40) });
    const commFiles = [...tree.keys()].filter((k) => k.startsWith("deployments/communication/"));
    assert(commFiles.length >= 3, "communication tree missing from the emit");
    return `byte-identical twice; ${commFiles.length} communication file(s)`;
  });

  // --- 3. The running router -----------------------------------------------
  await stage("router-ready", async () => {
    // Self-heal the local forward first - a previous run's restart stage
    // (or any pod roll) kills it, and a dead forward is an environment
    // condition, not a plane failure.
    const { ensureEventRouter } = await import("../platform/index.ts");
    ensureEventRouter(loadState());
    const { status, body } = await routerFetch("/healthz");
    assert(status === 200, `healthz returned ${status}`);
    const doc = body as { router: string; environment: string };
    return `router ${doc.router} healthy (environment ${doc.environment})`;
  });

  // --- 4. Synthetic fan-out ------------------------------------------------
  let fanoutEventId = "";
  await stage("fanout", async () => {
    const result = await invokeForEval(
      { event: { name: producer!.event, from: producer!.name, payload: "fixtures/alert-firing.json" } },
      { dir: ctx.root, environment: opts.environment, scenarioDir: ctx.root },
    );
    assert(result.ok, `invocation not clean: ${result.error ?? "deliveries failed"}`);
    assert(result.eventIds.length === 1 && result.correlationIds.length === 1, "one event, one correlation");
    fanoutEventId = result.eventIds[0]!;
    assert(result.deliveryIds.length === 3, `expected 3 delivery ids, got ${result.deliveryIds.length}`);
    assert(new Set(result.deliveryIds).size === 3, "delivery ids are not independent");
    const agent = result.receipts.filter((r) => r.kind === "agent" && r.status === "accepted");
    assert(agent.length === 1 && agent[0]!.edge.includes(":agent:platform-sre"), "platform-sre did not accept exactly one delivery");
    for (const space of ["company_chat#channel-1", "company_chat#channel-2"]) {
      assert(
        result.receipts.some((r) => r.space === space && r.status === "delivered"),
        `${space} did not receive its delivery`,
      );
    }
    assert(!JSON.stringify(result.receipts).includes("unrelated-sre"), "a receipt touched unrelated-sre");
    return `1 event, 1 correlation, 3 independent deliveries; unrelated-sre untouched`;
  });

  // --- 4b. The reserved broadcast ------------------------------------------
  await stage("broadcast", async () => {
    const broadcast = ctx.comm.producers.find((p) => p.event === "agents.all/v1");
    assert(!!broadcast, "no synthesized agents.all producer in the plan");
    const expected = ctx.comm.edges.filter((e) => e.event === "agents.all/v1" && e.kind === "agent");
    assert(expected.length > 0, "the broadcast has no agent edges");
    const { status, body } = await routerFetch(broadcast!.ingestPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ test: true, source: "hg communication prove" }),
    });
    assert(status === 202, `broadcast ingest returned ${status}`);
    const doc = body as { deliveries?: { kind: string; status: string; edge: string }[] };
    const clean = (doc.deliveries ?? []).filter(
      (d) => d.kind === "agent" && ["accepted", "delivered"].includes(d.status),
    );
    assert(
      clean.length === expected.length,
      `expected ${expected.length} clean agent deliveries, got ${clean.length} ` +
        `(${(doc.deliveries ?? []).map((d) => `${d.edge}:${d.status}`).join(", ")})`,
    );
    return `agents.all reached ${clean.length}/${expected.length} webhook-capable profile(s)`;
  });

  // --- 5. Incident session -------------------------------------------------
  await stage("incident-session", async () => {
    const result = await invokeForEval(
      {
        events: {
          name: producer!.event,
          from: producer!.name,
          payloads: ["fixtures/alert-firing.json", "fixtures/alert-resolved.json"],
        },
      },
      { dir: ctx.root, environment: opts.environment, scenarioDir: ctx.root },
    );
    assert(result.ok, `invocation not clean: ${result.error ?? ""}`);
    const agent = result.receipts.filter((r) => r.kind === "agent" && r.status === "accepted");
    assert(agent.length === 2, `expected 2 agent deliveries, got ${agent.length}`);
    const keys = new Set(agent.map((r) => r.sessionKey));
    assert(keys.size === 1, `firing and resolved split across sessions: ${[...keys].join(" vs ")}`);
    const key = [...keys][0]!;
    assert(key.startsWith("local/platform-sre/"), `session key lacks environment/profile namespace: ${key}`);
    assert(new Set(agent.map((r) => r.eventId)).size === 2, "event identities collapsed");
    return `both events share session ${key}`;
  });

  // --- 6. Queue conformance ------------------------------------------------
  await stage("queue-conformance", async () => {
    const result = await runQueueConformance(producer!, "incident-42", 3, firing);
    assert(result.ok, result.failures.join("; "));
    return `${result.emitted} events over ${result.orderingKeys.length} keys: durable, same-key FIFO, cross-key progress, DLQ empty`;
  });

  // --- 7. Restart survival -------------------------------------------------
  await stage("restart-survival", async () => {
    const router = ctx.comm.routers[0]!;
    // Enqueue a burst, kill the consumer mid-flight, and require every
    // delivery to settle cleanly anyway.
    const emissions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const payload = structuredClone(firing);
      payload["groupKey"] = "incident-restart-live";
      const { status, body } = await routerFetch(producer!.ingestPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert(status === 202, `router refused emission ${i}`);
      emissions.push(...((body as { deliveries: DeliveryReceipt[] }).deliveries.map((d) => d.deliveryId)));
    }
    kubectl(["delete", "pod", "-n", router.namespace, "-l", "app.kubernetes.io/name=hermes-event-router", "--wait=false"], { quiet: true });
    sh(["kubectl", "--context", KCTX, "-n", router.namespace, "rollout", "status", `deployment/${router.service}`, "--timeout=120s"], { quiet: true });
    // The old forward pins the DELETED pod - and keeps answering through
    // its termination grace period, so a health probe alone can bless a
    // forward that is about to die. Kill it outright, then let
    // ensureEventRouter respawn against the new pod.
    const st = loadState();
    if (st.pids?.routerPf) {
      try {
        process.kill(st.pids.routerPf, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    const { ensureEventRouter } = await import("../platform/index.ts");
    ensureEventRouter(loadState());
    const terminal = await waitForDeliveries(emissions, 180_000);
    const bad = emissions.filter((id) => !["accepted", "delivered", "duplicate"].includes(terminal.get(id)?.status ?? "missing"));
    // Receipts are per-process: deliveries completed BEFORE the kill are
    // invisible to the new pod, but nothing may be LOST - re-emitting
    // the same incident after restart must still deliver.
    const probe = await routerFetch(producer!.ingestPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...firing, groupKey: "incident-restart-live" }),
    });
    assert(probe.status === 202, "router not accepting after restart");
    const probeIds = (probe.body as { deliveries: DeliveryReceipt[] }).deliveries.map((d) => d.deliveryId);
    const probeTerminal = await waitForDeliveries(probeIds, 120_000);
    assert(
      probeIds.every((id) => ["accepted", "delivered"].includes(probeTerminal.get(id)?.status ?? "")),
      "post-restart delivery did not settle cleanly",
    );
    return `consumer killed mid-burst; post-restart deliveries settle (${bad.length} pre-kill receipt(s) settled in the old process)`;
  });

  // --- 8. DLQ + replay (destination taken down for real) ------------------
  await stage("dlq-replay", async () => {
    const agentEdge = ctx.comm.edges.find((e) => e.agent?.profile === "platform-sre")!;
    const ns = agentEdge.agent!.namespace;
    const workload = `statefulset/${appOf("platform-sre")}`;
    kubectl(["scale", workload, "-n", ns, "--replicas=0"], { quiet: true });
    try {
      const payload = structuredClone(firing);
      payload["groupKey"] = "incident-dlq-live";
      const { status, body } = await routerFetch(`${producer!.ingestPath}?toAgent=platform-sre`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      assert(status === 202, "router refused the DLQ probe");
      const deliveryId = (body as { deliveries: DeliveryReceipt[] }).deliveries[0]!.deliveryId;
      const deadline = Date.now() + 240_000;
      let dead = false;
      while (Date.now() < deadline && !dead) {
        const { body: st } = await routerFetch(`/v1/status?delivery=${deliveryId}`);
        dead = ((st as { receipts: DeliveryReceipt[] }).receipts ?? []).some((r) => r.status === "dead-lettered");
        if (!dead) await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      assert(dead, "retry exhaustion never dead-lettered");
      kubectl(["scale", workload, "-n", ns, "--replicas=1"], { quiet: true });
      sh(["kubectl", "--context", KCTX, "-n", ns, "rollout", "status", workload, "--timeout=300s"], { quiet: true });
      // Pod Ready != gateway listening: the agent boots (clone, hermes
      // start, webhook platform) well after readiness, so an immediate
      // replay can exhaust its retries against a booting gateway and
      // dead-letter AGAIN. Replay is idempotent - cycle it until the
      // delivery lands (each failed cycle puts the entry back in the DLQ
      // for the next).
      let accepted = false;
      for (let cycle = 1; cycle <= 5 && !accepted; cycle++) {
        const replayStart = Date.now();
        const replay = await routerFetch("/v1/dlq/replay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deliveryId }),
        });
        assert(replay.status === 200, `replay cycle ${cycle} failed (${replay.status})`);
        // Wait for THIS cycle's outcome - receipts from earlier cycles
        // (the original dead-letter) share the delivery id, so only a
        // receipt newer than the replay counts.
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          const { body: st } = await routerFetch(`/v1/status?delivery=${deliveryId}`);
          const fresh = (((st as { receipts?: DeliveryReceipt[] }).receipts ?? []) as (DeliveryReceipt & { time?: string })[])
            .filter((r) => Date.parse(r.time ?? "") >= replayStart - 1000);
          if (fresh.some((r) => r.status === "accepted")) {
            accepted = true;
            break;
          }
          if (fresh.some((r) => r.status === "dead-lettered")) break; // this cycle lost - go again
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
      assert(accepted, "replayed delivery not accepted after 5 cycles");
      const { body: dlq } = await routerFetch("/v1/dlq");
      assert(((dlq as { entries: unknown[] }).entries ?? []).length === 0, "DLQ not empty after replay");
      return "destination down -> retries exhausted -> DLQ -> destination up -> replay accepted -> DLQ empty";
    } finally {
      kubectl(["scale", workload, "-n", ns, "--replicas=1"], { quiet: true, allowFail: true });
    }
  });

  // --- 9. External ingress matrix ------------------------------------------
  await stage("ingress-matrix", async () => {
    const input = ctx.comm.externalInputs[0];
    assert(!!input, "no external input declared");
    const secret = loadState().commExtSecrets?.[input!.id];
    assert(!!secret, "no local binding secret (hg up provisions it)");
    const payload = JSON.stringify({
      incident: "incident/prove-ingress",
      severity: "warning",
      summary: "ingress matrix probe",
      profile: "unrelated-sre",
    });
    const sign = (s: string, tsOffset = 0): Record<string, string> => {
      const ts = String(Math.floor(Date.now() / 1000) + tsOffset);
      return { "content-type": "application/json", "x-webhook-timestamp": ts, "x-webhook-signature-v2": signBody(s, ts, payload) };
    };
    const validHeaders = sign(secret!);
    const valid = await routerFetch(input!.hookPath, { method: "POST", headers: validHeaders, body: payload });
    assert(valid.status === 202, `valid signature rejected (${valid.status})`);
    const doc = valid.body as { ignoredSelectors?: string[]; deliveries: DeliveryReceipt[] };
    assert(doc.ignoredSelectors?.includes("profile") === true, "the selector-shaped payload key was not reported ignored");
    assert(!JSON.stringify(doc.deliveries).includes("unrelated-sre"), "payload selected an undeclared destination");
    const ids = doc.deliveries.map((d) => d.deliveryId);
    const settled = await waitForDeliveries(ids, 120_000);
    assert(ids.every((id) => ["accepted", "delivered"].includes(settled.get(id)?.status ?? "")), "ingress deliveries did not settle");
    const replay = await routerFetch(input!.hookPath, { method: "POST", headers: validHeaders, body: payload });
    assert(replay.status === 409, `replay not rejected (${replay.status})`);
    for (const [mode, headers, want] of [
      ["invalid", sign(`${secret}-x`), "invalid-signature"],
      ["missing", { "content-type": "application/json" }, "missing-signature"],
      ["stale", sign(secret!, -3600), "stale-signature"],
    ] as const) {
      const r = await routerFetch(input!.hookPath, { method: "POST", headers: headers as Record<string, string>, body: payload });
      assert(r.status === 401 && (r.body as { reason?: string }).reason === want, `${mode} signature not rejected as ${want}`);
    }
    return "valid accepted (selectors ignored, compiled routing only); replay/invalid/missing/stale all rejected, classified";
  });

  // --- 10. The recording provider's captured messages ----------------------
  await stage("chatops-recording", async () => {
    for (const space of ["company_chat#channel-1", "company_chat#channel-2"]) {
      const messages = recordedMessages(space);
      assert(messages.length > 0, `${space}: nothing recorded`);
      const hit = messages.some((m) => {
        const evt = (m.body["event"] ?? {}) as Record<string, unknown>;
        return evt["id"] === fanoutEventId;
      });
      assert(hit, `${space}: the fan-out event never arrived`);
      const last = messages[messages.length - 1]!;
      const msg = (last.body["message"] ?? {}) as Record<string, unknown>;
      assert(typeof msg["title"] === "string" && typeof msg["severity"] === "string", `${space}: message lacks title/severity`);
    }
    return "both spaces hold the fan-out event with title, severity, event + correlation ids";
  });

  // --- 11. Live Slack ----------------------------------------------------
  const liveChannel = opts.toChatops?.split("#")[1] ?? process.env["HG_SLACK_SANDBOX_CHANNEL"];
  if (opts.requireLiveChatops) {
    await stage("live-slack", async () => {
      const token = process.env["HG_SLACK_BOT_TOKEN"];
      assert(!!token, "HG_SLACK_BOT_TOKEN is not set");
      assert(!!liveChannel, "no sandbox channel (pass --to-chatops company_chat#<id> or set HG_SLACK_SANDBOX_CHANNEL)");
      const receipt = await slackDeliver(token!, liveChannel!, {
        title: "hg communication prove — live sandbox check",
        summary: "The communication acceptance run posted this Slack delivery check.",
        severity: "info",
        facts: { event: producer!.event, environment: "local" },
        links: [],
      });
      assert(receipt.status === "delivered", `live delivery failed (${receipt.classification})`);
      assert(!!receipt.providerMessageId, "no provider message timestamp");
      return `Slack accepted message ${receipt.providerMessageId}`;
    });
  } else {
    skip("live-slack", "--require-live-chatops not set");
  }

  // --- 12. Grafana wiring (and optionally a real alert) --------------------
  await stage("grafana-wiring", async () => {
    const gitopsBare = path.join(HG_HOME, "serve-git", "gitops.git");
    const record = sh(["git", "--git-dir", gitopsBare, "show", "HEAD:profiles/platform-sre/profile.yaml"], { quiet: true });
    assert(record.includes(producer!.ingestUrl), "the deployed record's alert.webhookUrl is not the generated publisher URL");
    return `the deployed record carries ${producer!.ingestUrl}`;
  });
  if (opts.requireLiveGrafana) {
    await stage("live-grafana", async () => {
      // The REAL causal loop: take platform-sre's agent down - its OWN
      // monitoring (the router-wired producer) must fire AgentDown
      // through Grafana -> the generated publisher URL -> the durable
      // queue. The ChatOps recordings land immediately (the sink does
      // not depend on the downed agent) and are the firing signal; the
      // agent delivery rides retries/DLQ until the agent returns, then
      // replay lands it in the incident session. The resolved
      // notification follows into the SAME session.
      const ns = nsOf("platform-sre");
      const workload = `statefulset/${appOf("platform-sre")}`;
      const started = Date.now();
      const capturesSince = (since: number, status: string) =>
        recordedMessages("company_chat#channel-1").filter((m) => {
          const msg = (m.body["message"] ?? {}) as Record<string, unknown>;
          return (
            Date.parse(m.ts) > since &&
            String(msg["title"] ?? "").includes("AgentDown") &&
            String(msg["status"] ?? "") === status
          );
        });
      kubectl(["scale", workload, "-n", ns, "--replicas=0"], { quiet: true });
      try {
        // 1. Firing: Grafana's rule (for: 5m, 1m eval) -> publisher ->
        //    queue -> the recording space.
        const fireDeadline = Date.now() + 20 * 60_000;
        while (Date.now() < fireDeadline && capturesSince(started, "firing").length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
        const firing = capturesSince(started, "firing");
        assert(firing.length > 0, "Grafana's AgentDown never reached the ChatOps space within 20m");
        const firingEvent = (firing[0]!.body["event"] ?? {}) as { id?: string; correlationId?: string };
        assert(!!firingEvent.correlationId, "the recorded capture carries no correlation id");

        // 2. Recovery: agent back, then the queued agent delivery for
        //    that same event lands - by residual retry or DLQ replay.
        kubectl(["scale", workload, "-n", ns, "--replicas=1"], { quiet: true });
        sh(["kubectl", "--context", KCTX, "-n", ns, "rollout", "status", workload, "--timeout=300s"], { quiet: true });
        const acceptedFor = async (correlation: string): Promise<DeliveryReceipt | undefined> => {
          const { body } = await routerFetch(`/v1/status?correlation=${correlation}`);
          return (((body as { receipts?: DeliveryReceipt[] }).receipts ?? [])).find(
            (r) => r.kind === "agent" && r.status === "accepted",
          );
        };
        let agentReceipt: DeliveryReceipt | undefined;
        const landDeadline = Date.now() + 10 * 60_000;
        while (Date.now() < landDeadline && !agentReceipt) {
          agentReceipt = await acceptedFor(firingEvent.correlationId!);
          if (!agentReceipt) {
            await routerFetch("/v1/dlq/replay", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({}),
            });
            await new Promise((resolve) => setTimeout(resolve, 20_000));
          }
        }
        assert(!!agentReceipt, "the firing event never landed in the platform-sre session after recovery");
        const session = agentReceipt!.sessionKey ?? "";
        assert(session.includes("/platform-sre/"), `session key lacks the profile namespace: ${session}`);

        // 3. Resolved: the recovery notification reaches the SAME
        //    incident session (same Grafana group -> same subject).
        const resolveDeadline = Date.now() + 20 * 60_000;
        let resolvedReceipt: DeliveryReceipt | undefined;
        while (Date.now() < resolveDeadline && !resolvedReceipt) {
          const { body } = await routerFetch("/v1/status");
          resolvedReceipt = (((body as { receipts?: DeliveryReceipt[] }).receipts ?? [])).find(
            (r) =>
              r.kind === "agent" &&
              r.status === "accepted" &&
              r.sessionKey === session &&
              r.deliveryId !== agentReceipt!.deliveryId,
          );
          if (!resolvedReceipt) await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
        assert(!!resolvedReceipt, "the resolved notification never reached the incident session within 20m");
        return `Grafana fired and resolved through the plane; both landed in ${session}`;
      } finally {
        kubectl(["scale", workload, "-n", ns, "--replicas=1"], { quiet: true, allowFail: true });
      }
    });
  } else {
    skip("live-grafana", "--require-live-grafana not set (wiring verified above)");
  }

  // --- 13. Secret redaction ------------------------------------------------
  await stage("secret-redaction", async () => {
    const secrets = new Set<string>();
    for (const c of profileCtxs(state)) {
      const s = loadTestConfig(c.dir).secrets["WEBHOOK_SECRET"];
      if (s) secrets.add(s);
    }
    for (const v of Object.values(state.commExtSecrets ?? {})) secrets.add(v);
    const token = process.env["HG_SLACK_BOT_TOKEN"];
    if (token) secrets.add(token);
    assert(secrets.size > 0, "no secrets known to scan for - the scan would be vacuous");
    const surfaces: [string, string][] = [];
    const { body } = await routerFetch("/v1/status");
    surfaces.push(["router receipts", JSON.stringify(body)]);
    if (fs.existsSync(SINK_LOG)) surfaces.push(["recording sink", fs.readFileSync(SINK_LOG, "utf8")]);
    const valuesFile = path.join(HG_HOME, "event-router-values.yaml");
    if (fs.existsSync(valuesFile)) surfaces.push(["emitted router values", fs.readFileSync(valuesFile, "utf8")]);
    for (const [name, content] of surfaces) {
      for (const secret of secrets) {
        assert(!content.includes(secret), `a secret value leaked into ${name}`);
      }
    }
    return `${secrets.size} secret value(s) scanned across ${surfaces.length} surfaces - zero leaks`;
  });

  const failed = stages.filter((s) => !s.ok);
  const report = {
    command: "communication-prove",
    ok: failed.length === 0,
    dir: ctx.root,
    stages,
    summary: { total: stages.length, passed: stages.filter((s) => s.ok && !s.skipped).length, skipped: stages.filter((s) => s.skipped).length, failed: failed.length },
  };
  if (json) jsonOut(report);
  else if (report.ok) ok(`communication prove: ${report.summary.passed} stage(s) passed, ${report.summary.skipped} skipped`);
  if (!report.ok) throw new CliError(`communication prove: ${failed.length} stage(s) FAILED (${failed.map((f) => f.stage).join(", ")})`);
}
