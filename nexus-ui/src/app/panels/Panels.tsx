// Grafana embeds: server-built allowlisted URLs only (the browser never
// concatenates one), closed size presets with same-box placeholders,
// "Open in Grafana" on EVERY frame including failures, one blocked
// signal shared by banner and frames - and the #706 PlaneBadge on every
// frame, rendered from the SERVED plane (ADR 0166's Nexus half).
import { React, SDK } from "../../sdk";
import { API } from "../../api";
import { Icon, OwnershipSphere } from "../../primitives";
import { DEMO_PANELS } from "../../stores/demo";
import "./panels.css";

export interface ServedPanel {
  id: string;
  title: string;
  size: "compact" | "standard" | "wide" | "tall";
  plane?: "control-plane" | "workload";
  status: string;
  reason?: string;
  embedUrl?: string;
  openUrl?: string;
  contextual?: boolean;
}
export interface SurfacePanels {
  surface: string;
  status: string;
  reason?: string;
  panels: ServedPanel[];
  grafana?: { state?: string; detail?: string };
}


const HEIGHT: Record<ServedPanel["size"], number> = {
  compact: 180,
  standard: 260,
  tall: 420,
  wide: 300,
};

export function usePanels(surface: string, component: string | null, theme: string, demo: boolean): SurfacePanels | null {
  const [doc, setDoc] = React.useState<SurfacePanels | null>(demo ? DEMO_PANELS : null);
  React.useEffect(() => {
    if (demo) return;
    let dead = false;
    const q = new URLSearchParams({ surface, theme });
    if (component) q.set("component", component);
    SDK.fetchJSON(`${API}/nexus/panels?${q}`).then(
      (d) => {
        if (!dead) setDoc(d as SurfacePanels);
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [surface, component, theme, demo]);
  return doc;
}

export function PlaneBadge({ plane }: { plane?: string }) {
  if (!plane) return null;
  return (
    <span className={`nx-planebadge nx-planebadge-${plane}`}>
      {plane === "control-plane" ? <OwnershipSphere /> : null}
      {plane === "control-plane" ? "Control Plane" : "Workloads"}
    </span>
  );
}

export function PanelFrame({ p, blocked }: { p: ServedPanel; blocked: string | null }) {
  return (
    <figure className={`nx-panel nx-panel-${p.size}`}>
      <figcaption className="nx-panel-head">
        <span className="nx-panel-title">{p.title}</span>
        <PlaneBadge plane={p.plane} />
        {p.openUrl ? (
          <a className="nx-panel-open" href={p.openUrl} target="_blank" rel="noreferrer">
            Open in Grafana <Icon name="external" />
          </a>
        ) : null}
      </figcaption>
      <div className="nx-panel-body" style={{ blockSize: HEIGHT[p.size] }}>
        {p.status !== "configured" ? (
          <p className="nx-state">{p.reason ?? p.status}</p>
        ) : blocked ? (
          <p className="nx-state">Grafana is {blocked} — the frame is not attempted.</p>
        ) : (
          <>
            <p className="nx-state">Loading panel…</p>
            <iframe className="nx-panel-iframe" src={p.embedUrl} title={p.title} loading="lazy" referrerPolicy="no-referrer" />
          </>
        )}
      </div>
    </figure>
  );
}

export function PanelGrid({ surface, component, theme, demo }: { surface: string; component: string | null; theme: string; demo: boolean }) {
  const doc = usePanels(surface, component, theme, demo);
  if (!doc) return <p className="nx-state">Loading panels…</p>;
  if (doc.status !== "configured" && doc.panels.length === 0) {
    return <p className="nx-state">{doc.reason ?? "Panels are not configured for this deployment."}</p>;
  }
  const blocked = doc.grafana && doc.grafana.state && doc.grafana.state !== "ok" ? doc.grafana.state : null;
  return (
    <div>
      {blocked ? (
        <p className="nx-panel-banner">
          Grafana looks {blocked}
          {doc.grafana?.detail ? ` — ${doc.grafana.detail}` : ""}. Every frame below shows its state instead of
          a blank.
        </p>
      ) : null}
      <div className="nx-panel-grid">
        {doc.panels.filter((p) => !p.contextual).map((p) => (
          <PanelFrame key={p.id} p={p} blocked={blocked} />
        ))}
      </div>
    </div>
  );
}
