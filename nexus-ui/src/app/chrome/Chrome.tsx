// ChromeRegion: the header islands, banners and corner lockup - the
// hierarchy's chrome section. Reads DataStore + ChromeStore; owns no
// state of its own. Controls are Astryx (design-system verdicts in
// _docs/design/nexus-ui/design-system.md); the brand and corner lockups
// stay custom - they are the product's signature.
import { React } from "../../sdk";
import {
  Badge,
  Banner,
  DropdownMenu,
  EmptyState,
  HealthDot,
  Icon,
  IconButton,
  Item,
  OwnershipSphere,
  Popover,
  Tab,
  TabList,
} from "../../primitives";
import { HermesMark, HermesMarkLive } from "../../primitives/HermesMark";
import { flagOn, viewAvailable, type DataStore } from "../../stores/data";
import type { ChromeStore } from "../../stores/chrome";
import { tabs } from "../routes";
import { opsModel } from "./ops";
import "./chrome.css";

export function ChromeRegion({ ds, cs, view }: { ds: DataStore; cs: ChromeStore; view: string }) {
  const data = ds.data!;
  const ops = opsModel(data, ds.health, ds.stale);
  const systemOpen = viewAvailable(data, "system");
  const tabRoutes = tabs(data);
  const menuItems = [
    ...(flagOn(data, "avatar-gallery")
      ? [{ id: "avatars", label: "Avatar codes…", onClick: () => { location.hash = "#/avatars"; } }]
      : []),
    ...(!data.demo
      ? [{ id: "classic", label: "Hermes Classic", onClick: () => { location.href = "/sessions"; } }]
      : []),
  ];
  return (
    <>
      <header className="nx-header" data-region="chrome">
        <div className="nx-island nx-isl nx-isl-center">
          {systemOpen ? (
            <a className="nx-brand" href="#/system" aria-label="System">
              <HermesMark size={24} />
              <span className="nx-brand-word">Harness Hg</span>
            </a>
          ) : (
            <span className="nx-brand">
              <HermesMark size={24} />
              <span className="nx-brand-word">Harness Hg</span>
            </span>
          )}
          {tabRoutes.length > 1 ? (
            // Nav pattern (no role="tablist"): links carrying aria-current,
            // which is what hash routes are.
            <TabList size="sm" value={view} onChange={(v: string) => { location.hash = `#/${v}`; }} aria-label="Views">
              {tabRoutes.map((r) => (
                <Tab key={r.id} value={r.id} label={r.title} href={`#/${r.id}`} />
              ))}
            </TabList>
          ) : (
            <span className="nx-header-title">{tabRoutes[0]?.title ?? "Nexus"}</span>
          )}
          {data.demo ? <Badge label="DEMO DATA" variant="warning" /> : null}
        </div>
        <div className="nx-island nx-isl nx-isl-right">
          <IconButton
            variant="ghost"
            size="sm"
            label={`Switch to ${cs.theme === "dark" ? "light" : "dark"} theme`}
            icon={<Icon name={cs.theme === "dark" ? "sun" : "moon"} />}
            onClick={cs.toggleTheme}
          />
          <DropdownMenu
            button={{ isIconOnly: true, variant: "ghost", size: "sm", label: "Settings", icon: <Icon name="settings" /> }}
            items={menuItems}
            isMenuOpen={cs.overlay === "menu"}
            onOpenChange={(open: boolean) => cs.setOverlay(open ? "menu" : null)}
          />
          <OpsPill ds={ds} cs={cs} />
        </div>
      </header>
      {ds.stale ? (
        <Banner
          status="warning"
          title="Telemetry stale"
          description={`${ops.staleSources.length ? `${ops.staleSources.join(", ")} — ` : ""}showing the last good reading.`}
        />
      ) : null}
      {/* The live mark keeps the canvas's corner only: on a list view it
          sat over rows and fought the scrollbar; System draws it large
          as the mandala's nucleus. */}
      {view === "fleet" ? (
        <div className="nx-corner-lockup nx-pin-corner" aria-hidden="true">
          <HermesMarkLive size={64} density={4} />
        </div>
      ) : null}
    </>
  );
}

function OpsPill({ ds, cs }: { ds: DataStore; cs: ChromeStore }) {
  const ops = opsModel(ds.data, ds.health, ds.stale);
  const dotLevel = ops.level === "attention" ? "unhealthy" : ops.level === "unknown" ? "unknown" : "healthy";
  const firing = ds.data?.alerts?.firing ?? [];
  return (
    <Popover
      isOpen={cs.overlay === "ops"}
      onOpenChange={(open: boolean) => cs.setOverlay(open ? "ops" : null)}
      content={
        <div>
          <p className="nx-ops-reason">{ops.reason}</p>
          <section aria-label="Alerts">
            {firing.map((a) => (
              <Item
                key={`${a.name}:${a.namespace}`}
                marker={<HealthDot level={a.severity === "critical" ? "unhealthy" : "degraded"} small />}
                label={a.name}
                description={a.namespace}
                endContent={a.ownership === "control-plane" ? <OwnershipSphere /> : undefined}
                density="compact"
                onClick={() => {
                  cs.handoffAlert(`${a.name}:${a.namespace}`);
                  location.hash = "#/communication";
                }}
              />
            ))}
            {firing.length === 0 ? <EmptyState title="No alerts firing." isCompact /> : null}
          </section>
        </div>
      }
    >
      {/* The pill trigger stays custom chrome (design verdict: shell);
          the render-prop lets the Popover own the toggle + aria wiring
          so its light dismiss never races the opening click. */}
      {(trigger: { ref: (el: HTMLElement | null) => void; onClick: () => void }) => (
        <button
          {...trigger}
          type="button"
          className={`nx-ops-pill nx-ops-lv-${ops.level}`}
          title={ops.reason}
        >
          <HealthDot level={dotLevel} small />
          {ops.count > 0 ? <span>{ops.count} firing</span> : null}
          {ops.hasControlPlane ? <OwnershipSphere /> : null}
        </button>
      )}
    </Popover>
  );
}
