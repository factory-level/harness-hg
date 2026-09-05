// The primitives specimen board: every primitive rendered live, wired to
// the same components screens use (the specimen breaks when the primitive
// does - the badge-demo precedent). Also the #667 acceptance surface: a
// one-line token change in design/tokens.json restyles this whole board.
import { React } from "../sdk";
import {
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  HealthDot,
  HoverPopover,
  OwnershipSphere,
  StatusPill,
  StatusWord,
  TextInput,
} from "../primitives";
import type { HealthLevel, SaveState } from "../primitives";
import "./utility/utility.css";

const LEVELS: HealthLevel[] = ["healthy", "degraded", "unhealthy", "unknown", "paused"];
const SAVES: SaveState[] = ["saved", "saving", "unsaved", "failed", "conflict"];

export function PrimitivesView() {
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  return (
    <section aria-label="Primitives specimen" className="nx-ut">
      <header className="nx-view-head">
        <h1 className="nx-h1">Primitives</h1>
      </header>

      <h2 className="nx-h2">Health grammar</h2>
      <p className="nx-ut-row">
        {LEVELS.map((l) => (
          <StatusPill key={l} level={l} />
        ))}
      </p>
      <p className="nx-ut-row">
        {LEVELS.map((l) => (
          <HealthDot key={l} level={l} />
        ))}
        <OwnershipSphere />
      </p>

      <h2 className="nx-h2">Save words (#423 grammar)</h2>
      <p className="nx-ut-row">
        {SAVES.map((s) => (
          <StatusWord key={s} state={s} />
        ))}
      </p>

      <h2 className="nx-h2">Astryx passthroughs</h2>
      <p className="nx-ut-row">
        <Button label="Open the drawer" onClick={() => setDrawerOpen(true)} />
        <Badge label="badge" />
        <TextInput label="Search" value="" onChange={() => {}} />
      </p>
      <Card>
        <EmptyState title="Nothing declared" description="An honest empty state is a rendered answer." />
      </Card>

      <h2 className="nx-h2">Hover surface</h2>
      <p className="nx-ut-row">
        <HoverPopover label="status detail" content={<StatusPill level="degraded">served rows, verbatim</StatusPill>}>
          {(hover) => (
            <Button label="Hover me" {...hover} />
          )}
        </HoverPopover>
      </p>

      <Drawer open={drawerOpen} onClose={() => setDrawerOpen(false)} title="The one drawer" subtitle="agent detail, alert evidence, routine, capability - all this">
        <p>Focus, Escape, backdrop and restore come from the platform, not bespoke geometry.</p>
      </Drawer>
    </section>
  );
}
