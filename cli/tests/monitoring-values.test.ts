// Offline unit test for the ONE local divergence in the monitoring stack
// (cli/src/platform.ts LOCAL_ONLY_VALUES): anonymous Viewer is layered over
// the canonical bootstrap valuesObject (nested under the grafana subchart), and `allow_embedding` is NOT.
//
// The failure this exists to catch is silent: `grafana.ini` is a key in both
// the bootstrap file and the local overlay, so a shallow merge would replace
// it wholesale and drop `allow_embedding` locally. Nothing would error - the
// loop would just install a Grafana that refuses every iframe, and the embed
// would look like a frontend bug (ADR-44).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { deepMerge, PLATFORM_ROOT } from "../src/lib.ts";
import { devAnonymousGrafanaValues, grafanaAnonymousViewerRequested, LOCAL_ONLY_VALUES } from "../src/platform/index.ts";

function bootstrapValues(name: string): Record<string, unknown> {
  const manifest = parseYaml(
    fs.readFileSync(
      path.join(PLATFORM_ROOT, "infra", "gitops-template", "bootstrap", `${name}.yaml`),
      "utf8",
    ),
  ) as { spec: { source: { helm: { valuesObject: Record<string, unknown> } } } };
  return manifest.spec.source.helm.valuesObject;
}

type GrafanaIni = {
  security?: { allow_embedding?: boolean };
  "auth.anonymous"?: { enabled?: boolean; org_role?: string };
};

describe("monitoring-stack local overlay", () => {
  const canonical = bootstrapValues("monitoring-stack");
  const effective = deepMerge(canonical, LOCAL_ONLY_VALUES["monitoring-stack"] ?? {});
  const grafana = (v: Record<string, unknown>) => v["grafana"] as Record<string, unknown>;

  test("the bootstrap file ships allow_embedding - the embed needs it fleet-wide", () => {
    expect((grafana(canonical)["grafana.ini"] as GrafanaIni)?.security?.allow_embedding).toBe(true);
  });

  test("the bootstrap file ships anonymous read-only Viewer (ADR-111)", () => {
    // Superseded #422's local-flag-only posture: with every published
    // Grafana behind the edge's Access gate (ADR-118), anonymous Viewer
    // BEHIND that gate is what makes embeds render without a second
    // login - the edge sign-in is the only login. Read-only is the
    // guard: Viewer, never Editor/Admin.
    const ini = grafana(canonical)["grafana.ini"] as GrafanaIni;
    expect(ini?.["auth.anonymous"]?.enabled).toBe(true);
    expect(ini?.["auth.anonymous"]?.org_role).toBe("Viewer");
  });

  test("the overlay contributes NO anonymous auth of its own (#422)", () => {
    // The LOCAL overlay stays empty on this axis: anonymous comes from
    // the canonical bootstrap values (ADR-111), not a local side door -
    // an absent HG_GRAFANA_ANON_VIEWER must add nothing on top.
    const overlay = LOCAL_ONLY_VALUES["monitoring-stack"] ?? {};
    const ini = (overlay["grafana"] as Record<string, unknown> | undefined)?.["grafana.ini"] as GrafanaIni | undefined;
    expect(ini?.["auth.anonymous"]).toBeUndefined();
  });

  test("the DEEP merge still preserves allow_embedding (the regression this file exists for)", () => {
    // The property under test is the merge depth, not anonymous: a
    // shallow merge would replace grafana.ini wholesale and silently drop
    // allow_embedding, making a header problem look like a frontend bug.
    // Exercised through the flag path, which is where a grafana.ini
    // overlay lives now.
    const prev = process.env.HG_GRAFANA_ANON_VIEWER;
    process.env.HG_GRAFANA_ANON_VIEWER = "1";
    try {
      const merged = deepMerge(effective, devAnonymousGrafanaValues());
      const ini = grafana(merged)["grafana.ini"] as GrafanaIni;
      expect(ini.security?.allow_embedding).toBe(true); // survives the merge
      expect(ini["auth.anonymous"]?.enabled).toBe(true);
      expect(ini["auth.anonymous"]?.org_role).toBe("Viewer");
    } finally {
      if (prev === undefined) delete process.env.HG_GRAFANA_ANON_VIEWER;
      else process.env.HG_GRAFANA_ANON_VIEWER = prev;
    }
  });

  test("the overlay leaves the rest of the canonical values alone", () => {
    expect(grafana(effective)["admin"]).toEqual(grafana(canonical)["admin"]);
    expect(grafana(effective)["sidecar"]).toEqual(grafana(canonical)["sidecar"]);
    expect(effective["alertmanager"]).toEqual(canonical["alertmanager"]);
    expect(effective["prometheus"]).toEqual(canonical["prometheus"]);
  });

  test("no committed admin credential anywhere in the canonical values", () => {
    expect(JSON.stringify(canonical)).not.toContain("hermes-gitops"); // the old literal
    expect(grafana(canonical)["admin"]).toEqual({
      existingSecret: "monitoring-grafana-admin",
      userKey: "admin-user",
      passwordKey: "admin-password",
    });
  });

  test("Alertmanager is on with the config selector (ADR-45)", () => {
    const am = canonical["alertmanager"] as { enabled?: boolean; alertmanagerSpec?: { alertmanagerConfigSelector?: unknown } };
    expect(am.enabled).toBe(true);
    expect(am.alertmanagerSpec?.alertmanagerConfigSelector).toEqual({
      matchLabels: { hermes_alertmanager_config: "1" },
    });
  });
});

