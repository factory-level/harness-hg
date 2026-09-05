// The platform's route policy for a self-hosted Eve agent (ADR-149).
//
// Eve fails closed in production: without an authenticator that accepts the
// caller, every session route answers 401. The eve-agent chart mints a
// per-instance credential (Secret ag-eve-<name>-route-auth), mounts its
// password at ROUTE_AUTH_BASIC_PASSWORD_FILE and names the user in
// ROUTE_AUTH_BASIC_USERNAME; `hg test` and `hg agent prove` authenticate with
// the same pair.
//
// ONE credential, TWO header schemes. Basic is what hg and browsers send;
// Bearer <password> is what `eve eval --url` sends when EVE_EVAL_AUTH_TOKEN is
// set (eve's own evals authenticate with a bearer, never Basic), so the
// agent's evals can run against its deployment with the same minted secret.
//
// The password is read from the file ON EVERY REQUEST, not captured at
// module load: a re-minted Secret (ESO re-running its generator after a
// chart-label bump) propagates through the mounted volume and takes effect
// without a pod restart. A plain httpBasic({username, password}) would keep
// verifying the old value until the process restarted.
//
// This file is the authored form. When an agent ships NO agent/channels/eve.ts
// the chart's boot script writes exactly this one, so a persona only authors
// the file to add a stricter or different policy (OIDC, a custom AuthFn).
// localDev() stays in the walk: it authenticates only under `eve dev`.
import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import {
  type AuthFn,
  extractBearerToken,
  localDev,
  verifyHttpBasic,
  withAuthChallenges,
} from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";

const username = process.env.ROUTE_AUTH_BASIC_USERNAME ?? "";
const passwordFile = process.env.ROUTE_AUTH_BASIC_PASSWORD_FILE ?? "";

function currentPassword(): string {
  if (passwordFile) {
    try {
      return readFileSync(passwordFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  return process.env.ROUTE_AUTH_BASIC_PASSWORD ?? "";
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const platformCredential: AuthFn<Request> = withAuthChallenges(
  (request) => {
    const password = currentPassword();
    if (!username || !password) return null;
    const header = request.headers.get("authorization");
    const basic = verifyHttpBasic(header, { username, password });
    if (basic.ok) return basic.sessionAuth;
    // Bearer <password>: the same secret, re-verified through the Basic
    // verifier so both schemes yield the identical principal.
    const bearer = extractBearerToken(header);
    if (bearer && sameSecret(bearer, password)) {
      const asBasic = "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
      const viaBasic = verifyHttpBasic(asBasic, { username, password });
      return viaBasic.ok ? viaBasic.sessionAuth : null;
    }
    return null;
  },
  [
    { scheme: "Basic", parameters: { realm: "agent", charset: "UTF-8" } },
    { scheme: "Bearer", parameters: { realm: "agent" } },
  ],
);

export default eveChannel({
  auth: [platformCredential, localDev()],
});
