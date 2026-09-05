// DataStore (the hierarchy's served-truth store): the ONLY node that
// touches the Nexus plugin API. Semantics carried from the old data
// layer's tested contracts:
// - demo fallback ONLY on the not-configured 503; any other failure is an
//   error shell ("missing evidence must never read healthy", #424)
// - flagOn = demo || features[id]; viewAvailable fails OPEN and ignores
//   demo (a backend outage must not re-enable a withheld view)
// - health poll: 15s, pauses hidden tabs, single in-flight chain; failure
//   keeps the last-good overlay and raises `stale`
import { React, SDK } from "../sdk";
import { API } from "../api";
import { DEMO_DATA, DEMO_HEALTH } from "./demo";

export interface HealthSource {
  status: string;
  kind: string;
}
export interface HealthOverlay {
  components: Record<string, { level: string; summary?: string; sources?: { kind?: string; status?: string }[] }>;
  instances: Record<string, unknown>;
  sources: Record<string, HealthSource>;
  rollups?: Record<string, { level: string }>;
  stale?: boolean;
}
export interface FiringAlert {
  name: string;
  namespace?: string;
  severity?: string;
  signal?: string;
  since?: string;
  summary?: string;
  labels?: Record<string, string>;
  ownership?: string;
}
/** One plan component, as the wire sends it (plugin_api passes the
 * declaration through wholesale, scrubbing only `links`). The card
 * faces read the identity fields; everything else stays unmodelled. */
export interface PlanComponent {
  id: string;
  title?: string;
  kind?: string;
  description?: string;
  /** Avatar code into the served library (`…/nexus/assets/avatars/`). */
  icon?: string;
  /** A person's role line ("Person · {personTitle}"). */
  personTitle?: string;
  /** Deployment binding - which profile (and app) ships this. */
  bind?: { profile: string; app?: string };
  /** Component ids this person may operate (kind:"human"/"person"). */
  accessors?: string[];
  /** Authored links, server-sanitized to https repository/docs/runbook. */
  links?: Record<string, string>;
  /** Instance destinations; `deployed[].name === "published"` is the
   * externally reachable hostname (ADR-40). */
  instances?: { destinations?: { deployed?: { name?: string; url?: string }[] } }[];
}
export interface NexusData {
  demo: boolean;
  canWrite: boolean;
  plan: { components: PlanComponent[] } | null;
  links: { argocdBaseUrl?: string; grafanaBaseUrl?: string };
  features: Record<string, boolean>;
  capabilities: { views?: Record<string, boolean>; workspaceReset?: boolean };
  bundles: { id: string; title?: string; members?: string[] }[];
  alerts?: { configured: boolean; reachable?: boolean; firing: FiringAlert[] };
}

const POLL_MS = 15_000;

export function flagOn(data: NexusData, id: string): boolean {
  return data.demo || data.features[id] === true;
}

export function viewAvailable(data: NexusData, view: string): boolean {
  return data.capabilities.views?.[view] !== false;
}

/** The wire's `bundles` is a MAP - bundle name -> {namespace,
 * profiles[]} (plugin_api bundle_membership, ADR-28) - not the array
 * this store first assumed; the live factory's Agents view threw
 * "bundles is not iterable" on the real payload. Normalize either
 * shape (an array passes through) and refuse the rest. */
export function normalizeBundles(raw: unknown): NexusData["bundles"] {
  if (Array.isArray(raw)) return raw as NexusData["bundles"];
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, { profiles?: string[]; title?: string }>).map(
      ([id, b]) => ({ id, title: b?.title ?? id, members: b?.profiles ?? [] }),
    );
  }
  return [];
}

async function fetchNexus(): Promise<NexusData> {
  try {
    const doc = (await SDK.fetchJSON(`${API}/nexus`)) as Record<string, unknown>;
    return {
      demo: false,
      canWrite: doc["canWrite"] === true,
      plan: (doc["plan"] as NexusData["plan"]) ?? null,
      links: (doc["links"] as NexusData["links"]) ?? {},
      features: (doc["features"] as Record<string, boolean>) ?? {},
      capabilities: (doc["capabilities"] as NexusData["capabilities"]) ?? {},
      bundles: normalizeBundles(doc["bundles"]),
    };
  } catch (e) {
    // Demo substitutes ONLY for the not-configured 503; anything else is
    // a real failure the shell must show.
    if (String(e).includes("503")) return DEMO_DATA;
    throw e;
  }
}

export interface DataStore {
  data: NexusData | null;
  error: string | null;
  health: HealthOverlay | null;
  stale: boolean;
  refresh: () => void;
}

export function useDataStore(): DataStore {
  const [data, setData] = React.useState<NexusData | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [health, setHealth] = React.useState<HealthOverlay | null>(null);
  const [stale, setStale] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let dead = false;
    fetchNexus().then(
      (d) => {
        if (dead) return;
        setData(d);
        setError(null);
      },
      (e) => {
        if (!dead) setError(String(e));
      },
    );
    return () => {
      dead = true;
    };
  }, [nonce]);

  React.useEffect(() => {
    if (!data) return;
    if (data.demo) {
      setHealth(DEMO_HEALTH);
      return;
    }
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (dead) return;
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        const h = (await SDK.fetchJSON(`${API}/nexus/health`)) as HealthOverlay;
        if (dead) return;
        setHealth(h);
        setStale(h.stale === true);
      } catch {
        if (!dead) setStale(true); // last-good overlay stays
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        if (timer) clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener?.("visibilitychange", onVisible);
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener?.("visibilitychange", onVisible);
    };
  }, [data]);

  return { data, error, health, stale, refresh: () => setNonce((n) => n + 1) };
}
