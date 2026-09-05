// The card drawer's body: everything the store HONESTLY knows about a
// plan component - identity art, kind, health, description, bundle
// membership. No fabricated links or actions; an absent field simply
// does not render. (The wire scrubs `links`, so there are none to show.)
import { React } from "../../sdk";
import { AgentAvatar, Face, HealthDot, Item, RingsMark, StatusPill } from "../../primitives";
import type { HealthLevel } from "../../primitives";
import type { DataStore, PlanComponent } from "../../stores/data";

// The bead rule, mirrored: only deployed kinds carry health.
const STATUSED = new Set(["agent", "tool", "application"]);

export function CardDetail({ ds, comp }: { ds: DataStore; comp: PlanComponent }) {
  const kind = comp.kind ?? "application";
  const title = comp.title ?? comp.id;
  const health = ds.health?.components?.[comp.id];
  const level = (health?.level ?? "unknown") as HealthLevel;
  const bundle = ds.data?.bundles?.find((b) => b.members?.includes(comp.id));
  return (
    <div className="nx-cd">
      <header className={`nx-cd-head nx-cd-${kind}`}>
        <span className="nx-cd-ava">
          <AgentAvatar
            code={comp.icon}
            still
            className="nx-cd-art"
            fallback={kind === "agent" ? <RingsMark size={52} /> : <Face id={comp.id} title={title} />}
          />
        </span>
        <span className="nx-cd-id">
          <span className="nx-eyebrow nx-cd-kind">{kind}</span>
          {STATUSED.has(kind) ? (
            <StatusPill level={level}>
              {level}
            </StatusPill>
          ) : null}
        </span>
      </header>
      {comp.description ? <p className="nx-cd-desc">{comp.description}</p> : null}
      <section className="nx-cd-facts" aria-label="Facts">
        {kind === "person" ? <Item label="Role" description={`Person · ${comp.personTitle ?? "member"}`} density="compact" /> : null}
        {bundle ? <Item label="Bundle" description={bundle.title ?? bundle.id} density="compact" /> : null}
        {STATUSED.has(kind) && health?.summary ? (
          <Item marker={<HealthDot level={level} small />} label="Health" description={health.summary} density="compact" />
        ) : null}
        <Item label="Declared as" description={comp.id} density="compact" />
      </section>
    </div>
  );
}
