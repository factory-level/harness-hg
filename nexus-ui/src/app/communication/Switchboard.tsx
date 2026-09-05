// The patch-bay switchboard (ADR 0180): the detail view of ONE event -
// an inbound unified webhook or an outbound abstracted event. Three
// zones: sources left, the router spine center, consumers right, with
// drawn cables between them. Cable geometry is index math on the fixed
// row height - the SVG cells are ordinary in-flow grid children, so the
// style gates (no positioning outside primitives) hold.
import { React } from "../../sdk";
import { HealthDot, Icon, StatusPill } from "../../primitives";
import type { HealthLevel } from "../../primitives";
import { useCommHistory } from "../../stores/comm";
import {
  PATCH_ROW_H,
  executionSplit,
  parseCommSub,
  receiptOutcome,
  resolveSwitchboard,
  type CommExecutionConsumer,
  type CommHistoryDoc,
  type CommunicationDoc,
  type SwitchboardModel,
  type SwitchboardRow,
} from "./model";

export function Switchboard({ doc, sub, demo }: { doc: CommunicationDoc; sub: string; demo: boolean }) {
  const model = resolveSwitchboard(doc, sub);
  if (!model) {
    const subject = parseCommSub(sub);
    return (
      <div className="nx-comm">
        <a className="nx-back" href="#/communication"><Icon name="chevron-left" /> All routing</a>
        <p className="nx-state">
          {subject.kind === "inbound"
            ? `No inbound webhook "${subject.id}" in the served document - the link may predate a declaration change.`
            : `No routes from "${subject.producer}" in the served document - the link may predate a declaration change.`}
        </p>
      </div>
    );
  }
  return (
    <div className="nx-comm">
      <a className="nx-back" href="#/communication"><Icon name="chevron-left" /> All routing</a>
      <header className="nx-view-head">
        <div className="nx-view-title">
          <h1 className="nx-h1">{model.title}</h1>
          <span className="nx-comm-ro">{model.subject.kind === "inbound" ? "Inbound webhook" : "Outbound event"}</span>
        </div>
      </header>
      <Board model={model} />
      <PulseSection demo={demo} />
    </div>
  );
}

function Board({ model }: { model: SwitchboardModel }) {
  // The board's geometry rows: at least 3 so the spine card (taller than
  // one row) never stretches the grid past the cable canvas - the SVG's
  // height IS the row grid, and the spine centers inside the same frame.
  const maxRows = Math.max(model.inbound.length, model.outbound.length, 3);
  return (
    <div
      className="nx-switch-board"
      style={{ "--nx-patch-row": `${PATCH_ROW_H}px`, "--nx-patch-rows": maxRows } as React.CSSProperties}
    >
      <span className="nx-switch-eyebrow nx-switch-eyebrow-in">Inbound</span>
      <span className="nx-switch-eyebrow nx-switch-eyebrow-router">Router</span>
      <span className="nx-switch-eyebrow nx-switch-eyebrow-out">Outbound</span>
      <div className="nx-switch-zone nx-switch-zone-in">
        {model.inbound.map((r) => <ZoneRow key={r.id} row={r} side="in" />)}
      </div>
      <CableLayer rows={model.inbound} maxRows={maxRows} side="in" />
      <div className="nx-switch-spinecell">
        <SpineCard model={model} />
      </div>
      <CableLayer rows={model.outbound} maxRows={maxRows} side="out" />
      <div className="nx-switch-zone nx-switch-zone-out">
        {model.outbound.map((r) => <ZoneRow key={r.id} row={r} side="out" />)}
      </div>
    </div>
  );
}

function ZoneRow({ row, side }: { row: SwitchboardRow; side: "in" | "out" }) {
  return (
    <div className={`nx-switch-row ${row.synthetic ? "nx-switch-row-synthetic" : ""}`}>
      <span className="nx-switch-jack" data-level={row.level} aria-hidden="true" />
      <span className="nx-switch-rowbody">
        <span className="nx-switch-rowname" title={row.label}>
          {side === "out" && row.external ? <Icon name="external" /> : null}
          {row.label}
        </span>
        {row.detail ? <span className="nx-switch-rowdetail" title={row.liveLine ? `${row.detail} · ${row.liveLine}` : row.detail}>{row.detail}</span> : null}
      </span>
      {row.outcome ? (
        <span className={`nx-switch-outcome nx-switch-outcome-${row.outcome}`}>{row.outcome}</span>
      ) : null}
      <StatusPill level={row.level as HealthLevel}>{row.status === "declared" ? "No traffic yet" : row.status}</StatusPill>
    </div>
  );
}

/** One in-flow SVG per side. The viewBox height is the row grid in px
 * (maxRows * PATCH_ROW_H) so a row's center is pure index math; the
 * x-axis is a 0-100 abstract span stretched to the cell. */
