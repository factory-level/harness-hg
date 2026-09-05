// Alert Routing (route id stays `communication` - durable deep links):
// two dossiers under the #579 color contract, exceptions-first, every
// count truthful. The page is a projection - permanently read-only.
import { React } from "../../sdk";
import { Badge, Drawer, HealthDot, Icon, OwnershipSphere, StatusPill } from "../../primitives";
import type { HealthLevel } from "../../primitives";
import type { DataStore } from "../../stores/data";
import type { ChromeStore } from "../../stores/chrome";
import {
  destinationChips,
  fingerprint,
  firingCount,
  fullEdgesOf,
  ownerBuckets,
  partitionAlerts,
  producerStatus,
  producersOf,
  sourceState,
  statusLevel,
  type CommFiringAlert,
  type CommunicationDoc,
} from "./model";
import { Switchboard } from "./Switchboard";
import "./communication.css";


// The doc fetch lives in stores/comm now - the canvas badge layer
// shares it.
import { useCommDoc } from "../../stores/comm";

export function AlertRoutingView({ ds, cs, sub }: { ds: DataStore; cs: ChromeStore; sub: string | null }) {
  const doc = useCommDoc(ds.data?.demo === true);
  const [dossier, setDossier] = React.useState<"alarms" | "events">("alarms");
  const [platformOpen, setPlatformOpen] = React.useState(false);
  const [allOpen, setAllOpen] = React.useState(false);
  const [drawerFp, setDrawerFp] = React.useState<string | null>(null);

  // The ops-pill handoff: a fingerprint arrives via ChromeStore and opens
  // the drawer immediately; platform-group expansion follows the doc.
  React.useEffect(() => {
    if (cs.opsAlert !== null) {
      setDrawerFp(cs.opsAlert);
      cs.handoffAlert(null);
    }
  }, [cs.opsAlert, cs]);
  React.useEffect(() => {
    if (drawerFp && doc) {
      const { platform } = partitionAlerts(doc.alerts);
      if (platform.some((a) => fingerprint(a).startsWith(drawerFp) || `${a.name}:${a.namespace}` === drawerFp)) {
        setPlatformOpen(true);
      }
    }
  }, [drawerFp, doc]);

  if (!doc) return <div className="nx-comm" aria-busy="true"><p className="nx-state">Loading…</p></div>;

  const { business, platform } = partitionAlerts(doc.alerts);
  const drawerAlert =
    drawerFp === null
      ? null
      : [...business, ...platform].find(
          (a) => fingerprint(a) === drawerFp || `${a.name}:${a.namespace}` === drawerFp,
        ) ?? null;

  // Sources are objects ({family, state, detail}) on the live endpoint
  // and bare strings on older payloads - sourceState reads both.
  const staleSources = Object.entries(doc.provenance?.sources ?? {}).filter(([, s]) => sourceState(s) !== "ok");

  if (sub) {
    return <Switchboard doc={doc} sub={sub} demo={ds.data?.demo === true} />;
  }

  return (
    <div className="nx-comm">
      <header className="nx-view-head">
        <div className="nx-view-title">
          <h1 className="nx-h1">Alert Routing</h1>
          <span className="nx-comm-ro">Read-only</span>
          <span className="nx-comm-prov">
            observed {doc.provenance?.observedAt ?? "now"}
            {staleSources.length === 0
              ? " · all sources current"
              : staleSources.map(([k, s]) => ` · ${k}: ${sourceState(s)}`).join("")}
          </span>
        </div>
      </header>
      <div className="nx-comm-dossiers" role="tablist" aria-label="Dossiers">
        <button
          type="button"
          role="tab"
          aria-selected={dossier === "alarms"}
          className={`nx-dtab nx-dtab-alarms ${business.length + platform.length > 0 ? "nx-dtab-firing" : "nx-dtab-rest"}`}
          onClick={() => setDossier("alarms")}
        >
          Alarms
          <span className="nx-dtab-state">
            {doc.alerts?.configured === false
              ? "not configured"
              : business.length + platform.length > 0
                ? `${firingCount(doc.alerts)} firing`
                : "quiet"}
          </span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={dossier === "events"}
          className="nx-dtab nx-dtab-events"
          onClick={() => setDossier("events")}
        >
          Events
          <span className="nx-dtab-state">{doc.edges.length} routes</span>
        </button>
      </div>

      {dossier === "alarms" ? (
        <section className="nx-dossier" aria-label="Alarms">
          <h2 className="nx-h3 nx-comm-secthead">
            Firing alarms · {firingCount(doc.alerts)}
            {doc.alerts?.unreadable ? (
              <span className="nx-comm-partial"> — evaluators that answered; not an all-clear</span>
            ) : null}
          </h2>
          {business.map((a) => (
            <AlertRow key={fingerprint(a)} a={a} onOpen={() => setDrawerFp(fingerprint(a))} />
          ))}
          {platform.length > 0 ? (
            <div>
              <button type="button" className="nx-comm-disclose" aria-expanded={platformOpen} onClick={() => setPlatformOpen((x) => !x)}>
                {platform.length} platform alert{platform.length === 1 ? "" : "s"} firing
                {platform[0]?.since ? ` · oldest ${platform[0].since}` : ""} <Icon name={platformOpen ? "chevron-down" : "chevron-right"} />
              </button>
              {platformOpen
                ? platform.map((a) => <AlertRow key={fingerprint(a)} a={a} onOpen={() => setDrawerFp(fingerprint(a))} />)
                : null}
            </div>
          ) : null}
          {business.length === 0 && platform.length === 0 ? (
            <p className="nx-state">
              {doc.alerts?.configured ? "Nothing firing — both evaluators answered all-clear." : "Alerting is not configured for this deployment."}
            </p>
          ) : null}
          <button type="button" className="nx-comm-disclose nx-eyebrow" aria-expanded={allOpen} onClick={() => setAllOpen((x) => !x)}>
            All alarms <Icon name={allOpen ? "chevron-down" : "chevron-right"} />
          </button>
          {allOpen ? (
            ownerBuckets(doc.edges.filter((e) => e.alarmClass)).map((b) => (
              <div key={b.id} className="nx-comm-bucket">
                <h3 className="nx-comm-buckethead">
                  {b.controlPlane ? <OwnershipSphere /> : null} {b.title}
                </h3>
                {producersOf({ ...doc, edges: b.items }).map((p) => (
                  <SourceRow key={p} doc={doc} producer={p} slice={b.items.filter((e) => e.producer === p)} />
                ))}
              </div>
            ))
          ) : null}
        </section>
      ) : (
        <section className="nx-dossier" aria-label="Events">
          {ownerBuckets(doc.edges.filter((e) => !e.alarmClass)).map((b) => (
            <div key={b.id} className="nx-comm-bucket">
              <h3 className="nx-comm-buckethead">
                {b.controlPlane ? <OwnershipSphere /> : null} {b.title}
              </h3>
              {producersOf({ ...doc, edges: b.items }).map((p) => (
                <SourceRow key={p} doc={doc} producer={p} slice={b.items.filter((e) => e.producer === p)} />
              ))}
            </div>
          ))}
          {doc.impliedEvents?.length ? (
            <div className="nx-comm-bucket">
              <h3 className="nx-comm-buckethead">Reserved platform events</h3>
              {doc.impliedEvents.map((ev) => (
                <div key={ev.event} className="nx-src-row nx-src-static">
                  <span className="nx-src-name">{ev.event}</span>
                  <span className="nx-comm-mut">{ev.note ?? "implied broadcast"}</span>
                  <Badge label="Reserved" />
                </div>
              ))}
            </div>
          ) : null}
          {doc.externalInputs?.length ? (
            <div className="nx-comm-bucket">
              <h3 className="nx-comm-buckethead">Inbound webhooks</h3>
              {doc.externalInputs.map((w) => (
                <a key={w.id} className="nx-src-row" href={`#/communication/${encodeURIComponent(`in:${w.id}`)}`}>
                  <span className="nx-src-name"><Icon name="arrow-left" /> {w.id}</span>
                  <span className="nx-comm-mut">{w.event ?? ""}{w.event && (w.accepts ?? []).length ? " · " : ""}{(w.accepts ?? []).join(", ") || (w.event ? "" : "any kind")}</span>
                  {w.verification ? <Badge label="Signed" /> : null}
                  <span className="nx-comm-mut"><Icon name="chevron-right" /></span>
                </a>
              ))}
            </div>
          ) : (
            <p className="nx-state">No inbound webhooks — declare them under communication.externalInputs.</p>
          )}
        </section>
      )}

      <Drawer
        open={drawerFp !== null}
        onClose={() => setDrawerFp(null)}
        title={drawerAlert?.name ?? "Alert"}
        subtitle={drawerAlert?.namespace}
      >
        {drawerAlert ? <AlertEvidence a={drawerAlert} /> : (
          <p>No longer observed — this alert's fingerprint no longer resolves in the served document.</p>
        )}
      </Drawer>
    </div>
  );
}

