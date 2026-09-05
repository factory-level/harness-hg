// The state/ stack (spec §23): runs against the MANUALLY created root
// bucket + KMS key (README.md - Pulumi cannot store the state of the
// stack that creates the state bucket inside that same bucket, so the
// root of the chain is by hand, deliberately outside Pulumi) and
// provisions, per agent:
//
//   - a versioned, private state bucket (the agent's infra/ stack backend)
//   - a deploy service account (the ONLY identity that applies that stack)
//   - IAM scoped so that SA can touch exactly its own bucket
//   - encrypt/decrypt on the secrets key - the shared root key by
//     default, or a per-agent key when perAgentKeys is set (strict
//     cryptographic isolation; see README.md's shared-key caveat)
//   - serviceAccountTokenCreator for the deployer group, so operators
//     and CI impersonate with short-lived tokens - no key files, ever
//
// Adding an agent = one line in the `agents` config + `pulumi up` here.
// The root bucket's and root key's own IAM is managed manually by the
// infra-root group; this program never touches it.

import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import {
  parseStateStackConfig,
  bucketNameFor,
  deployerIdFor,
  deployerPrincipal,
  backupBucketNameFor,
  backupWriterIdFor,
  restoreReaderIdFor,
} from "./config.ts";

const cfg = new pulumi.Config();
const project = gcp.config.project;
if (!project) {
  throw new Error("gcp:project must be set (pulumi config set gcp:project <project-id>)");
}

const config = parseStateStackConfig(
  {
    rootKmsKeyId: cfg.require("rootKmsKeyId"),
    deployerGroup: cfg.require("deployerGroup"),
    agents: cfg.requireObject<unknown>("agents"),
    bucketLocation: cfg.get("bucketLocation"),
    perAgentKeys: cfg.getBoolean("perAgentKeys"),
    backupEnvironments: cfg.getObject<unknown>("backupEnvironments"),
  },
  project,
);

// One keyring for every per-agent key (created only in perAgentKeys
// mode). KMS keyrings/keys are non-deletable in GCP: flipping the mode
// off later leaves the keyring behind (harmless, unbound) rather than
// destroying key material.
const agentKeyRing = config.perAgentKeys
  ? new gcp.kms.KeyRing("agents", { name: "agents", location: "us" })
  : null;

const backends: Record<string, pulumi.Output<string>> = {};
const identities: Record<string, pulumi.Output<string>> = {};
const secretsProviders: Record<string, pulumi.Output<string>> = {};

for (const agent of config.agents) {
  // Per-agent state bucket: versioned so every state mutation is
  // recoverable, lifecycle-pruned so versions don't grow unbounded,
  // private + uniform so object ACLs can't punch holes.
  const bucket = new gcp.storage.Bucket(`${agent}-state`, {
    name: bucketNameFor(project, agent),
    location: config.bucketLocation,
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
    versioning: { enabled: true },
    lifecycleRules: [{ condition: { numNewerVersions: 20 }, action: { type: "Delete" } }],
  });

  // Per-agent deploy identity - the only principal that applies this
  // agent's infra/ stack.
  const sa = new gcp.serviceaccount.Account(`${agent}-deployer`, {
    accountId: deployerIdFor(agent),
    displayName: `${agent} infra deployer`,
  });

  // This SA can read/write ONLY its own bucket - no path to any other
  // agent's state (the blast-radius property the whole design buys).
  new gcp.storage.BucketIAMMember(`${agent}-state-rw`, {
    bucket: bucket.name,
    role: "roles/storage.objectAdmin",
    member: pulumi.interpolate`serviceAccount:${sa.email}`,
  });

  // Secrets key: shared root key by default; per-agent key for strict
  // cryptographic isolation (agent A then literally cannot decrypt
  // agent B's secrets, at the cost of more keys to rotate).
  let cryptoKeyId: pulumi.Input<string> = config.rootKmsKeyId;
  if (agentKeyRing !== null) {
    const key = new gcp.kms.CryptoKey(`${agent}-key`, {
      name: agent,
      keyRing: agentKeyRing.id,
      purpose: "ENCRYPT_DECRYPT",
      rotationPeriod: "7776000s", // 90d, matching the manual root key
    });
    cryptoKeyId = key.id;
  }
  new gcp.kms.CryptoKeyIAMMember(`${agent}-secrets`, {
    cryptoKeyId,
    role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
    member: pulumi.interpolate`serviceAccount:${sa.email}`,
  });

  // Operators + CI mint short-lived tokens for this SA (impersonation) -
  // no downloadable key files anywhere in the chain.
  new gcp.serviceaccount.IAMMember(`${agent}-impersonation`, {
    serviceAccountId: sa.name,
    role: "roles/iam.serviceAccountTokenCreator",
    member: deployerPrincipal(config.deployerGroup),
  });

  backends[agent] = pulumi.interpolate`gs://${bucket.name}`;
  identities[agent] = sa.email;
  secretsProviders[agent] = pulumi.output(cryptoKeyId).apply((id) => `gcpkms://${id}`);
}

