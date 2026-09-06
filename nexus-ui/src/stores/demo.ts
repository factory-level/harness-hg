// The demo fixture: what the not-configured 503 substitutes (#414 - the
// DemoBadge makes the substitution visible; demo turns every flag on but
// never re-enables a withheld view). Grows screen by screen with the
// rebuild; this is deliberately data, not behavior.
import type { HealthOverlay, NexusData } from "./data";

export const DEMO_DATA: NexusData = {
  demo: true,
  canWrite: false,
  plan: {
    components: [
      // icon codes name REAL files in the served avatar library, so demo
      // mode exercises the animated-art path, not just the fallbacks.
      { id: "mkt-manager", title: "Marketing Manager", kind: "agent", icon: "mkt-manager", bind: { profile: "mkt-manager" }, links: { repository: "https://github.com/example/social-media" }, instances: [{ destinations: { deployed: [{ name: "published", url: "https://manager.factorylevel.dev" }] } }], description: "Owns the calendar and the sign-off queue; every release passes through this desk." },
      { id: "mkt-engage", title: "Engagement", kind: "agent", icon: "mkt-engagement", bind: { profile: "mkt-engage" }, description: "Answers mentions and threads within the hour, in the brand voice." },
      { id: "mkt-research", title: "Research", kind: "agent", bind: { profile: "mkt-research" }, description: "No icon on purpose - this card proves the rings fallback." },
      { id: "app-postiz", title: "Postiz", kind: "application", icon: "app-postiz", bind: { profile: "mkt-manager", app: "postiz" } },
      { id: "operator", title: "Avery", kind: "person", personTitle: "Operator", accessors: ["mkt-manager"] },
      { id: "higgsfield", title: "Higgsfield", kind: "external-tool" },
      { id: "marketing", title: "Marketing Team", kind: "agent-bundle" },
      { id: "content-published", title: "content.published/v1", kind: "comm-out", description: "#social" },
    ],
  },
  links: {},
  features: {},
  capabilities: { views: {} },
  bundles: [{ id: "marketing", title: "Marketing Team", members: ["mkt-manager", "mkt-research"] } as never],
  alerts: {
    configured: true,
    reachable: true,
    firing: [
      {
        name: "KubePodCrashLooping",
        namespace: "hermes-mkt-research",
        severity: "warning",
        signal: "business",
        summary: "research agent restarting",
      },
    ],
  },
};

export const DEMO_HEALTH: HealthOverlay = {
  components: {
    "mkt-manager": { level: "healthy" },
    "mkt-research": { level: "degraded", summary: "restarting", sources: [{ kind: "grafana", status: "configured" }] },
    "mkt-engage": { level: "healthy" },
    "app-postiz": { level: "healthy" },
  },
  instances: {},
  sources: {
    argocd: { status: "ok", kind: "argocd" },
    prometheus: { status: "ok", kind: "prometheus" },
  },
  rollups: { "bundle:marketing": { level: "degraded" }, "bucket:unbundled": { level: "healthy" } },
};

import type { BackupsDoc } from "../app/backups/model";

