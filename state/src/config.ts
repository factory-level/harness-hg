// Pure config parsing/validation for the state/ stack (spec §23) - no
// Pulumi runtime, unit-tested in tests/config.test.ts. Everything that
// would fail mid-apply for a shape reason fails HERE, at preview, with
// the offending key named (the same fail-fast posture as infra/).

export class ConfigError extends Error {}

// GCP service account accountId: 6-30 chars, lowercase letters, digits
// and hyphens, must start with a letter. "<agent>-deployer" must fit.
const SA_SUFFIX = "-deployer";
const SA_MAX = 30;
export const AGENT_NAME_MAX = SA_MAX - SA_SUFFIX.length; // 21
const AGENT_RE = /^[a-z][-a-z0-9]*[a-z0-9]$/;

// GCS bucket names: 3-63 chars for the "<project>-<agent>-state" form.
const BUCKET_MAX = 63;
const BUCKET_SUFFIX = "-state";

export interface StateStackConfig {
  rootKmsKeyId: string;
  deployerGroup: string;
  agents: string[];
  bucketLocation: string;
  // Strict cryptographic isolation (spec §23 "Per-agent keys"): one KMS
  // key per agent instead of every agent SA sharing the root key. The
  // trade is more keys to rotate for "agent A literally cannot decrypt
  // agent B's secrets".
  perAgentKeys: boolean;
  // Environments whose platform-backup sink this stack provisions
  // (ADR-49/#297): per environment a CMEK bucket plus the
  // backup-writer / restore-reader identity split.
  backupEnvironments: string[];
}

export function validateAgentName(agent: string, project: string): void {
  if (!AGENT_RE.test(agent)) {
    throw new ConfigError(
      `agents entry ${JSON.stringify(agent)} must be lowercase letters/digits/` +
        "hyphens, starting with a letter (it names a GCP service account)",
    );
  }
  if (agent.length > AGENT_NAME_MAX) {
    throw new ConfigError(
      `agents entry ${JSON.stringify(agent)} is ${agent.length} chars; max is ` +
        `${AGENT_NAME_MAX} ("${agent.slice(0, 8)}...${SA_SUFFIX}" must fit GCP's ` +
        `${SA_MAX}-char service-account id)`,
    );
  }
  const bucket = `${project}-${agent}${BUCKET_SUFFIX}`;
  if (bucket.length > BUCKET_MAX) {
    throw new ConfigError(
      `bucket name ${JSON.stringify(bucket)} is ${bucket.length} chars (GCS max ` +
        `${BUCKET_MAX}) - shorten the agent name`,
    );
  }
}

