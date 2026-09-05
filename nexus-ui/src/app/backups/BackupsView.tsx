// Backups: answer-first, exception-first (#553/#582/#418/#419). Fixed
// shell - the head is static, only the shelf list scrolls; the drawer
// resolves its routine against the CURRENT doc every render and shows an
// explicit gone-state when the poll drops it.
import { React, SDK } from "../../sdk";
import { API } from "../../api";
import { Drawer, HealthDot, Icon, StatusPill } from "../../primitives";
import type { HealthLevel } from "../../primitives";
import { DEMO_BACKUPS } from "../../stores/demo";
import type { DataStore } from "../../stores/data";
import {
  ARTIFACT_PILL,
  SCHEDULE_PILL,
  cronProse,
  destinationProse,
  rowStatus,
  shelfLevel,
  shelves,
  verdict,
  type BackupsDoc,
} from "./model";
import "./backups.css";

const POLL_MS = 30_000;

function useBackupsDoc(demo: boolean): { doc: BackupsDoc | null; error: string | null } {
  const [doc, setDoc] = React.useState<BackupsDoc | null>(demo ? DEMO_BACKUPS : null);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (demo) return;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const d = (await SDK.fetchJSON(`${API}/nexus/backups`)) as BackupsDoc;
        if (!dead) {
          setDoc(d);
          setError(null);
        }
      } catch (e) {
        if (!dead) setError(String(e)); // last-good doc stays rendered
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, [demo]);
  return { doc, error };
}