export const DEMO_BACKUPS: BackupsDoc = {
  observedAt: "just now",
  counts: { routines: 6 },
  routines: [
    { id: "cp-nexus", title: "Nexus workspace", component: "nexus", namespace: "hermes-nexus", group: "control-plane", schedule: "20 3 * * *", retention: "14d", destination: "gcs", protects: ["workspace document", "feature overlay"], restore: "hg platform backup restore nexus", state: "healthy", level: "healthy", artifact: { state: "restorable" }, lastSuccess: "3h ago", runs: [{ name: "a", state: "succeeded" }, { name: "b", state: "succeeded" }] },
    { id: "cp-router", title: "Event router DLQ", component: "event-router", namespace: "hermes-system", group: "control-plane", schedule: "*/30 * * * *", retention: "7d", destination: "pvc", protects: ["dead letters"], restore: "hg platform backup restore event-router", state: "healthy", level: "healthy", artifact: { state: "unproven" }, lastSuccess: "12m ago", runs: [{ name: "a", state: "succeeded" }] },
    { id: "cp-grafana", title: "Grafana state", component: "grafana", namespace: "hermes-monitoring", group: "control-plane", schedule: "0 4 * * 0", retention: "30d", destination: "gcs", protects: ["dashboards", "contact points"], restore: "hg platform backup restore grafana", state: "late", level: "degraded", artifact: { state: "restorable" }, lastSuccess: "9d ago", reason: "last run exceeded its window", runs: [{ name: "a", state: "failed" }, { name: "b", state: "succeeded" }] },
    { id: "mkt-manager-ws", title: "Manager workspace", componentTitle: "mkt-manager", bundle: "marketing", bundleTitle: "Marketing Team", namespace: "hermes-mkt-manager", schedule: "10 2 * * *", retention: "14d", destination: "gcs", protects: ["agent state volume"], restore: "hg backup restore mkt-manager", state: "healthy", level: "healthy", artifact: { state: "restorable" }, lastSuccess: "6h ago", runs: [{ name: "a", state: "succeeded" }] },
    { id: "mkt-postiz-db", title: "Postiz database", componentTitle: "app-postiz", bundle: "marketing", bundleTitle: "Marketing Team", namespace: "hermes-mkt-manager", schedule: "0 */6 * * *", retention: "7d", destination: "gcs", protects: ["postgres dump"], restore: "hg backup restore app-postiz", state: "never", level: "unknown", artifact: { state: "unmeasured" }, runs: [] },
    { id: "indep-registry", title: "Chart registry cache", schedule: "0 5 * * *", destination: "local-directory", state: "ephemeral", level: "healthy", artifact: { state: "none" }, lastSuccess: "1d ago", runs: [{ name: "a", state: "succeeded" }] },
  ],
  unprotected: [
    { id: "mkt-relay", title: "marketing-sre-relay", bundle: "marketing", reason: "chart declares no backup routine", level: "degraded" },
  ],
};

import type { CommHistoryDoc, CommunicationDoc } from "../app/communication/model";

export const DEMO_COMM: CommunicationDoc = {
  statusOrder: ["declared", "configured", "stale", "degraded", "failed"],
  provenance: { observedAt: "just now", sources: { router: "ok", grafana: "ok" } },
  alerts: {
    configured: true,
    reachable: true,
    firing: [
      { name: "KubePodCrashLooping", namespace: "hermes-mkt-research", severity: "warning", signal: "business", since: "22m", summary: "research agent restarting", labels: { namespace: "hermes-mkt-research", pod: "mkt-research-0" }, ownership: undefined },
      { name: "NodeDiskPressure", namespace: "kube-system", severity: "warning", signal: "platform", since: "2h", summary: "node disk above threshold", labels: { node: "factory-1" }, ownership: "control-plane" },
      { name: "Watchdog", namespace: "hermes-monitoring", severity: "none", signal: "platform", summary: "dead-man certification", labels: {} },
    ],
  },
  edges: [
    // Producers wear the wire's composite form (<profile>[/<app>][@scope]#<handler>);
    // agent edges carry kind:"agent" - the badge joins match on both.
    { id: "e1", producer: "mkt-research@feed#topics", kind: "agent", event: "content.topic/v1", route: "router", delivery: { deadLetter: true }, target: { profile: "mkt-manager" }, bundle: "marketing", bundleTitle: "Marketing Team" },
    { id: "e2", producer: "mkt-manager/postiz@queue#approved", kind: "agent", event: "content.approved/v1", route: "router", delivery: { deadLetter: true }, target: { profile: "mkt-engage" }, bundle: "marketing", bundleTitle: "Marketing Team" },
    { id: "e3", producer: "mkt-engage@voice#published", kind: "chatops", event: "content.published/v1", route: "direct", target: { provider: "discord", space: "#social" }, bundle: "marketing", bundleTitle: "Marketing Team" },
    { id: "e4", producer: "alert-router@routes#alarm", kind: "agent", alarmClass: true, event: "observability.alert/v1", route: "router", target: { profile: "mkt-research" }, ownership: "control-plane" },
    // The inbound demo cable: this edge's event matches the webhook's,
    // so #/communication/in:github-webhook draws a real live board.
    { id: "e5", producer: "github@hooks#push", kind: "agent", event: "code.pushed/v1", externalInput: "github-webhook", route: "router", delivery: { deadLetter: true }, target: { profile: "mkt-manager" }, bundle: "marketing", bundleTitle: "Marketing Team" },
  ],
  live: {
    e1: { status: "configured", lastSuccessAt: "3m ago" },
    e2: { status: "configured", lastSuccessAt: "18m ago" },
    e3: { status: "degraded", dlqDepth: 2, lastFailureAt: "5m ago" },
    e4: { status: "configured", lastSuccessAt: "1m ago" },
    e5: { status: "configured", lastSuccessAt: "9m ago" },
  },
  impliedEvents: [{ event: "agents.all/v1", note: "reserved broadcast — every agent may receive it" }],
  // The SERVER's projection shape (_project_external_input + edge_owner),
  // not a fixture-side fiction: id/profile/event/verification/accepts.
  externalInputs: [{ id: "github-webhook", profile: "mkt-manager", event: "code.pushed/v1", verification: "hmac", accepts: ["push", "issues"], bundle: "marketing", bundleTitle: "Marketing Team" }],
  // One mixed fan-out so the outcome chips and the spine's
  // "delivered/total" line both render their honest split.
  latestExecution: {
    correlationId: "corr-demo-1",
    observedAt: "2m ago",
    consumers: [
      { edge: "e1", route: "router", kind: "agent", status: "delivered", at: "2m ago" },
      { edge: "e3", route: "direct", kind: "chatops", status: "failed", classification: "provider-error", attempt: 3, at: "2m ago" },
    ],
    delivered: 1,
    failed: 1,
  },
};

