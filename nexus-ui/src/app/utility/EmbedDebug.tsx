// The framing probe (ADR-44 carried): the ONE view allowed to
// string-build URLs, because the page IS the probe. The Argo frame's
// blank is the documented correct result - the boundary made visible
// rather than folklore.
import { React } from "../../sdk";
import type { DataStore } from "../../stores/data";
import { EmptyState, Icon } from "../../primitives";
import "./utility.css";

export function EmbedDebug({ ds }: { ds: DataStore }) {
  const base = ds.data?.links?.grafanaBaseUrl;
  const argo = ds.data?.links?.argocdBaseUrl;
  const uids = [
    ...new Set(
      (ds.data?.plan?.components ?? [])
        .flatMap((c) => ((c as { instances?: { grafanaDashboardUid?: string }[] }).instances ?? []))
        .map((i) => i.grafanaDashboardUid)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
    ),
  ];
  const [uid, setUid] = React.useState<string>(uids[0] ?? "");
  if (!base) {
    return (
      <div className="nx-ut">
        <header className="nx-view-head">
          <h1 className="nx-h1">Embed debug</h1>
        </header>
        <EmptyState
          title="No Grafana base URL is configured, so there is nothing to probe."
          description="The panels the product embeds arrive fully built from the server; this page exists to diagnose the framing boundary once a base URL is configured."
        />
      </div>
    );
  }
  const src = uid ? `${base.replace(/\/$/, "")}/d/${encodeURIComponent(uid)}?kiosk` : "";
  return (
    <div className="nx-ut">
      <header className="nx-view-head">
        <h1 className="nx-h1">Embed debug</h1>
      </header>
      <div className="nx-ut-row">
        <label>
          Dashboard{" "}
          <select value={uid} onChange={(e: { target: { value: string } }) => setUid(e.target.value)}>
            {uids.map((u) => (
              <option key={u} value={u}>{u}</option>
            ))}
          </select>
        </label>
        {src ? (
          <a className="nx-ut-link" href={src} target="_blank" rel="noreferrer">open in a tab <Icon name="external" /></a>
        ) : null}
      </div>
      {src ? <iframe className="nx-ut-frame" src={src} title="Grafana probe" /> : <p className="nx-state">The plan carries no dashboard uids.</p>}
      {argo ? (
        <>
          <h2 className="nx-h2">Argo CD (a BLANK frame here is the correct result)</h2>
          <p className="nx-ut-mut">
            Argo refuses framing by policy (ADR-44); this frame exists so the refusal is visible
            rather than folklore.
          </p>
          <iframe className="nx-ut-frame nx-ut-frame-short" src={argo} title="Argo CD probe" />
        </>
      ) : null}
      <h2 className="nx-h2">Reading a blank frame</h2>
      <ol className="nx-ut-mut">
        <li>Blank Grafana + banner says blocked → the server probe already told you; fix reachability.</li>
        <li>Blank Grafana, banner quiet → your browser session lacks Grafana access (cross-site cookie posture, #300).</li>
        <li>Blank Argo → correct; Argo is never embedded.</li>
      </ol>
    </div>
  );
}
