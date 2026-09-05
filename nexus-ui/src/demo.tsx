// The static demo shell: the standalone host (src/standalone.tsx) with no
// backend at all. `make site` publishes it at /demo/ on the Pages artifact.
// Every API call answers the not-configured 503, which is the one signal
// stores/data.ts substitutes DEMO_DATA for; the avatar library is the
// exception and is served from files under ./api/ so the gallery and the
// card marks render real images. Paths are relative to the page, never
// root-absolute: the site lives under /harness-hg/ on GitHub Pages.
import * as React from "react";
import { createRoot } from "react-dom/client";

const w = window as unknown as {
  __HG_API_BASE__?: string;
  __HERMES_PLUGIN_SDK__?: unknown;
  __HERMES_PLUGINS__?: { register: (name: string, component: unknown) => void };
};

// Read by src/api.ts before the plugin bundle evaluates.
w.__HG_API_BASE__ = "api";

const AVATAR_LIST = "api/nexus/assets/avatars";

w.__HERMES_PLUGIN_SDK__ = {
  sdkVersion: "nexus-ui-demo-1",
  React,
  fetchJSON: async (path: string): Promise<unknown> => {
    if (path === AVATAR_LIST) {
      const r = await fetch(`${AVATAR_LIST}.json`);
      return r.ok ? ((await r.json()) as unknown) : { avatars: [] };
    }
    throw Object.assign(new Error("503 Service Unavailable: not configured"), { status: 503 });
  },
};

w.__HERMES_PLUGINS__ = {
  register: (_name: string, component: unknown) => {
    const Comp = component as React.ComponentType;
    createRoot(document.getElementById("nexus-root")!).render(React.createElement(Comp));
  },
};

const s = document.createElement("script");
s.src = "index.js";
document.head.appendChild(s);
