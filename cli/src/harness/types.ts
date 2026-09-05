// The types every AI harness driver shares (ADR-153).
//
// They live in their own module rather than in ./index.ts so a driver can
// import the shapes it must produce without importing the registry that
// imports it back.

import type { AgentRuntime, ProfileCtx } from "../lib.ts";

/** Result of running a command inside a deployed agent's pod. */
export interface AgentExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/** One prompt's answer, whichever engine produced it. */
export interface TurnResult {
  ok: boolean;
  output: string;
  error?: string;
}

/** Everything `hg agent show` reports for one profile, on either engine.
 *
 * Four columns rather than one boolean, because "it is in the repo",
 * "it reached the pod", "it is switched on" and "it is actually running"
 * are four different failures and collapsing them is precisely how a
 * catalogue shipped with cron nobody had activated.
 *
 * Every field past `engine` is optional because the two engines answer
 * different questions: Hermes reports plugins, MCP servers and cron from
 * an in-pod probe; Eve reports channels, subagents and tool groups from
 * its info route and its runtime manifest. A field a driver cannot answer
 * is ABSENT, never an empty array pretending to be an answer. */
export interface AgentSnapshot {
  profile: string;
  ok: boolean;
  /** Which harness this agent runs on - the first thing every reader of a
   * snapshot needs, and the reason this shape is shared at all. */
  engine?: AgentRuntime;
  error?: string;
  profileDir?: string;
  /** The deployed source revision, from the runtime manifest (Eve) or the
   * distribution block (Hermes). */
  runtimeRevision?: string;
  /** The Kubernetes-facing name (ADR-151: `hermes-<name>` / `ag-eve-<name>`). */
  instance?: string;
  distribution?: { name?: string; version?: string };
  model?: { provider?: string; name?: string };
  skills?: string[];
  plugins?: string[];
  mcpServers?: string[];
  /** Eve: the agent's declared channels (`agent/channels/`), as the info
   * route reports them. */
  channels?: string[];
  /** Eve: declared subagents (`agent/subagents/<name>/agent.ts`). */
  subagents?: string[];
  /** Eve: the tools the agent can actually call, from the info route's
   * `tools.available` - what survived its own configuration, not the
   * framework's whole catalogue. */
  tools?: string[];
  /** Bound code workspaces, with the path the agent actually reads them at. */
  workspaces?: { name: string; path: string; access: string; revision?: string }[];
  /** Declared third-party app registrations bound to this agent (ADR-152). */
  connections?: { name: string; provider: string }[];
  webhookRoutes?: string[];
  webhookSubscriptions?: string[];
  webhookEnabled?: boolean;
  /** Every platform the config takes a position on, enabled or not. A
   * disabled entry is as informative as an enabled one: several adapters
   * come up from an env token alone, so "we chose not to" only exists if
   * someone wrote it down. */
  platforms?: Record<string, boolean>;
  cron?: {
    name: string;
    schedule: string;
    state: string;
    enabled: boolean;
    nextRun: string | null;
    declaredBy: string | null;
  }[];
  cronDeclarations?: string[];
  /** Eve: declared schedules (`agent/schedules/`), id and cron expression. */
  schedules?: { id: string; cron: string | null }[];
  sessions?: number;
  envKeys?: string[];
  /** Keys present in the env Secret whose VALUE is empty. A connection
   * projection writes every key of its provider's set, unset ones as
   * empty strings, so "the name is there" and "the credential arrived"
   * are different facts - and a name list alone reports an unsupplied
   * token as configured. Names only, as ever. */
  emptyEnvKeys?: string[];
  /** What THIS distribution ships, read from the local source directory.
   * A profile's skills/ also holds Hermes' own bundled set, so "20 skills
   * present" says nothing about whether the two you wrote arrived. */
  declaredSkills?: string[];
  missingSkills?: string[];
  /** Files or legs the probe could not read. Non-empty means the rest of
   * this snapshot understates what is there — an unparseable `config.yaml`
   * would otherwise be reported as "no configuration", which is the one
   * lie this command must never tell. */
  problems?: string[];
}

/** What every harness must be able to do to a deployed agent.
 *
 * Deliberately small. It is the set `hg agent` and `hg prompt` need, not
 * an attempt to describe agent runtimes in general: the engines differ in
 * how they deploy, build, back up and prove, and those differences live in
 * the charts, the emitter and each driver's own module - not behind a
 * lowest-common-denominator interface nobody could implement honestly. */
export interface HarnessDriver {
  runtime: AgentRuntime;
  /** ONE prompt against the deployed agent. */
  invoke(ctx: ProfileCtx, prompt: string, timeoutSec: number): Promise<TurnResult>;
  /** What the running agent is configured with, right now. Never throws:
   * a failure is `{ ok: false, error }` because callers differ on what a
   * failure means. */
  show(ctx: ProfileCtx, timeoutSec?: number): Promise<AgentSnapshot>;
  /** The labelled debug escape hatch: run the engine's own CLI in the pod. */
  exec(ctx: ProfileCtx, argv: string[], timeoutSec: number): Promise<AgentExecResult>;
}