// ---------------------------------------------------------------------------
// Platform-backup sinks (ADR-49/#297): per environment, a CMEK bucket the
// backup verbs may only *add* objects to, and the identity split that makes
// "readable by someone other than the origin server" checkable:
//
//   <env>-backup-writer   objectCreator + list - can add, can never
//                         overwrite or delete (versioning covers same-name
//                         re-puts; immutability-by-IAM, not retention-lock)
//   <env>-restore-reader  objectViewer - the identity every fetch/verify
//                         uses; holds nothing the writer has
//
// Both decrypt through the bucket's default CMEK key. The nightly timer on
// the destination server impersonates the writer; a restore anywhere
// impersonates the reader.
const backupSinkOut: Record<string, pulumi.Output<string>> = {};
const backupWriterOut: Record<string, pulumi.Output<string>> = {};
const restoreReaderOut: Record<string, pulumi.Output<string>> = {};

const backupKeyRing = config.backupEnvironments.length > 0
  ? new gcp.kms.KeyRing("backups", { name: "backups", location: "us" })
  : null;

for (const env of config.backupEnvironments) {
  const key = new gcp.kms.CryptoKey(`${env}-backup-key`, {
    name: `${env}-backup`,
    keyRing: backupKeyRing!.id,
    purpose: "ENCRYPT_DECRYPT",
    rotationPeriod: "7776000s", // 90d, matching the state keys
  });
  // GCS writes with the per-project service agent, which must be able to
  // use the key before the bucket can name it as default.
  const storageAgent = gcp.storage.getProjectServiceAccountOutput({});
  const agentUse = new gcp.kms.CryptoKeyIAMMember(`${env}-backup-key-storage-agent`, {
    cryptoKeyId: key.id,
    role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
    member: pulumi.interpolate`serviceAccount:${storageAgent.emailAddress}`,
  });
  const bucket = new gcp.storage.Bucket(`${env}-backup`, {
    name: backupBucketNameFor(project, env),
    location: config.bucketLocation,
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
    versioning: { enabled: true },
    encryption: { defaultKmsKeyName: key.id },
    // Design 13's retention: old backup generations age out; the live
    // generation of every object stays.
    lifecycleRules: [
      { condition: { daysSinceNoncurrentTime: 90 }, action: { type: "Delete" } },
      { condition: { numNewerVersions: 10 }, action: { type: "Delete" } },
    ],
  }, { dependsOn: [agentUse] });

  const writer = new gcp.serviceaccount.Account(`${env}-backup-writer`, {
    accountId: backupWriterIdFor(env),
    displayName: `${env} platform-backup writer`,
  });
  const reader = new gcp.serviceaccount.Account(`${env}-restore-reader`, {
    accountId: restoreReaderIdFor(env),
    displayName: `${env} platform-restore reader`,
  });
  new gcp.storage.BucketIAMMember(`${env}-backup-write`, {
    bucket: bucket.name,
    role: "roles/storage.objectCreator",
    member: pulumi.interpolate`serviceAccount:${writer.email}`,
  });
  // The writer also READS: putObject stats each upload for its
  // generation, and listing supports the retention view. Stated plainly:
  // the writer can read back what the sink holds - the property the
  // split protects is narrower and load-bearing, that the writer holds
  // NO storage.objects.delete and therefore can neither remove nor
  // overwrite a finished backup (GCS requires delete to replace an
  // object, versioned or not).
  new gcp.storage.BucketIAMMember(`${env}-backup-list`, {
    bucket: bucket.name,
    role: "roles/storage.legacyBucketReader",
    member: pulumi.interpolate`serviceAccount:${writer.email}`,
  });
  new gcp.storage.BucketIAMMember(`${env}-backup-stat`, {
    bucket: bucket.name,
    role: "roles/storage.objectViewer",
    member: pulumi.interpolate`serviceAccount:${writer.email}`,
  });
  new gcp.storage.BucketIAMMember(`${env}-restore-read`, {
    bucket: bucket.name,
    role: "roles/storage.objectViewer",
    member: pulumi.interpolate`serviceAccount:${reader.email}`,
  });
  // objectViewer has no storage.buckets.get, and a reader that cannot
  // DESCRIBE the bucket reads "bucket does not exist" from the posture
  // gate - found live, on the first bucket this ever provisioned.
  new gcp.storage.BucketIAMMember(`${env}-restore-bucket-read`, {
    bucket: bucket.name,
    role: "roles/storage.legacyBucketReader",
    member: pulumi.interpolate`serviceAccount:${reader.email}`,
  });
  for (const [who, sa] of [["writer", writer], ["reader", reader]] as const) {
    new gcp.kms.CryptoKeyIAMMember(`${env}-backup-key-${who}`, {
      cryptoKeyId: key.id,
      role: "roles/cloudkms.cryptoKeyEncrypterDecrypter",
      member: pulumi.interpolate`serviceAccount:${sa.email}`,
    });
    new gcp.serviceaccount.IAMMember(`${env}-backup-${who}-impersonation`, {
      serviceAccountId: sa.name,
      role: "roles/iam.serviceAccountTokenCreator",
      member: deployerPrincipal(config.deployerGroup),
    });
    // A destination server authenticates as its environment's DEPLOYER
    // (the one key file the SA-key exception covers) and impersonates
    // the backup identities from there - so when an agent shares the
    // environment's name, its deployer may mint tokens for both. One
    // key on the host, never three.
    if (config.agents.includes(env)) {
      new gcp.serviceaccount.IAMMember(`${env}-backup-${who}-deployer-impersonation`, {
        serviceAccountId: sa.name,
        role: "roles/iam.serviceAccountTokenCreator",
        member: `serviceAccount:${deployerIdFor(env)}@${project}.iam.gserviceaccount.com`,
      });
    }
  }

  backupSinkOut[env] = pulumi.interpolate`gs://${bucket.name}/${env}`;
  backupWriterOut[env] = writer.email;
  restoreReaderOut[env] = reader.email;
}

// agent -> gs:// backend bucket (what `pulumi login` targets per agent)
export const agentBackends = backends;
// agent -> deploy SA email (what PULUMI_GOOGLE_IMPERSONATE_SERVICE_ACCOUNT names)
export const agentDeployers = identities;
// agent -> --secrets-provider value for that agent's infra/ stack init
export const agentSecretsProviders = secretsProviders;
// environment -> gs://<bucket>/<env> platform-backup sink (--sink value)
export const backupSinks = backupSinkOut;
// environment -> writer SA email (the nightly timer impersonates this)
export const backupWriters = backupWriterOut;
// environment -> reader SA email (every fetch/verify impersonates this)
export const restoreReaders = restoreReaderOut;
