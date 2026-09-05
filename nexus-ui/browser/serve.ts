// The nexus-ui browser harness: serves the built dist under the
// production CSP shape - API answers the not-configured 503 (the honest
// demo-mode substitution) except the avatar assets, which are real files
// so the gallery legs test the reference surface.
import * as fs from "node:fs";
import * as path from "node:path";

// The vite outDir moved to control-plane/nexus/dist with the #666 flip;
// pointing at the old gitignored nexus-ui/dist tested a stale bundle.
const DIST = path.join(import.meta.dir, "..", "..", "control-plane", "nexus", "dist");
const AVATARS = path.join(import.meta.dir, "..", "..", "control-plane", "nexus", "avatars");
const HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>nexus-ui harness</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/dist/style.css"></head><body><div id="nexus-root"></div><script src="/dist/standalone.js"></script></body></html>`;

function csp(): string {
  return [
    "default-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
  ].join("; ");
}

export interface Harness {
  url: string;
  stop: () => void;
}

export function startHarness(): Harness {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const headers: Record<string, string> = { "Content-Security-Policy": csp() };
      if (u.pathname === "/") return new Response(HTML, { headers: { ...headers, "content-type": "text/html" } });
      if (u.pathname.startsWith("/dist/")) {
        const f = path.join(DIST, u.pathname.slice(6));
        if (fs.existsSync(f)) {
          const ct = f.endsWith(".css") ? "text/css" : "text/javascript";
          return new Response(fs.readFileSync(f), { headers: { ...headers, "content-type": ct } });
        }
      }
      if (u.pathname === "/api/plugins/hermes-gitops/nexus/assets/avatars") {
        const ids = fs
          .readdirSync(AVATARS)
          .filter((f) => f.endsWith(".webp") && !f.endsWith("-still.webp"))
          .map((f) => ({ id: f.replace(/\.webp$/, "") }));
        return new Response(JSON.stringify({ avatars: ids }), { headers: { ...headers, "content-type": "application/json" } });
      }
      if (u.pathname.startsWith("/api/plugins/hermes-gitops/nexus/assets/avatars/")) {
        const f = path.join(AVATARS, `${decodeURIComponent(u.pathname.split("/").pop()!)}.webp`);
        if (fs.existsSync(f)) return new Response(fs.readFileSync(f), { headers: { ...headers, "content-type": "image/webp" } });
        return new Response("missing", { status: 404, headers });
      }
      if (u.pathname === "/api/plugins/hermes-gitops/nexus/workspace") {
        // The REAL wire shape: plugin_api serves an ENVELOPE, not the
        // bare doc - the store must unwrap it, and this server exists
        // to keep the acceptance suite honest about that (the first
        // factory deployment white-screened on the bare-doc assumption).
        return new Response(
          JSON.stringify({
            workspace: {
              apiVersion: "nexus.hermes.ai/v1alpha1",
              kind: "NexusWorkspace",
              environment: "acceptance",
              revision: 1,
              // Validator-shaped, as plugin_api serves it: `name` (the
              // client renders s.name), and a nested card position -
              // the browser suite must see the real card spelling.
              sheets: [
                {
                  id: "main",
                  name: "Main",
                  mode: "operational",
                  cards: [{ ref: "mkt-manager", position: { x: 180, y: 180 } }],
                  shapes: [],
                  texts: [],
                  notes: [],
                  connections: [],
                },
              ],
            },
            canWrite: true,
            ownerEnforced: false,
            role: "owner",
            subject: "acceptance",
            authMode: "header",
          }),
          { headers: { ...headers, "content-type": "application/json" } },
        );
      }
      if (u.pathname.startsWith("/api/")) {
        return new Response(JSON.stringify({ detail: "not configured" }), {
          status: 503,
          headers: { ...headers, "content-type": "application/json" },
        });
      }
      return new Response("nope", { status: 404, headers });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