export const DEMO_COMM_HISTORY: CommHistoryDoc = {
  window: "24h",
  windowSeconds: 86400,
  stepSeconds: 3600,
  receipts: {
    state: "ok",
    truthfulWindow: "since router start",
    entries: [
      { edge: "e2", route: "router", kind: "agent", status: "delivered", at: "3h ago", correlationId: "corr-demo-0" },
      { edge: "e3", route: "direct", kind: "chatops", status: "delivered", at: "3h ago", correlationId: "corr-demo-0" },
      { edge: "e5", route: "router", kind: "agent", status: "delivered", at: "1h ago", correlationId: "corr-demo-hook" },
      { edge: "e1", route: "router", kind: "agent", status: "delivered", at: "2m ago", correlationId: "corr-demo-1" },
      { edge: "e3", route: "direct", kind: "chatops", status: "failed", classification: "provider-error", attempt: 3, at: "2m ago", correlationId: "corr-demo-1" },
      { edge: "e3", route: "direct", kind: "chatops", status: "dead-lettered", at: "1m ago", correlationId: "corr-demo-1" },
    ],
  },
  pulse: {
    state: "ok",
    buckets: Array.from({ length: 24 }, (_, i) => ({
      at: `${23 - i}h ago`,
      // A believable day: quiet overnight, busy midday, one failure
      // spike near the end so the crit bars visibly stack.
      delivered: [0, 0, 1, 0, 2, 3, 4, 6, 5, 7, 8, 6, 9, 7, 5, 6, 4, 5, 3, 4, 2, 3, 2, 1][i] ?? 0,
      failed: i === 20 ? 3 : i === 21 ? 1 : 0,
    })),
  },
  alertHistory: { state: "ok", entries: [] },
  provenance: { observedAt: "just now", sources: { receipts: { family: "event-router", state: "ok" }, pulse: { family: "prometheus", state: "ok" } } },
};

// Workspace bindings fixture: one binding with a mounted target and one
// whose pod list was unreadable (mounted: null - unknown, not false).
export const DEMO_BINDINGS = [
  {
    repository: "https://github.com/example/social-media",
    source: "declaration",
    mountPath: "/workspace/persona",
    access: "read-only",
    purpose: "persona declarations",
    targets: [
      { profile: "mkt-manager", mounted: true },
      { profile: "mkt-research", mounted: null },
    ],
  },
];

import type { Workload } from "../app/system/capabilities";

