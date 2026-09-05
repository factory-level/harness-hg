// Entry: register the rebuilt Nexus page with the host synchronously (the
// IIFE evaluates after the SDK globals exist - ADR-42). During the
// rebuild this is the AppShell skeleton; screens land per the hierarchy
// (_docs/design/nexus-ui/hierarchy.md) one PR at a time.
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./theme/theme.css";
import { SDK } from "./sdk";
import { AppShell } from "./app/AppShell";

const host = globalThis as unknown as Window;
if (host.__HERMES_PLUGINS__ && SDK) {
  host.__HERMES_PLUGINS__.register("hermes-gitops", AppShell);
}