function AlertRow({ a, onOpen }: { a: CommFiringAlert; onOpen: () => void }) {
  return (
    <button type="button" className="nx-alert-row" onClick={onOpen}>
      <HealthDot level={a.severity === "critical" ? "unhealthy" : "degraded"} small />
      <span className="nx-alert-dir"><Icon name="arrow-right" /></span>
      <span className="nx-alert-name">{a.name}</span>
      <span className="nx-comm-mut">{a.namespace}</span>
      {a.signal === "business" ? <Badge label="business" /> : null}
      {a.ownership === "control-plane" ? <OwnershipSphere /> : null}
      <span className="nx-comm-mut nx-alert-since">{a.since ?? ""}</span>
    </button>
  );
}

function AlertEvidence({ a }: { a: CommFiringAlert }) {
  return (
    <dl className="nx-facts">
      <dt>Severity</dt>
      <dd><StatusPill level={(a.severity === "critical" ? "unhealthy" : "degraded") as HealthLevel}>{a.severity ?? "unstated"}</StatusPill></dd>
      <dt>Summary</dt>
      <dd>{a.summary ?? a.annotations?.["summary"] ?? "—"}</dd>
      <dt>First observed</dt>
      <dd>{a.since ?? "unstated"}</dd>
      <dt>Evaluation value</dt>
      <dd>{a.value ?? "—"}</dd>
      <dt>Labels</dt>
      <dd>
        {Object.entries(a.labels ?? {}).map(([k, v]) => (
          <code key={k} className="nx-comm-label">{k}={v}</code>
        ))}
        {Object.keys(a.labels ?? {}).length === 0 ? "none carried" : null}
      </dd>
      {a.grafanaUrl ? (
        <>
          <dt>Source</dt>
          <dd><a className="nx-comm-link" href={a.grafanaUrl} target="_blank" rel="noreferrer">Open in Grafana alerting <Icon name="external" /></a></dd>
        </>
      ) : null}
    </dl>
  );
}

function SourceRow({ doc, producer, slice }: { doc: CommunicationDoc; producer: string; slice: ReturnType<typeof fullEdgesOf> }) {
  const status = producerStatus(doc, producer); // FULL edge set, never the slice
  const { shown, more } = destinationChips(slice);
  const level: HealthLevel = statusLevel(status);
  return (
    <a className="nx-src-row" href={`#/communication/${encodeURIComponent(producer)}`}>
      <span className="nx-src-name">{producer}</span>
      <span className="nx-src-dests">
        {shown.map((d) => (
          <Badge key={d} label={d} />
        ))}
        {more > 0 ? <span className="nx-comm-mut">+{more}</span> : null}
      </span>
      <StatusPill level={level}>{status === "declared" ? "No traffic yet" : status}</StatusPill>
      <span className="nx-comm-mut"><Icon name="chevron-right" /></span>
    </a>
  );
}
