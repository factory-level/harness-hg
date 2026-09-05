import { describe, expect, test } from "bun:test";
import { evaluatePreflight, parseFacts } from "../src/server/bootstrap.ts";
import versions from "../../versions.json";

const GOOD_FACTS: Record<string, string> = {
  os_id: "ubuntu",
  os_version: "24.04",
  arch: "x86_64",
  nproc: "24",
  mem_kb: String(62 * 1024 * 1024),
  root_dev: "/dev/mapper/ubuntu--vg-ubuntu--lv",
  sync_parent_exists: "yes",
  sync_dev: "/dev/sdb1",
  sync_avail_kb: String(200 * 1024 * 1024),
  dns_ok: "yes",
  reach_github: "200",
  reach_gcs: "400",
  reach_discord: "401",
  ntp_synced: "yes",
  port_6443: "free",
  present_k3s: "no",
  present_kubeadm: "no",
  present_minikube: "no",
  k3s_version: "",
  sudo_nopasswd: "yes",
};

const GS = { backendUrl: "gs://state-bucket", allowLocalState: false };

function byId(findings: { id: string; status: string; message: string }[], id: string) {
  const f = findings.find((x) => x.id === id);
  if (!f) throw new Error(`no finding ${id}`);
  return f;
}

describe("evaluatePreflight", () => {
  test("a clean matching server passes every finding", () => {
    const findings = evaluatePreflight(GOOD_FACTS, GS);
    expect(findings.filter((f) => f.status === "fail")).toEqual([]);
    for (const id of ["SRV001", "SRV002", "SRV003", "SRV004", "SRV005", "SRV006", "SRV007", "SRV008"])
      expect(byId(findings, id).status).toBe("pass");
  });

  test("sync root on the ROOT device fails SRV003 - design 18 requires a separate disk", () => {
    const findings = evaluatePreflight({ ...GOOD_FACTS, sync_dev: GOOD_FACTS["root_dev"]! }, GS);
    expect(byId(findings, "SRV003").status).toBe("fail");
  });

  test("an unreachable endpoint names itself in SRV004", () => {
    const findings = evaluatePreflight({ ...GOOD_FACTS, reach_discord: "000" }, GS);
    const f = byId(findings, "SRV004");
    expect(f.status).toBe("fail");
    expect(f.message).toContain("discord");
  });

  test("a DIFFERENT k3s version is a failure, not a skip - the pin is the contract", () => {
    const findings = evaluatePreflight({ ...GOOD_FACTS, present_k3s: "yes", k3s_version: "v1.30.0+k3s1" }, GS);
    expect(byId(findings, "SRV006").status).toBe("fail");
  });

  test("the pinned k3s already installed passes SRV006 (idempotent rerun)", () => {
    const findings = evaluatePreflight({ ...GOOD_FACTS, present_k3s: "yes", k3s_version: versions.host.k3s }, GS);
    expect(byId(findings, "SRV006").status).toBe("pass");
  });

  test("password sudo is unknown-with-instructions, never a hard fail", () => {
    const findings = evaluatePreflight({ ...GOOD_FACTS, sudo_nopasswd: "no" }, GS);
    expect(byId(findings, "SRV007").status).toBe("unknown");
  });

  test("a local pulumi backend fails SRV008 unless --allow-local-state", () => {
    const local = { backendUrl: "file://~/.pulumi-local", allowLocalState: false };
    expect(byId(evaluatePreflight(GOOD_FACTS, local), "SRV008").status).toBe("fail");
    const allowed = { ...local, allowLocalState: true };
    expect(byId(evaluatePreflight(GOOD_FACTS, allowed), "SRV008").status).toBe("unknown");
  });

  test("busy 6443 without k3s fails; with pinned k3s it is the k3s api", () => {
    expect(byId(evaluatePreflight({ ...GOOD_FACTS, port_6443: "busy" }, GS), "SRV006").status).toBe("fail");
    const withK3s = { ...GOOD_FACTS, port_6443: "busy", present_k3s: "yes", k3s_version: versions.host.k3s };
    expect(byId(evaluatePreflight(withK3s, GS), "SRV006").status).toBe("pass");
  });
});

describe("parseFacts", () => {
  test("splits on the FIRST equals only and ignores junk lines", () => {
    const facts = parseFacts("a=1\nnoise\nurl=gs://x?a=b\n");
    expect(facts["a"]).toBe("1");
    expect(facts["url"]).toBe("gs://x?a=b");
    expect(Object.keys(facts)).toHaveLength(2);
  });
});
