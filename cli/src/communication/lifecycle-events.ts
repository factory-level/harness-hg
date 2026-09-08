// Platform lifecycle events -> the Slack operations channel (Fable 1
// §18/§33, ADR-65). Delivered DIRECTLY from the CLI via the existing
// ChatOps provider, never through the in-cluster event router: bootstrap,
// destroy and restore happen precisely when the router does not exist or
// is being killed - a path through it could not announce its own death.
// The router keeps routing persona-declared events; the platform's own
// lifecycle is not a persona contract.
//
// Delivery NEVER fails the operation it narrates. A backup that succeeded
// but could not be announced is a successful backup with a warning - the
// inverse would let a Slack outage block a restore.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { log, ok, parseDotenv, warn, writeJsonAtomic } from "../lib.ts";
import { slackDeliver, type SlackDeliveryReceipt, type LogicalMessage } from "./index.ts";

// Read at CALL time, not import time - lib.ts's HG_HOME freezes at first
// import, which is exactly the trap that once let a test suite write into
// the operator's real ~/.hermes-gitops (the M0 lesson; reconcile paths
// are per-call functions for the same reason).
const hgHome = () =>
  process.env["HERMES_GITOPS_HOME"] || path.join(os.homedir(), ".hermes-gitops");

export type LifecycleKind = "bootstrap" | "reconcile" | "backup" | "restore" | "destroy" | "approval";
export type LifecyclePhase = "started" | "completed" | "failed";

export interface LifecycleEvent {
  kind: LifecycleKind;
  phase: LifecyclePhase;
  environment: string;
  facts: Record<string, string>;
}

/** The registration record - which channel this environment reports to.
 * Non-sensitive by construction (ids, never the token). */
export interface LifecycleRegistration {
  provider: "slack";
  environment: string;
  channelId: string;
  roleId?: string;
  registeredAt: string;
  messageId?: string;
}

export const LIFECYCLE_FILE = () => path.join(hgHome(), "lifecycle.json");

export function readRegistration(): LifecycleRegistration | null {
  const file = LIFECYCLE_FILE();
  if (!fs.existsSync(file)) return null;
  try {
    const registration = JSON.parse(fs.readFileSync(file, "utf8")) as LifecycleRegistration;
    return registration.provider === "slack" ? registration : null;
  } catch {
    return null;
  }
}

/** failed -> critical; the destructive/approval kinds -> warning; the
 * rest is progress. Pure, tested. */
export function lifecycleSeverity(event: Pick<LifecycleEvent, "kind" | "phase">): LogicalMessage["severity"] {
  if (event.phase === "failed") return "critical";
  if (event.kind === "destroy" || event.kind === "approval") return "warning";
  return "info";
}

const TITLES: Record<LifecycleKind, string> = {
  bootstrap: "Harness Hg bootstrap",
  reconcile: "Harness Hg reconciliation",
  backup: "Harness Hg backup",
  restore: "Harness Hg restore",
  destroy: "Harness Hg destruction",
  approval: "Human approval required",
};

/** Event -> the provider-neutral message. Pure, tested. The operator
 * role is mentioned for approvals and for anything critical - progress
 * events never ping. */
export function lifecycleMessage(
  event: LifecycleEvent,
  registration: Pick<LifecycleRegistration, "roleId">,
): LogicalMessage {
  const severity = lifecycleSeverity(event);
  const ping = event.kind === "approval" || severity === "critical";
  return {
    title: `${TITLES[event.kind]} ${event.kind === "approval" ? "" : event.phase}`.trim(),
    summary: `Environment \`${event.environment}\``,
    severity,
    status: event.phase,
    facts: { environment: event.environment, ...event.facts },
    links: [],
    ...(ping && registration.roleId ? { mention: { roleId: registration.roleId } } : {}),
  };
}

/** Slack bot credential from the operator environment or shared env file.
 * Legacy Discord credentials are never read. Values never enter receipts. */
export type LifecycleCredential = { kind: "bot"; token: string };

export function lifecycleCredential(): LifecycleCredential | null {
  const env = (k: string) => process.env[k];
  const shared = path.join(hgHome(), "env", "shared.env");
  const fromFile = fs.existsSync(shared) ? parseDotenv(fs.readFileSync(shared, "utf8")) : {};
  const token = env("HG_SLACK_BOT_TOKEN") ?? env("SLACK_BOT_TOKEN") ??
    fromFile["HG_SLACK_BOT_TOKEN"] ?? fromFile["SLACK_BOT_TOKEN"];
  if (token) return { kind: "bot", token };
  return null;
}

async function deliver(
  credential: LifecycleCredential,
  channelId: string,
  message: LogicalMessage,
): Promise<SlackDeliveryReceipt> {
  return slackDeliver(credential.token, channelId, message);
}

/** Fire one lifecycle event. Best-effort by contract: no registration or
 * no token is a quiet skip (the environment simply is not registered),
 * a delivery failure is a warning - never a thrown error. */
export async function emitLifecycleEvent(event: LifecycleEvent): Promise<void> {
  const registration = readRegistration();
  if (!registration) return;
  const credential = lifecycleCredential();
  if (!credential) {
    warn(`lifecycle event ${event.kind}.${event.phase} not delivered: no Slack credential on this host`);
    return;
  }
  try {
    const receipt = await deliver(
      credential,
      registration.channelId,
      lifecycleMessage({ ...event, environment: event.environment || registration.environment }, registration),
    );
    if (receipt.status === "delivered") log(`lifecycle: ${event.kind}.${event.phase} -> #${registration.channelId}`);
    else warn(`lifecycle event ${event.kind}.${event.phase} not delivered (${receipt.classification ?? "failed"})`);
  } catch {
    warn(`lifecycle event ${event.kind}.${event.phase} not delivered (provider unreachable)`);
  }
}

/** Register the environment with its operations channel. Idempotent: an
 * existing registration for the same environment+channel is read back
 * rather than re-posted, so repeated bootstraps never duplicate the
 * permanent registration message (Fable §18.1.7). */
export async function registerEnvironment(args: {
  environment: string;
  channelId: string;
  roleId?: string;
  facts: Record<string, string>;
}): Promise<LifecycleRegistration> {
  const existing = readRegistration();
  if (existing && existing.environment === args.environment && existing.channelId === args.channelId) {
    ok(`environment ${args.environment} already registered to channel ${args.channelId}`);
    return existing;
  }
  const credential = lifecycleCredential();
  if (!credential) {
    throw new Error(
      "no Slack credential: set HG_SLACK_BOT_TOKEN in the env or " +
        `${path.join(hgHome(), "env", "shared.env")}`,
    );
  }
  const registration: LifecycleRegistration = {
    provider: "slack",
    environment: args.environment,
    channelId: args.channelId,
    ...(args.roleId ? { roleId: args.roleId } : {}),
    registeredAt: new Date().toISOString(),
  };
  const message: LogicalMessage = {
    title: "Harness Hg environment registered",
    summary: `Environment \`${args.environment}\` reports its lifecycle to this channel.`,
    severity: "info",
    facts: { environment: args.environment, ...args.facts },
    links: [],
  };
  const receipt = await deliver(credential, args.channelId, message);
  if (receipt.status !== "delivered") {
    throw new Error(`registration message not delivered (${receipt.classification ?? "failed"})`);
  }
  if (receipt.providerMessageId) registration.messageId = receipt.providerMessageId;
  writeJsonAtomic(LIFECYCLE_FILE(), registration);
  ok(`environment ${args.environment} registered to channel ${args.channelId}`);
  return registration;
}
