// The static demo shell bundle (src/demo.tsx): bundles React like the
// standalone build, but lands in the assembled site (`make site`), never
// in control-plane/nexus/dist - the Helm-carried dist has a size budget
// and the cluster never serves the demo.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../site/demo",
    emptyOutDir: false,
    minify: true,
    lib: { entry: "src/demo.tsx", formats: ["iife"], name: "HarnessHgNexusUIDemo", fileName: () => "demo.js" },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
