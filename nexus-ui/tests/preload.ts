// Suite preload: the SDK global exists before ANY module under test
// evaluates (src/sdk.ts captures it at module load - exactly like the
// real host, where the <script> order guarantees it).
import * as RealReact from "react";
(globalThis as Record<string, unknown>)["__HERMES_PLUGIN_SDK__"] = {
  sdkVersion: "test",
  React: RealReact,
  fetchJSON: async () => {
    throw new Error("503 test: not configured");
  },
};
