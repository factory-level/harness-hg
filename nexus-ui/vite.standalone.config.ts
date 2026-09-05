// The standalone shell bundle (ADR-48 shape): bundles React 19 because
// standalone IS the host; sets up the SDK globals then loads the plugin
// IIFE via <script>. emptyOutDir stays false so the two builds compose -
// and the ORDER matters: the main config's emptyOutDir deletes this
// bundle if the main build runs after it (documented trap, reproduced in
// the spike).
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../control-plane/nexus/dist",
    emptyOutDir: false,
    minify: true,
    lib: { entry: "src/standalone.tsx", formats: ["iife"], name: "HarnessHgNexusUIStandalone", fileName: () => "standalone.js" },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