describe("development anonymous Grafana (#422)", () => {
  const canonical = bootstrapValues("monitoring-stack");
  const ini = (v: Record<string, unknown>) =>
    (v["grafana"] as Record<string, unknown>)["grafana.ini"] as GrafanaIni & {
      "auth.generic_oauth"?: { role_attribute_strict?: boolean; allow_assign_grafana_admin?: boolean };
      auth?: { disable_login_form?: boolean };
    };

  const withFlag = <T,>(value: string | undefined, fn: () => T): T => {
    const prev = process.env.HG_GRAFANA_ANON_VIEWER;
    if (value === undefined) delete process.env.HG_GRAFANA_ANON_VIEWER;
    else process.env.HG_GRAFANA_ANON_VIEWER = value;
    try {
      return fn();
    } finally {
      if (prev === undefined) delete process.env.HG_GRAFANA_ANON_VIEWER;
      else process.env.HG_GRAFANA_ANON_VIEWER = prev;
    }
  };

  test("on by default; only the exact negative spellings opt out (#447)", () => {
    // #447 inverted the default: after #422 made anonymous an opt-in, the
    // embed proofs went quiet - the manual step nobody remembers. The
    // local loop now sets the flag for itself, and opting OUT is the
    // explicit act. Only the trimmed, lowercased "0" and "false" count.
    for (const value of [undefined, "", "1", "true", "TRUE ", "yes", "enabled"]) {
      const on = withFlag(value, () => grafanaAnonymousViewerRequested());
      expect({ value: String(value), on }).toEqual({ value: String(value), on: true });
    }
    for (const value of ["0", "false", " FALSE ", "0 "]) {
      const on = withFlag(value, () => grafanaAnonymousViewerRequested());
      expect({ value: String(value), on }).toEqual({ value: String(value), on: false });
    }
  });

  test("on by default in the LOCAL LOOP only - the deployed path never reads this", () => {
    // devAnonymousGrafanaValues is consulted by ensureMonitoringPair (the
    // local `hg up`) and nothing else; a deployed environment's values
    // come from the bootstrap file, which test 'the bootstrap file does
    // NOT ship anonymous auth' pins above.
    expect(withFlag(undefined, () => devAnonymousGrafanaValues())).toEqual({
      grafana: { "grafana.ini": { "auth.anonymous": { enabled: true, org_role: "Viewer" } } },
    });
    expect(withFlag("0", () => devAnonymousGrafanaValues())).toEqual({});
  });

  test("it survives the OIDC values, which deliberately turn anonymous off", () => {
    // The merge order IS the fix: grafanaOidcValues sets enabled:false,
    // and without the dev override landing last the flag would appear to
    // do nothing on any cluster with an issuer.
    const oidcOff = { grafana: { "grafana.ini": { "auth.anonymous": { enabled: false } } } };
    const merged = withFlag("1", () =>
      deepMerge(
        deepMerge(deepMerge(canonical, LOCAL_ONLY_VALUES["monitoring-stack"] ?? {}), oidcOff),
        devAnonymousGrafanaValues(),
      ),
    );
    expect(ini(merged)["auth.anonymous"]?.enabled).toBe(true);
    expect(ini(merged)["auth.anonymous"]?.org_role).toBe("Viewer");
    // And the deep merge still preserves the framing header, which is the
    // regression this file was written for.
    expect(ini(merged).security?.allow_embedding).toBe(true);
  });

  test("it grants Viewer and relaxes NOTHING else", () => {
    const values = withFlag("1", () => devAnonymousGrafanaValues());
    const block = (values.grafana as Record<string, unknown>)["grafana.ini"] as Record<string, unknown>;
    // Exactly one key: anything else here would be a second, unreviewed
    // security change riding a development convenience.
    expect(Object.keys(block)).toEqual(["auth.anonymous"]);
    expect(block["auth.anonymous"]).toEqual({ enabled: true, org_role: "Viewer" });
    // Never Editor or Admin, however the flag is spelled.
    for (const value of ["1", "true"]) {
      const v = withFlag(value, () => devAnonymousGrafanaValues());
      const b = ((v.grafana as Record<string, unknown>)["grafana.ini"] as GrafanaIni)["auth.anonymous"];
      expect(b?.org_role).toBe("Viewer");
    }
  });
});
