// Workspace repository bindings (`GET /nexus/workspaces`): the repo
// badge's attached half. `null` means the domain is NOT SERVED (the
// repository-links flag 404s the route, or the fetch failed) - no badge
// then, never an empty costume. `mounted: null` on a target means the
// pod list was unreadable - unknown, deliberately not false.
import { React, SDK } from "../sdk";
import { API } from "../api";
import { DEMO_BINDINGS } from "./demo";

export interface WorkspaceBinding {
  repository: string;
  source?: string;
  resolvedRevision?: string;
  mountPath?: string;
  access?: string;
  purpose?: string;
  targets?: { profile?: string; mounted?: boolean | null }[];
}

export function useWorkspaceBindings(demo: boolean, enabled: boolean): WorkspaceBinding[] | null {
  const [bindings, setBindings] = React.useState<WorkspaceBinding[] | null>(demo ? DEMO_BINDINGS : null);
  React.useEffect(() => {
    if (demo || !enabled) return;
    let dead = false;
    SDK.fetchJSON(`${API}/nexus/workspaces`).then(
      (d) => {
        if (!dead) setBindings(((d as { bindings?: WorkspaceBinding[] })?.bindings) ?? []);
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [demo, enabled]);
  return bindings;
}