function CableLayer({ rows, maxRows, side }: { rows: SwitchboardRow[]; maxRows: number; side: "in" | "out" }) {
  const h = maxRows * PATCH_ROW_H;
  const spineY = h / 2;
  return (
    <svg
      className="nx-switch-cables"
      viewBox={`0 0 100 ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {rows.map((r, i) => {
        const rowY = i * PATCH_ROW_H + PATCH_ROW_H / 2;
        const d = side === "in"
          ? `M 0 ${rowY} C 55 ${rowY}, 45 ${spineY}, 100 ${spineY}`
          : `M 0 ${spineY} C 55 ${spineY}, 45 ${rowY}, 100 ${rowY}`;
        return (
          <path
            key={r.id}
            d={d}
            className={`nx-switch-cable nx-switch-cable-${cableTone(r)}`}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
    </svg>
  );
}

function cableTone(r: SwitchboardRow): string {
  if (r.synthetic || r.status === "declared") return "declared";
  if (r.level === "unhealthy" || r.outcome === "failed") return "failed";
  if (r.level === "degraded") return "degraded";
  return "live";
}

function SpineCard({ model }: { model: SwitchboardModel }) {
  const { spine } = model;
  const exec = spine.execution;
  // The split is recomputed from the receipts (the SERVED counts flatten
  // queued into delivered - see executionSplit).
  const split = exec ? executionSplit(exec) : null;
  return (
    <div className="nx-switch-spine">
      <span className="nx-switch-spinelamp">
        <HealthDot level={spine.level as HealthLevel} />
      </span>
      <span className="nx-switch-spinename">router</span>
      <StatusPill level={spine.level as HealthLevel}>{spine.status === "declared" ? "No traffic yet" : spine.status}</StatusPill>
      <span className="nx-switch-spinecounts">dlq {spine.dlq} · pending {spine.pending}</span>
      {exec && split ? (
        <span className="nx-switch-spineexec" title={`correlation ${exec.correlationId}`}>
          last fan-out: {split.delivered}/{split.total} delivered
          {split.pending > 0 ? ` · ${split.pending} pending` : ""}
          {exec.observedAt ? ` · ${exec.observedAt}` : ""}
        </span>
      ) : null}
    </div>
  );
}

// ---- Recent activity: the delivery pulse + receipts trail ------------

const WINDOWS = ["1h", "24h", "7d"] as const;

function PulseSection({ demo }: { demo: boolean }) {
  const [window, setWindow] = React.useState<(typeof WINDOWS)[number]>("24h");
  const history = useCommHistory(demo, window);
  return (
    <section className="nx-switch-activity" aria-label="Recent activity">
      <div className="nx-switch-activityhead">
        <h2 className="nx-h3 nx-comm-secthead">Recent activity</h2>
        <div className="nx-switch-windows" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className="nx-switch-window"
              aria-pressed={window === w}
              onClick={() => setWindow(w)}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      {history ? <PulseStrip history={history} /> : <p className="nx-state">No history available — the history endpoint did not answer.</p>}
    </section>
  );
}

function PulseStrip({ history }: { history: CommHistoryDoc }) {
  const buckets = history.pulse?.buckets ?? [];
  const pulseState = history.pulse?.state ?? "unknown";
  const peak = Math.max(1, ...buckets.map((b) => b.delivered + b.failed));
  const receipts = history.receipts?.entries ?? [];
  const receiptsState = history.receipts?.state ?? "unknown";
  const groups = groupReceipts(receipts).slice(0, 5);
  return (
    <>
      {pulseState === "ok" && buckets.length > 0 ? (
        <svg className="nx-switch-pulse" viewBox={`0 0 ${buckets.length * 4} 40`} preserveAspectRatio="none" role="img" aria-label="Delivery pulse">
          {buckets.map((b, i) => {
            const dh = (b.delivered / peak) * 38;
            const fh = (b.failed / peak) * 38;
            return (
              <g key={b.at ?? i}>
                {dh > 0 ? <rect className="nx-switch-bar-delivered" x={i * 4} y={40 - dh} width={3} height={dh} /> : null}
                {fh > 0 ? <rect className="nx-switch-bar-failed" x={i * 4} y={40 - dh - fh} width={3} height={fh} /> : null}
              </g>
            );
          })}
        </svg>
      ) : (
        <p className="nx-state">Pulse: {pulseState === "ok" ? "no activity in this window" : pulseState}</p>
      )}
      <h3 className="nx-switch-receiptshead">
        Receipts
        <span className="nx-comm-mut"> · {history.receipts?.truthfulWindow ?? "window unstated"}</span>
      </h3>
      {receiptsState !== "ok" ? (
        <p className="nx-state">Receipts: {receiptsState}</p>
      ) : groups.length === 0 ? (
        <p className="nx-state">No receipts recorded since the router started.</p>
      ) : (
        groups.map((g) => (
          <div key={g.correlationId} className="nx-switch-receiptgroup">
            <span className="nx-switch-corr" title={g.correlationId}>{g.correlationId}</span>
            {g.entries.map((r, i) => (
              <span key={`${r.edge}:${i}`} className={`nx-switch-receipt nx-switch-receipt-${receiptOutcome(r.status)}`}>
                {r.edge} · {r.status ?? "recorded"}{r.at ? ` · ${r.at}` : ""}
              </span>
            ))}
          </div>
        ))
      )}
    </>
  );
}

function groupReceipts(entries: CommExecutionConsumer[]) {
  const byId = new Map<string, CommExecutionConsumer[]>();
  const order: string[] = [];
  for (const r of entries) {
    const id = r.correlationId ?? "uncorrelated";
    if (!byId.has(id)) {
      byId.set(id, []);
      order.push(id);
    }
    byId.get(id)!.push(r);
  }
  // Entries arrive oldest-first; the trail reads newest-first.
  return order.reverse().map((correlationId) => ({ correlationId, entries: byId.get(correlationId)! }));
}