export const DEMO_INVENTORY: Workload[] = [
  { id: "reconciler", title: "Reconciler", role: "applies the persona repo on a timer" },
  { id: "argocd", title: "Argo CD", role: "reconciles the destination repo" },
  { id: "communication-router", title: "Event router", role: "routes typed events" },
  { id: "communication-queue", title: "Queue", role: "durable delivery" },
  { id: "chatops", title: "Chatops relay", role: "chat-side delivery" },
  { id: "prometheus", title: "Prometheus", role: "metrics + rules" },
  { id: "grafana", title: "Grafana", role: "dashboards + alert UI" },
  { id: "alertmanager", title: "Alertmanager", role: "alert routing tree" },
  { id: "cloudflare-tunnel", title: "Tunnel", role: "the edge" },
  { id: "webhook-gateway", title: "Webhook gateway", role: "verifies inbound events" },
  { id: "hermes-runtime", title: "Agent runtime", role: "hosts the fleet" },
  { id: "backup-services", title: "Backup services", role: "routines + artifacts" },
  { id: "nexus", title: "Nexus", role: "this surface" },
  { id: "mystery-svc", title: "Mystery service", role: "deliberately unplaced (the note must show)" },
];

export const DEMO_PEOPLE = {
  groups: [{ id: "marketing", title: "Marketing Team", declaredBy: "social-media.harness-hg" }],
  people: [{ id: "operator", name: "Operator", role: "Person · Operator", declaredBy: "social-media.harness-hg" }],
};

// Structurally matches stores/document.ts NexusWorkspace (a type import
// would cycle: document.ts imports this fixture).
export const DEMO_WORKSPACE = {
  revision: 1,
  sheets: [
    {
      id: "social-media-operation",
      name: "Social Media Operation",
      cards: [
        // Spaced for the PAINTED boxes: avatar overhangs (36px up-left),
        // badge strips (~22px below) and the person label all get air -
        // the demo must never open with members resting on each other.
        { ref: "mkt-manager", x: 180, y: 180 },
        { ref: "mkt-research", x: 560, y: 80 },
        { ref: "mkt-engage", x: 560, y: 420 },
        { ref: "app-postiz", x: 960, y: 400 },
        { ref: "ghost-card", x: 960, y: 100 },
        { ref: "calvin", x: 90, y: 520 },
        { ref: "higgsfield", x: 960, y: 560 },
        { ref: "marketing", x: 220, y: 680 },
        { ref: "content-published", x: 1290, y: 380 },
      ],
      notes: [{ id: "demo-note", x: 1240, y: 90, text: "ship the reel before Friday - the carousel can slip" }],
      shapes: [{ id: "demo-region", x: 500, y: 20, w: 360, h: 680, label: "content loop", fill: "sky" }],
      texts: [{ id: "demo-text", x: 60, y: 40, size: "lg" as const, text: "The operation" }],
      connections: [
        { id: "demo-c1", from: "card:mkt-research", to: "card:mkt-manager" },
        { id: "demo-c2", from: "card:mkt-manager", to: "card:mkt-engage" },
        { id: "demo-c3", from: "card:mkt-engage", to: "card:content-published" },
      ],
    },
    { id: "dumdum", name: "DumDum Version", mode: "concept" as const, cards: [{ ref: "mkt-manager", x: 120, y: 120 }] },
  ],
};

// Panels demo: one of each state + both planes, so the badge, the
// same-box placeholder and the not-configured row all render.
export const DEMO_PANELS = {
  surface: "system",
  status: "configured",
  panels: [
    { id: "cp-health", title: "Control-plane health", size: "standard" as const, plane: "control-plane" as const, status: "configured", embedUrl: "about:blank", openUrl: "about:blank" },
    { id: "backup-history", title: "Backup history", size: "wide" as const, plane: "control-plane" as const, status: "configured", embedUrl: "about:blank", openUrl: "about:blank" },
    { id: "agent-load", title: "Agent load", size: "standard" as const, plane: "workload" as const, status: "not configured", reason: "this component has no Grafana dashboard" },
  ],
  grafana: { state: "ok" },
};
