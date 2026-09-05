// System: the orbital mandala (#545) - capability-first vocabulary,
// entered through the brand lockup, never a tab. Arcs are SVG; labels
// are HTML placed by the SAME polar math (measured layout - never
// glyph-count estimates); the nucleus is the live mark. Detail rides the
// shared Drawer (#574 - never a bespoke panel). People & Groups is a
// read-only projection (#573/#584).
import { React, SDK } from "../../sdk";
import { API } from "../../api";
import { Badge, Drawer, HealthDot, StatusPill, Banner } from "../../primitives";
import type { HealthLevel } from "../../primitives";
import { HermesMarkLive } from "../../primitives/HermesMark";
import { DEMO_INVENTORY, DEMO_PEOPLE } from "../../stores/demo";
import type { DataStore } from "../../stores/data";
import { CAPABILITIES, capabilityLevel, unplaced, type Capability, type Workload } from "./capabilities";
import { PanelGrid } from "../panels/Panels";
import "./system.css";

const R_INNER = 26; // percent of the square
const R_OUTER = 41;

function useInventory(demo: boolean): Workload[] {
  const [ws, setWs] = React.useState<Workload[]>(demo ? DEMO_INVENTORY : []);
  React.useEffect(() => {
    if (demo) return;
    let dead = false;
    SDK.fetchJSON(`${API}/nexus/inventory`).then(
      (d) => {
        if (!dead) setWs(((d as { workloads?: Workload[] })?.workloads) ?? []);
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [demo]);
  return ws;
}

interface Slice {
  /** Label anchor: on the ring for the inner ring, outside it for the
   * outer ring so the two rings' pills never meet on the diagonals. */
  lx: number;
  ly: number;
  cap: Capability;
  cx: number;
  cy: number;
  path: string;
}

/** Even slices per ring; the outer ring is rotated half a step so labels
 * never stack over inner ones. Pure trig - fixture-testable. */
export function layoutSlices(): Slice[] {
  const rings: Array<{ ring: "inner" | "outer"; r: number; offset: number }> = [
    { ring: "inner", r: R_INNER, offset: -90 },
    { ring: "outer", r: R_OUTER, offset: -90 + 360 / (2 * CAPABILITIES.filter((c) => c.ring === "outer").length) },
  ];
  const out: Slice[] = [];
  for (const { ring, r, offset } of rings) {
    const caps = CAPABILITIES.filter((c) => c.ring === ring);
    const step = 360 / caps.length;
    caps.forEach((cap, i) => {
      const a0 = ((offset + i * step + 4) * Math.PI) / 180;
      const a1 = ((offset + (i + 1) * step - 4) * Math.PI) / 180;
      const mid = (a0 + a1) / 2;
      const p = (a: number) => `${50 + r * Math.cos(a)} ${50 + r * Math.sin(a)}`;
      out.push({
        cap,
        cx: 50 + r * Math.cos(mid),
        cy: 50 + r * Math.sin(mid),
        lx: 50 + (ring === "outer" ? r + 6 : r) * Math.cos(mid),
        ly: 50 + (ring === "outer" ? r + 6 : r) * Math.sin(mid),
        path: `M ${p(a0)} A ${r} ${r} 0 0 1 ${p(a1)}`,
      });
    });
  }
  return out;
}

export function SystemView({ ds }: { ds: DataStore }) {
  const demo = ds.data?.demo === true;
  const workloads = useInventory(demo);
  const [open, setOpen] = React.useState<string | null>(null);
  const [spotlight, setSpotlight] = React.useState(false);

  const levelOf = (id: string) => ds.health?.components?.[id]?.level ?? "unknown";
  const slices = layoutSlices();
  const attention = slices.filter((s) => ["degraded", "unhealthy"].includes(capabilityLevel(s.cap, levelOf)));
  const stray = unplaced(workloads);
  const openCap = CAPABILITIES.find((c) => c.id === open) ?? null;

  return (
    <div className="nx-system">
      <header className="nx-view-head nx-system-head">
        <h1 className="nx-h1">System</h1>
        {attention.length > 0 ? (
          <button type="button" className="nx-system-attention" aria-pressed={spotlight} onClick={() => setSpotlight((x) => !x)}>
            {attention.length} capabilit{attention.length === 1 ? "y needs" : "ies need"} attention — show me
          </button>
        ) : (
          <p className="nx-lede">All capabilities quiet.</p>
        )}
      </header>
      <div className={`nx-mandala nx-anchor-layer${spotlight ? " nx-mandala-spot" : ""}`}>
        <svg viewBox="0 0 100 100" className="nx-mandala-svg" aria-hidden="true">
          <circle cx="50" cy="50" r={R_INNER} className="nx-orbit-guide" />
          <circle cx="50" cy="50" r={R_OUTER} className="nx-orbit-guide" />
          {slices.map((s) => {
            const lv = capabilityLevel(s.cap, levelOf);
            const flagged = ["degraded", "unhealthy"].includes(lv);
            return (
              <path
                key={s.cap.id}
                d={s.path}
                className={`nx-arc${flagged ? " nx-arc-flagged" : ""}${open === s.cap.id ? " nx-arc-open" : ""}`}
                data-cap={s.cap.id}
                onClick={() => setOpen(s.cap.id)}
              />
            );
          })}
        </svg>
        {slices.map((s) => {
          const lv = capabilityLevel(s.cap, levelOf) as HealthLevel;
          const flagged = ["degraded", "unhealthy", "unknown"].includes(lv);
          return (
            <button
              key={s.cap.id}
              type="button"
              className={`nx-mandala-label nx-anchored${flagged ? " nx-mandala-label-flagged" : ""}`}
              data-pos={`${s.cap.ring}`}
              data-cap={s.cap.id}
              tabIndex={0}
              onClick={() => setOpen(s.cap.id)}
              aria-label={`${s.cap.label}: ${lv}`}
              // Placed by the same polar math as the arc - measured
              // layout, never glyph-count estimates.
              ref={(el: HTMLButtonElement | null) => {
                if (el) {
                  el.style.left = `${s.lx}%`;
                  el.style.top = `${s.ly}%`;
                }
              }}
            >
              {flagged && lv !== "unknown" ? <HealthDot level={lv} small /> : null}
              {s.cap.label}
            </button>
          );
        })}
        <div className="nx-mandala-nucleus nx-anchored" aria-label="Harness Hg">
          <HermesMarkLive size={160} density={12} />
        </div>
      </div>
      {stray.length > 0 ? (
        <div className="nx-system-stray">
          <Banner status="warning" title="Unplaced workloads" description={`${stray.map((w) => w.id).join(", ")} - declared, but no capability claims ${stray.length === 1 ? "it" : "them"}.`} />
        </div>
      ) : null}
      <section className="nx-system-panels" aria-label="Control plane panels">
        <PanelGrid surface="system" component={null} theme="dark" demo={demo} />
      </section>
      <Drawer open={open !== null} onClose={() => setOpen(null)} title={openCap?.label ?? ""} subtitle={openCap?.desc}>
        {openCap ? (
          openCap.id === "people" ? (
            <PeopleField demo={demo} />
          ) : (
            <div>
              {openCap.members.length === 0 ? <p className="nx-system-mut">No runtime members.</p> : null}
              {openCap.members.map((m) => {
                const w = workloads.find((x) => x.id === m);
                const lv = levelOf(m) as HealthLevel;
                return (
                  <div key={m} className="nx-system-member">
                    <HealthDot level={lv} small />
                    <span className="nx-system-membername">{w?.title ?? m}</span>
                    <span className="nx-system-mut">{w?.role ?? ""}</span>
                    <StatusPill level={lv} />
                  </div>
                );
              })}
            </div>
          )
        ) : null}
      </Drawer>
    </div>
  );
}

/** Read-only forever (#573/#584): projected from the bootstrap contract;
 * the persona repository is the authoring path. No Add, no Upload. */
function PeopleField({ demo }: { demo: boolean }) {
  const roster = demo ? DEMO_PEOPLE : { groups: [], people: [] };
  return (
    <div>
      {roster.groups.map((g) => (
        <div key={g.id} className="nx-system-member">
          <span className="nx-system-membername">{g.title}</span>
          <Badge label="Group" />
          <span className="nx-system-mut">declared by {g.declaredBy}</span>
        </div>
      ))}
      {roster.people.map((p) => (
        <div key={p.id} className="nx-system-member">
          <span className="nx-system-membername">{p.name}</span>
          <Badge label="Person" />
          <span className="nx-system-mut">{p.role} · declared by {p.declaredBy}</span>
        </div>
      ))}
      {roster.groups.length + roster.people.length === 0 ? (
        <p className="nx-system-mut">No people or groups declared — or the contract could not be read (those are different states; the served document says which).</p>
      ) : null}
      <p className="nx-system-mut">Authoring happens in the persona repository, never here.</p>
    </div>
  );
}
