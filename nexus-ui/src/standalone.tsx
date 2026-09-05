// The standalone host shell (ADR-48 shape, carried from dashboard/):
// bundles its OWN React, provides fetchJSON over same-origin fetch, and
// loads the plugin IIFE only AFTER the globals exist.
import * as React from "react";
import { createRoot } from "react-dom/client";

const w = window as unknown as {
  __HERMES_PLUGIN_SDK__?: unknown;
  __HERMES_PLUGINS__?: { register: (name: string, component: unknown) => void };
};

w.__HERMES_PLUGIN_SDK__ = {
  sdkVersion: "nexus-ui-standalone-1",
  React,
  fetchJSON: async (path: string, init?: RequestInit): Promise<unknown> => {
    const r = await fetch(path, init);
    const text = await r.text();
    if (!r.ok) {
      let detail = "";
      try {
        detail = String((JSON.parse(text) as { detail?: unknown })?.detail ?? "");
      } catch {
        // not JSON: the status line is all there is
      }
      // The numeric status rides the error as a field - string matching
      // on the message is the fallback, not the contract.
      throw Object.assign(new Error(detail ? `${r.status} ${r.statusText}: ${detail}` : `${r.status} ${r.statusText}`), { status: r.status });
    }
    return text ? (JSON.parse(text) as unknown) : null;
  },
};

w.__HERMES_PLUGINS__ = {
  register: (_name: string, component: unknown) => {
    const Comp = component as React.ComponentType;
    createRoot(document.getElementById("nexus-root")!).render(React.createElement(Comp));
  },
};

const root = document.getElementById("nexus-root")!;
const version = root.dataset["distVersion"];
const s = document.createElement("script");
s.src = version ? `/dist/index.js?v=${encodeURIComponent(version)}` : "/dist/index.js";
document.head.appendChild(s);
