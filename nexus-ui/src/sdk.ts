// The one place the host SDK globals are touched (design 11, ADR-42).
// React is the HOST's instance - never bundle one - and every network call
// goes through SDK.fetchJSON, the sanctioned auth surface (a Hermes
// contract test fails any plugin bundle that reads the session token
// directly). The classic JSX factory in vite.config.ts resolves `React`
// from this module in every .tsx file.

interface HermesPluginSdk {
  sdkVersion: string;
  React: typeof import("react");
  fetchJSON: (path: string, init?: RequestInit) => Promise<unknown>;
  utils?: { cn?: (...args: unknown[]) => string };
}

declare global {
  interface Window {
    __HERMES_PLUGIN_SDK__?: HermesPluginSdk;
    __HERMES_PLUGINS__?: {
      register: (name: string, component: unknown) => void;
    };
  }
}

// Loaded via <script> by the dashboard shell, so the SDK global is present
// before this bundle evaluates; globalThis (not bare window) keeps a
// module import from throwing where no window exists (bun test).
const host = globalThis as unknown as Window;
export const SDK = host.__HERMES_PLUGIN_SDK__ as HermesPluginSdk;
export const React = SDK?.React as typeof import("react");
