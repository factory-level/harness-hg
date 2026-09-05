// The card badge strip (ADR-58 restored): 28px domain fixtures clipped
// to the card's bottom edge, knocked out of the board by a paper halo.
// Triggers are non-interactive spans (the card is a <button> - nesting
// buttons is invalid); the bubbles render in the top layer through
// HoverPopover, where rows may be real links.
import { React } from "../../sdk";
import { Face, HoverPopover, Icon, type IconName } from "../../primitives";
import type { BadgeDomainModel, BadgeModel } from "./badges";
import type { PlanComponent } from "../../stores/data";

const DOMAIN_LABEL: Record<string, string> = {
  gh: "Repositories",
  comm: "Communication",
  iam: "IAM",
  alert: "Alerting",
};
const DOMAIN_ICON: Record<string, IconName> = { gh: "repositories", comm: "communication", iam: "iam", alert: "alerting" };

function Bubble({ domain, model, people }: { domain: string; model: BadgeDomainModel; people: PlanComponent[] }) {
  return (
    <div className="nx-bpop">
      <p className="nx-bpop-domain">{DOMAIN_LABEL[domain]}</p>
      <p className="nx-bpop-count">{model.count === 1 ? "1 entry" : `${model.count} entries`}</p>
      <ul className="nx-bpop-rows">
        {model.rows.map((r, i) => (
          <li key={i} className="nx-bpop-row">
            {r.mount ? <span className={`nx-attach-dot nx-attach-${r.mount}`} title={r.mount} /> : null}
            {r.href ? (
              <a href={r.href} target="_blank" rel="noreferrer">{r.label}</a>
            ) : (
              <span>{r.label}</span>
            )}
            {r.detail ? <span className="nx-bpop-detail">{r.detail}</span> : null}
          </li>
        ))}
      </ul>
      {domain === "iam" && people.length > 0 ? (
        <span className="nx-bpop-faces">
          {people.slice(0, 3).map((p) => (
            <Face key={p.id} id={p.id} title={p.title ?? p.id} />
          ))}
        </span>
      ) : null}
      {model.note ? <p className="nx-bpop-note">{model.note}</p> : null}
    </div>
  );
}

export function CardBadges({ model, title, people }: { model: BadgeModel; title: string; people: PlanComponent[] }) {
  const domains = (Object.keys(DOMAIN_LABEL) as (keyof BadgeModel)[]).filter((d) => model[d]);
  if (domains.length === 0) return null;
  return (
    <span className="nx-badges nx-fixture">
      {domains.map((d) => (
        <HoverPopover key={d} label={`${DOMAIN_LABEL[d]} — ${title}`} content={<Bubble domain={d} model={model[d]!} people={people} />}>
          {(hover: Record<string, unknown>) => (
            <span {...hover} className={`nx-badge nx-badge-${d}`} role="img" aria-label={`${DOMAIN_LABEL[d]}: ${model[d]!.count}`}>
              <Icon name={DOMAIN_ICON[d]} size={13} />
              <span>{model[d]!.count}</span>
            </span>
          )}
        </HoverPopover>
      ))}
    </span>
  );
}