export function BackupsView({ ds }: { ds: DataStore }) {
  const { doc, error } = useBackupsDoc(ds.data?.demo === true);
  const [showAll, setShowAll] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [openShelves, setOpenShelves] = React.useState<ReadonlySet<string>>(new Set());
  const [drawerId, setDrawerId] = React.useState<string | null>(null);

  if (!doc) {
    return (
      <div className="nx-backups" aria-busy="true">
        <p className={error ? "nx-state nx-state-error" : "nx-state"}>{error ? `Backups unavailable: ${error}` : "Loading…"}</p>
      </div>
    );
  }

  const v = verdict(doc);
  const q = filter.trim().toLowerCase();
  const matches = (hay: (string | undefined)[]) => !q || hay.some((h) => h?.toLowerCase().includes(q));
  const allShelves = shelves(doc);
  const total = doc.routines.length + doc.unprotected.length;
  const shown = allShelves
    .map((s) => ({
      ...s,
      routines: s.routines.filter((r) => matches([r.title, r.componentTitle, r.component, r.namespace])),
      uncovered: s.uncovered.filter((u) => matches([u.title, u.id])),
    }))
    .filter((s) => s.routines.length + s.uncovered.length > 0);
  const matching = shown.reduce((n, s) => n + s.routines.length + s.uncovered.length, 0);

  const drawerRoutine = drawerId ? doc.routines.find((r) => r.id === drawerId) ?? null : null;

  return (
    <div className="nx-backups">
      <header className="nx-view-head">
        <h1 className="nx-h1">Backups</h1>
        <p className={`nx-bk-verdict nx-bk-verdict-${v.level}`}>{v.text}</p>
        <div className="nx-bk-controls">
          <button type="button" className="nx-chip" aria-pressed={showAll} onClick={() => setShowAll((x) => !x)}>
            {showAll ? "Fold healthy" : "Show all"}
          </button>
          <input
            className="nx-field"
            placeholder="Filter targets"
            value={filter}
            onChange={(e: { target: { value: string } }) => setFilter(e.target.value)}
            aria-label="Filter targets"
          />
          {q ? <span className="nx-bk-count">MATCHING TARGETS {matching} of {total}</span> : null}
        </div>
      </header>
      <div className="nx-bk-scroll">
        {shown.map((s) => {
          const level = shelfLevel(s) as HealthLevel;
          const needsAttention = ["degraded", "unhealthy", "unknown"].includes(level);
          const open = openShelves.has(s.id) || showAll || q.length > 0;
          const uncoveredNote = s.uncovered.length ? ` · ${s.uncovered.length} not covered` : "";
          return (
            <section key={s.id} className="nx-shell nx-bk-shelf">
              <button
                type="button"
                className="nx-bk-shelfhead"
                aria-expanded={open}
                onClick={() =>
                  setOpenShelves((prev) => {
                    const next = new Set(prev);
                    if (next.has(s.id)) next.delete(s.id);
                    else next.add(s.id);
                    return next;
                  })
                }
              >
                <HealthDot level={level} small />
                <span className="nx-bk-shelfname">{s.title}</span>
                <span className="nx-bk-shelfmeta">
                  {s.routines.length} routine{s.routines.length === 1 ? "" : "s"}
                  {uncoveredNote}
                  {needsAttention && !s.uncovered.length ? " · needs attention" : ""}
                </span>
                <span className={`nx-bk-chevron${open ? " nx-bk-chevron-open" : ""}`}><Icon name="chevron-right" /></span>
              </button>
              {open ? (
                <div>
                  {s.routines.map((r) => {
                    const st = rowStatus(r);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className="nx-bk-row"
                        onClick={() => setDrawerId(r.id)}
                      >
                        <HealthDot level={st.level as HealthLevel} small />
                        <span className="nx-bk-name">
                          {r.title}
                          {r.componentTitle && r.componentTitle !== r.title ? (
                            <code className="nx-bk-code">{r.componentTitle}</code>
                          ) : null}
                        </span>
                        <span className="nx-bk-cron">{cronProse(r.schedule)}</span>
                        <span className="nx-bk-last">
                          {r.lastSuccess ? `last success ${r.lastSuccess}` : "no success recorded"}
                          {r.reason ? ` · ${r.reason}` : ""}
                        </span>
                        <span className="nx-bk-status">{st.word}</span>
                        <span className="nx-bk-chevron"><Icon name="chevron-right" /></span>
                      </button>
                    );
                  })}
                  {s.uncovered.map((u) => (
                    <div key={u.id} className="nx-bk-row nx-bk-row-uncovered">
                      <HealthDot level={(u.level as HealthLevel) || "degraded"} small />
                      <span className="nx-bk-name">{u.title}</span>
                      <span className="nx-bk-cron" />
                      <span className="nx-bk-last">{u.reason ?? "no routine declares this component"}</span>
                      <span className="nx-bk-status">No backup</span>
                      <span />
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          );
        })}
        <p className="nx-state">
          The routine is the unit of protection. Observed {doc.observedAt ?? "now"} · restore with{" "}
          <code>hg platform backup restore</code>.
        </p>
      </div>
      <Drawer
        open={drawerId !== null}
        onClose={() => setDrawerId(null)}
        title={drawerRoutine?.title ?? "Routine"}
        subtitle={drawerRoutine ? drawerRoutine.namespace : undefined}
      >
        {drawerRoutine ? <RoutineFacts r={drawerRoutine} /> : (
          <p>
            This routine is no longer in the served document — it may have been removed since the
            last poll.
          </p>
        )}
      </Drawer>
    </div>
  );
}

function RoutineFacts({ r }: { r: ReturnType<typeof pickRoutine> }) {
  const sched = SCHEDULE_PILL[r.state] ?? { word: r.state, level: "unknown" };
  const art = ARTIFACT_PILL[r.artifact?.state ?? "unmeasured"] ?? { word: "Unmeasured", level: "unknown" };
  return (
    <dl className="nx-facts">
      <dt>Schedule</dt>
      <dd>
        {cronProse(r.schedule)} {r.schedule ? <code className="nx-bk-code">{r.schedule}</code> : null}
      </dd>
      <dt>Schedule health</dt>
      <dd><StatusPill level={sched.level as never}>{sched.word}</StatusPill></dd>
      <dt>Artifact</dt>
      <dd><StatusPill level={art.level as never}>{art.word}</StatusPill></dd>
      <dt>Retention</dt>
      <dd>{r.retention ?? "unstated"}</dd>
      <dt>Destination</dt>
      <dd>{destinationProse(r.destination)}</dd>
      {r.sink ? (
        <>
          <dt>Sink volume</dt>
          <dd>
            <code className="nx-bk-code">{r.sink}</code>
            {r.sinkReason ? <> · not archived itself: {r.sinkReason}</> : null}
          </dd>
        </>
      ) : null}
      <dt>Protects</dt>
      <dd>{r.protects?.length ? r.protects.join(", ") : <em>nothing declared</em>}</dd>
      <dt>Restore</dt>
      <dd>{r.restore ? <code className="nx-bk-code">{r.restore}</code> : <em>no restore path</em>}</dd>
      <dt>Recent runs</dt>
      <dd>
        {r.runs?.length
          ? r.runs.map((run) => `${run.state}${run.startedAt ? ` @ ${run.startedAt}` : ""}`).join(" · ")
          : "none retained"}
      </dd>
    </dl>
  );
}

function pickRoutine(doc: BackupsDoc): BackupsDoc["routines"][number] {
  return doc.routines[0];
}
