import { describe, expect, test } from "bun:test";
import { INOTIFY_MIN_INSTANCES, inotifyShortfall } from "../src/platform/index.ts";

// The #862 preflight: the stock Linux limit must be named as a fix, not
// discovered as crash-looping pods ten minutes into `hg up`.
describe("inotifyShortfall", () => {
  test("the stock limit names the sysctl fix", () => {
    const msg = inotifyShortfall(128);
    expect(msg).toContain("128");
    expect(msg).toContain("sudo sysctl -w fs.inotify.max_user_instances=1024");
    expect(msg).toContain("/etc/sysctl.d/99-inotify.conf");
  });
  test("at or above the minimum, and off Linux, there is nothing to say", () => {
    expect(inotifyShortfall(INOTIFY_MIN_INSTANCES)).toBeNull();
    expect(inotifyShortfall(1024)).toBeNull();
    expect(inotifyShortfall(null)).toBeNull();
  });
});
