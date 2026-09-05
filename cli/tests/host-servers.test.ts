// Booting the host servers cleanly, every time (the `hg up` contract).
//
// The bug this pins: `ensureServers` used to gate on `pidAlive` alone, and
// printed "host servers up" unconditionally. Neither is proof. A pid in
// state can be recycled to an unrelated process, and `git daemon` can fail
// to bind while the CLI reports success — which is invisible here and
// surfaces an hour later as a pod stuck in Init:CrashLoopBackOff in
// another namespace, cloning git://<gatewayIp>:<port>.
//
// These tests drive the real predicates against real sockets rather than
// mocking them, because the whole point is that the check is a PORT probe.
import { describe, expect, test } from "bun:test";
import { pidAlive, portAccepts, freePort } from "../src/lib.ts";

describe("the health predicate the boot check relies on", () => {
  test("portAccepts is false for a port nobody is listening on", () => {
    expect(portAccepts(freePort())).toBe(false);
  });

  test("portAccepts is true only while a listener is actually up", async () => {
    const port = freePort();
    expect(portAccepts(port)).toBe(false);
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    try {
      expect(portAccepts(port)).toBe(true);
    } finally {
      server.stop(true);
    }
    // Closed again: the probe must notice, or a dead daemon reads healthy.
    expect(portAccepts(port)).toBe(false);
  });

  test("a LIVE pid says nothing about whether its port is served", () => {
    // The exact false positive the old check made. This process is alive
    // by definition, and serves nothing — so pid-liveness alone would have
    // reported a healthy git daemon here.
    expect(pidAlive(process.pid)).toBe(true);
    expect(portAccepts(freePort())).toBe(false);
  });

  test("pidAlive is false for a pid that cannot exist", () => {
    expect(pidAlive(undefined)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(2 ** 30)).toBe(false); // above any real pid_max
  });
});
