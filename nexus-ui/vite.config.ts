// The nexus-ui plugin bundle: a plain IIFE loaded by the Hermes dashboard
// via <script> (the ADR-42 shape, carried over from dashboard/). React is
// the HOST's instance - the alias shims below re-export the SDK global -
// so nothing React-shaped is bundled. Astryx ships precompiled (dist JS +
// astryx.css), so no StyleX compilation of node_modules happens here; the
// define is required because the compiled library references
// process.env.NODE_ENV (spike finding). Minified so the committed dist
// stays byte-comparable AND under the nexus Helm release Secret's 1MiB
// cap; CI asserts the size budget.
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "react/jsx-runtime": path.resolve(__dirname, "src/shims/jsx-runtime.ts"),
      "react/jsx-dev-runtime": path.resolve(__dirname, "src/shims/jsx-runtime.ts"),
      "react-dom/client": path.resolve(__dirname, "src/shims/react-dom.ts"),
      "react-dom": path.resolve(__dirname, "src/shims/react-dom.ts"),
      react: path.resolve(__dirname, "src/shims/react.ts"),
    },
  },
  esbuild: { jsx: "automatic" },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "../control-plane/nexus/dist",
    emptyOutDir: true,
    minify: true,
    cssCodeSplit: false,
    lib: { entry: "src/index.tsx", formats: ["iife"], name: "HarnessHgNexusUI", fileName: () => "index.js" },
    rollupOptions: {
      output: { assetFileNames: "style.css" },
      // Astryx's compiled dist carries "use client" directives; rollup
      // warns they are meaningless in a bundle. True and harmless.
      onwarn(warning, warn) {
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