export function parseStateStackConfig(
  raw: {
    rootKmsKeyId: string | undefined;
    deployerGroup: string | undefined;
    agents: unknown;
    bucketLocation: string | undefined;
    perAgentKeys: boolean | undefined;
    backupEnvironments?: unknown;
  },
  project: string,
): StateStackConfig {
  const rootKmsKeyId = raw.rootKmsKeyId ?? "";
  if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(rootKmsKeyId)) {
    throw new ConfigError(
      "rootKmsKeyId must be the full resource id of the MANUALLY created root " +
        "key: projects/<project>/locations/<loc>/keyRings/<ring>/cryptoKeys/<key> " +
        "(see README.md - the root is created by hand, never by Pulumi)",
    );
  }
  const deployerGroup = raw.deployerGroup ?? "";
  // A bare email is a Google GROUP (the documented shape). An org without
  // groups names the principal explicitly - "user:admin@example.com" -
  // because an IAM binding to a group that does not exist fails the whole
  // apply with GCP's least helpful error.
  const email = deployerGroup.includes(":") ? deployerGroup.slice(deployerGroup.indexOf(":") + 1) : deployerGroup;
  const prefix = deployerGroup.includes(":") ? deployerGroup.slice(0, deployerGroup.indexOf(":")) : "group";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !["group", "user", "serviceAccount"].includes(prefix)) {
    throw new ConfigError(
      "deployerGroup must be a group email (e.g. deployers@example.dev) or an explicit " +
        "principal (user:you@example.com | serviceAccount:sa@... ) whose members may impersonate " +
        "the per-agent deploy SAs",
    );
  }
  const agents = raw.agents;
  if (!Array.isArray(agents) || agents.length === 0 || !agents.every((a) => typeof a === "string")) {
    throw new ConfigError('agents must be a non-empty list of agent names (e.g. ["research-agent"])');
  }
  const seen = new Set<string>();
  for (const agent of agents as string[]) {
    validateAgentName(agent, project);
    if (seen.has(agent)) throw new ConfigError(`agents entry ${JSON.stringify(agent)} is listed twice`);
    seen.add(agent);
  }
  const backupEnvironments = raw.backupEnvironments ?? [];
  if (!Array.isArray(backupEnvironments) || !backupEnvironments.every((e) => typeof e === "string")) {
    throw new ConfigError('backupEnvironments must be a list of environment names (e.g. ["factory"])');
  }
  const seenEnv = new Set<string>();
  for (const env of backupEnvironments as string[]) {
    // Same grammar as agents: the name becomes two SA ids and a bucket.
    validateBackupEnvironmentName(env, project);
    if (seenEnv.has(env)) throw new ConfigError(`backupEnvironments entry ${JSON.stringify(env)} is listed twice`);
    seenEnv.add(env);
  }
  return {
    rootKmsKeyId,
    deployerGroup,
    agents: agents as string[],
    bucketLocation: raw.bucketLocation || "US",
    perAgentKeys: raw.perAgentKeys ?? false,
    backupEnvironments: backupEnvironments as string[],
  };
}

// "<env>-backup-writer" (14 extra chars) is the longest SA id this form
// mints, and "<project>-<env>-backup" the bucket.
const BACKUP_SA_SUFFIX = "-backup-writer";
const BACKUP_BUCKET_SUFFIX = "-backup";
export const BACKUP_ENV_NAME_MAX = SA_MAX - BACKUP_SA_SUFFIX.length; // 16

export function validateBackupEnvironmentName(env: string, project: string): void {
  if (!AGENT_RE.test(env)) {
    throw new ConfigError(
      `backupEnvironments entry ${JSON.stringify(env)} must be lowercase letters/digits/` +
        "hyphens, starting with a letter (it names two GCP service accounts)",
    );
  }
  if (env.length > BACKUP_ENV_NAME_MAX) {
    throw new ConfigError(
      `backupEnvironments entry ${JSON.stringify(env)} is ${env.length} chars; max is ` +
        `${BACKUP_ENV_NAME_MAX} ("${env}${BACKUP_SA_SUFFIX}" must fit GCP's ${SA_MAX}-char id)`,
    );
  }
  const bucket = backupBucketNameFor(project, env);
  if (bucket.length > BUCKET_MAX) {
    throw new ConfigError(
      `bucket name ${JSON.stringify(bucket)} is ${bucket.length} chars (GCS max ` +
        `${BUCKET_MAX}) - shorten the environment name`,
    );
  }
}

/** The full IAM principal for the deployer binding: a bare email is a
 * group (the documented default); an explicit "user:"/"serviceAccount:"
 * prefix passes through verbatim. */
export function deployerPrincipal(deployerGroup: string): string {
  return deployerGroup.includes(":") ? deployerGroup : `group:${deployerGroup}`;
}

export function backupBucketNameFor(project: string, env: string): string {
  return `${project}-${env}${BACKUP_BUCKET_SUFFIX}`;
}
export function backupWriterIdFor(env: string): string {
  return `${env}${BACKUP_SA_SUFFIX}`;
}
export function restoreReaderIdFor(env: string): string {
  return `${env}-restore-reader`;
}

export function bucketNameFor(project: string, agent: string): string {
  return `${project}-${agent}${BUCKET_SUFFIX}`;
}
export function deployerIdFor(agent: string): string {
  return `${agent}${SA_SUFFIX}`;
}
