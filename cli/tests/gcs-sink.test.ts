// The GCS sink's pure parts (#283). One code path, two endpoints: the
// real bucket is #297, everything about the object layout and how a
// backup is addressed is provable here.

import { describe, expect, test } from "bun:test";
import { destinationClassOf, evaluateBucketPosture, isEmulated, objectKey, sinkFromUrl } from "../src/backup/gcs-sink.ts";

describe("sinkFromUrl", () => {
  test("splits a bucket and prefix", () => {
    expect(sinkFromUrl("gs://my-bucket/envs/prod")).toEqual({ bucket: "my-bucket", prefix: "envs/prod" });
  });

  test("a bare bucket has no prefix", () => {
    expect(sinkFromUrl("gs://my-bucket")).toEqual({ bucket: "my-bucket", prefix: "" });
  });

  test("a trailing slash does not become an empty path segment", () => {
    expect(sinkFromUrl("gs://acme-backup/envs/").prefix).toBe("envs");
  });

  test("anything that is not a bucket URL is refused, not coerced", () => {
    for (const bad of [
      "s3://acme/x",
      "/local/path",
      "gs://",
      "gs://A-BAD-BUCKET",   // uppercase is not a legal bucket name
      "gs://ab",             // GCS requires at least 3 characters
      "https://x/y",
      "",
    ]) {
      expect(() => sinkFromUrl(bad)).toThrow();
    }
  });
});

describe("objectKey", () => {
  test("one flat prefix per backup id", () => {
    // A restore selects a GENERATION of a whole backup, so scattering a
    // backup across a tree makes "which objects are this one" a question
    // you answer by listing and hoping.
    const sink = sinkFromUrl("gs://acme-backup/envs/prod");
    expect(objectKey(sink, "hg-2026-08-02z", "volumes/sre/a.tar.gz")).toBe(
      "envs/prod/backups/hg-2026-08-02z/volumes/sre/a.tar.gz",
    );
  });

  test("no prefix still produces a clean key", () => {
    expect(objectKey(sinkFromUrl("gs://acme-backup"), "hg-1", "manifest.json")).toBe("backups/hg-1/manifest.json");
  });

  test("never emits a doubled separator", () => {
    const sink = { bucket: "acme-backup", prefix: "p/" };
    expect(objectKey(sink, "hg-1", "/manifest.json")).not.toContain("//");
  });
});

describe("emulation is never reported as the real thing", () => {
  test("an emulated sink says so", () => {
    // A surface reporting `gcs` for an emulator would claim off-site
    // durability that does not exist. That is the one thing an emulation
    // must never be allowed to do.
    const emu = { bucket: "acme-backup", prefix: "", endpoint: "http://127.0.0.1:4443" };
    expect(isEmulated(emu)).toBe(true);
    expect(destinationClassOf(emu)).toBe("gcs-emulated");
  });

  test("a real sink reports gcs", () => {
    const real = sinkFromUrl("gs://acme-backup/p");
    expect(isEmulated(real)).toBe(false);
    expect(destinationClassOf(real)).toBe("gcs");
  });
});

describe("evaluateBucketPosture (ADR-49/#297)", () => {
  const GOOD = {
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
    versioning: { enabled: true },
    encryption: { defaultKmsKeyName: "projects/p/locations/us/keyRings/backups/cryptoKeys/factory-backup" },
  };

  test("a provisioned sink bucket has no violations", () => {
    expect(evaluateBucketPosture(GOOD)).toEqual([]);
  });

  test("each missing control is named, not summarized", () => {
    // The operator fixes the named control; "bad posture" fixes nothing.
    expect(evaluateBucketPosture({})).toEqual([
      "uniform bucket-level access is off",
      "public-access prevention is not enforced",
      "object versioning is off",
      "no default CMEK key",
    ]);
    expect(evaluateBucketPosture({ ...GOOD, versioning: { enabled: false } })).toEqual([
      "object versioning is off",
    ]);
  });

  test("the gcloud CLI's flattened snake_case shape passes the same policy", () => {
    // What `gcloud storage buckets describe --format=json` ACTUALLY
    // emits - learned against the first live bucket, where the JSON-API
    // field names read every control as missing.
    expect(
      evaluateBucketPosture({
        uniform_bucket_level_access: true,
        public_access_prevention: "enforced",
        versioning_enabled: true,
        default_kms_key: "projects/p/locations/us/keyRings/backups/cryptoKeys/factory-backup",
      }),
    ).toEqual([]);
    expect(evaluateBucketPosture({ uniform_bucket_level_access: true, public_access_prevention: "enforced", versioning_enabled: true })).toEqual([
      "no default CMEK key",
    ]);
  });

  test("inherited public-access prevention is NOT enough - it must be enforced", () => {
    const inherited = {
      ...GOOD,
      iamConfiguration: { ...GOOD.iamConfiguration, publicAccessPrevention: "inherited" },
    };
    expect(evaluateBucketPosture(inherited)).toEqual(["public-access prevention is not enforced"]);
  });
});
