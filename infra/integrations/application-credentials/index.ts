import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

const config = new pulumi.Config();
const requested = config.requireObject<Record<string, "base64" | "base64url">>("credentials");
if (!requested || typeof requested !== "object" || Array.isArray(requested) || !Object.keys(requested).length) throw new Error("Credential generation requires a nonempty mapping");
export const credentials = Object.fromEntries(Object.entries(requested).map(([name, encoding]) => {
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name) || !["base64", "base64url"].includes(encoding)) {
    throw new Error("Credential generation requires a DNS-label name and base64/base64url encoding");
  }
  const bytes = new random.RandomBytes(name, { length: 32 }, { protect: true });
  return [name, pulumi.secret(bytes.base64.apply(value => encoding === "base64url"
    ? Buffer.from(value, "base64").toString("base64url") : value))];
}));
