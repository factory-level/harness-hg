// AppShell: the .nx-root boundary - stores provided here, three regions
// per the hierarchy (_docs/design/nexus-ui/hierarchy.md). Views fill in
// screen by screen; unfilled routes render an honest placeholder, and a
// withheld route renders the explicit unavailable sentinel.
import { React } from "../sdk";
import { Button, EmptyState, HoverRegistry, LayerProvider, createHoverRegistry } from "../primitives";
import { useDataStore } from "../stores/data";
import { useChromeStore } from "../stores/chrome";
import { resolveRoute } from "./routes";
import { ChromeRegion } from "./chrome/Chrome";
import { PrimitivesView } from "./PrimitivesView";
import { BackupsView } from "./backups/BackupsView";
import { AgentsView } from "./agents/AgentsView";
import { AlertRoutingView } from "./communication/AlertRoutingView";
import { SystemView } from "./system/SystemView";
import { WorkspaceView } from "./workspace/WorkspaceView";
import { AvatarGallery } from "./utility/AvatarGallery";
import { EmbedDebug } from "./utility/EmbedDebug";
import "./chrome/chrome.css";

export function AppShell() {
  const registry = React.useMemo(createHoverRegistry, []);
  const ds = useDataStore();
  const cs = useChromeStore();

  if (ds.error) {
    return (
      <div className="nx-root nx-app-root" data-nx-theme={cs.theme} data-astryx-theme="neutral" data-astryx-media={cs.theme}>
        <div className="nx-empty" role="alert">
          <EmptyState
            title="Nexus is unavailable"
            description={ds.error}
            actions={<Button label="Retry" clickAction={ds.refresh} />}
          />
        </div>
      </div>
    );
  }
  if (!ds.data) {
    return (
      <div className="nx-root nx-app-root" data-nx-theme={cs.theme} data-astryx-theme="neutral" data-astryx-media={cs.theme} aria-busy="true">
        <p className="nx-empty nx-state">Loading Nexus…</p>
      </div>
    );
  }

  const resolved = resolveRoute(cs.route, ds.data);
  return (
    <HoverRegistry.Provider value={registry}>
      <div
        className="nx-root nx-app-root"
        data-nx-theme={cs.theme}
        data-astryx-theme="neutral"
        data-astryx-media={cs.theme}
      >
        {/* The overlay region is Astryx's LayerProvider: toasts and
            layered surfaces mount here, inside the theme scope. */}
        <LayerProvider>
          <ChromeRegion ds={ds} cs={cs} view={resolved.view} />
          <main data-region="view" className="nx-view">
            {resolved.view === "backups" ? <BackupsView ds={ds} /> : resolved.view === "agents" ? <AgentsView ds={ds} sub={resolved.sub} /> : resolved.view === "communication" ? <AlertRoutingView ds={ds} cs={cs} sub={resolved.sub} /> : resolved.view === "system" ? <SystemView ds={ds} /> : resolved.view === "fleet" ? <WorkspaceView ds={ds} sub={resolved.sub} /> : resolved.view === "avatars" ? <AvatarGallery /> : resolved.view === "embed-debug" ? <EmbedDebug ds={ds} /> : <View view={resolved.view} title={resolved.title} />}
          </main>
        </LayerProvider>
      </div>
    </HoverRegistry.Provider>
  );
}

function View({ view, title }: { view: string; title: string }) {
  switch (view) {
    case "primitives":
      return <PrimitivesView />;
    case "unavailable":
      return (
        <div className="nx-empty">
          <EmptyState
            title={`${title} is switched off`}
            description="This view is withheld by deployment configuration. Nothing is being hidden that you could otherwise reach - an operator enables it through the feature overlay."
          />
        </div>
      );
    default:
      return (
        <div className="nx-empty">
          <EmptyState
            title={title}
            description="This screen arrives with its Wave-3 PR - the old UI keeps running unchanged until then."
          />
        </div>
      );
  }
}
