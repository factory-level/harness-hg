// Agents: compact badge-driven directory (#552) + the detail in two of
// its three postures (drawer from the row, full page at #/agents/<id>).
// #584 found no new Agents deficiencies - this is a regression-checked
// recreation, not a redesign.
import { React } from "../../sdk";
import { Drawer, Face, HealthDot, Icon, StatusPill, Tab, TabList } from "../../primitives";
import type { HealthLevel } from "../../primitives";
import { flagOn, type DataStore } from "../../stores/data";
import { agentLevel, applyFilters, bundleOf, groupLevel, groups } from "./model";
import { PanelGrid } from "../panels/Panels";
import "./agents.css";

const LEVELS = ["healthy", "degraded", "unhealthy", "unknown"] as const;

export function AgentsView({ ds, sub }: { ds: DataStore; sub: string | null }) {
  const data = ds.data!;
  const [level, setLevel] = React.useState<string | null>(null);
  const [bundle, setBundle] = React.useState<string | null>(null);
  const [drawerId, setDrawerId] = React.useState<string | null>(null);

  const all = groups(data);
  const shown = applyFilters(all, ds.health, { level, bundle });
  const total = all.reduce((n, g) => n + g.agents.length, 0);
  const matching = shown.reduce((n, g) => n + g.agents.length, 0);
  const filtering = level !== null || bundle !== null;

  // Full-page posture: #/agents/<id>. Close via location.replace so Back
  // never reopens it (the carried routing rule).
  if (sub) {
    return (
      <div className="nx-agents">
        <a
          className="nx-back"
          href="#/agents"
          onClick={(e: { preventDefault: () => void }) => {
            e.preventDefault();
            location.replace("#/agents");
          }}
        >
          <Icon name="chevron-left" /> All agents
        </a>
        <AgentDetail ds={ds} id={sub} />
      </div>
    );
  }

  return (
    <div className="nx-agents">
      <header className="nx-view-head">
        <h1 className="nx-h1">Agents</h1>
        <div className="nx-agents-filters" role="group" aria-label="Filters">
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              className="nx-chip"
              aria-pressed={level === l}
              onClick={() => setLevel(level === l ? null : l)}
            >
              {l}
            </button>
          ))}
          <span className="nx-agents-div" />
          {all.map((g) => (
            <button
              key={g.id}
              type="button"
              className="nx-chip"
              aria-pressed={bundle === g.id}
              onClick={() => setBundle(bundle === g.id ? null : g.id)}
            >
              {g.title}
            </button>
          ))}
          {filtering ? <span className="nx-agents-count">{matching} of {total}</span> : null}
        </div>
      </header>
      <div className="nx-agents-scroll">
        {shown.length > 0 ? (
          <div className="nx-agent-row nx-agent-cols" aria-hidden="true">
            <span className="nx-eyebrow">Agent</span>
            <span className="nx-eyebrow">Deployment</span>
            <span className="nx-eyebrow">Attachments</span>
            <span className="nx-eyebrow nx-agent-cols-health">Health</span>
            <span />
          </div>
        ) : null}
        {shown.map((g) => (
          <section key={g.id} className="nx-shell nx-agents-group">
            <div className="nx-agents-grouphead">
              <span className="nx-agents-groupname">{g.title}</span>
              {g.id !== "bucket:unbundled" ? <span className="nx-tag">bundle</span> : null}
              <span className="nx-agents-groupmeta">{g.agents.length} agent{g.agents.length === 1 ? "" : "s"}</span>
              <StatusPill level={groupLevel(ds.health, g.id) as HealthLevel} />
            </div>
            {g.agents.map((a) => {
              const lv = agentLevel(ds.health, a.id) as HealthLevel;
              const b = bundleOf(data, a.id);
              return (
                <div key={a.id} className="nx-agent-row">
                  <button type="button" className="nx-agent-main" onClick={() => setDrawerId(a.id)}>
                    <Face id={a.id} title={a.title} />
                    <span className="nx-agent-name">
                      <span className="nx-agent-title">{a.title}</span>
                      {a.description ? <span className="nx-agent-desc">{a.description}</span> : null}
                    </span>
                  </button>
                  <span className="nx-agent-deploy">{b ? b.title : a.namespace ?? "—"}</span>
                  <span className="nx-agent-badges">
                    {flagOn(data, "repository-links") ? null : <span className="nx-agent-unknown">repos unknown</span>}
                  </span>
                  <span className="nx-agent-status">
                    <HealthDot level={lv} small />
                    {lv}
                  </span>
                  <a className="nx-agent-open" href={`#/agents/${encodeURIComponent(a.id)}`} aria-label={`Open ${a.title}`}>
                    <Icon name="chevron-right" />
                  </a>
                </div>
              );
            })}
          </section>
        ))}
        {shown.length === 0 ? (
          <p className="nx-state">
            {total === 0 ? "No agents contributed to the plan." : "No agents match the filters."}
          </p>
        ) : null}
      </div>
      <Drawer
        open={drawerId !== null}
        onClose={() => setDrawerId(null)}
        title={all.flatMap((g) => g.agents).find((a) => a.id === drawerId)?.title ?? "Agent"}
      >
        {drawerId ? <AgentDetail ds={ds} id={drawerId} /> : null}
      </Drawer>
    </div>
  );
}

/** Still image outside the canvas (ADR-146): the directory never
 * animates; monogram fallback when no art resolves. */
function AgentDetail({ ds, id }: { ds: DataStore; id: string }) {
  const data = ds.data!;
  const comp = ds.health?.components?.[id];
  const level = (comp?.level ?? "unknown") as HealthLevel;
  const b = bundleOf(data, id);
  const [tab, setTab] = React.useState("instances");
  const TABS = ["instances", "metrics", "repositories", "communication", "docs"] as const;
  return (
    <div className="nx-agent-detail">
      <dl className="nx-facts nx-agent-facts">
        <dt>Health</dt>
        <dd><StatusPill level={level}>{comp?.summary ?? level}</StatusPill></dd>
        <dt>Deployment</dt>
        <dd>{b ? `bundle ${b.title}` : "unbundled"}</dd>
      </dl>
      <div className="nx-agent-tabs">
        <TabList size="sm" value={tab} onChange={(v: string) => setTab(v)} aria-label="Sections">
          {TABS.map((t) => (
            <Tab key={t} value={t} label={t[0].toUpperCase() + t.slice(1)} />
          ))}
        </TabList>
      </div>
      {tab === "instances" ? (
        <div>
          {Object.keys(ds.health?.instances ?? {}).filter((k) => k.startsWith(`${id}`)).length === 0 ? (
            <p className="nx-state">
              No instance rows in the overlay — unknown is not the same as healthy.
            </p>
          ) : (
            <p>Instance rows render verbatim from the served overlay.</p>
          )}
        </div>
      ) : null}
      {tab === "metrics" ? (
        <PanelGrid surface="agent" component={id} theme="dark" demo={data.demo} />
      ) : null}
      {tab === "repositories" ? (
        <p className="nx-state">
          {flagOn(data, "repository-links")
            ? "Mounted workspaces render from live bindings."
            : "Repository attachments are switched off — unreadable reads as unknown, not as none."}
        </p>
      ) : null}
      {tab === "communication" ? (
        <p className="nx-state">
          {flagOn(data, "communication-view")
            ? "Routed edges render from the communication document."
            : "The communication view is switched off for this deployment."}
        </p>
      ) : null}
      {tab === "docs" ? <p className="nx-state">Nothing declared.</p> : null}
    </div>
  );
}
