// Reading a Pulumi stack configuration file WITHOUT Pulumi and WITHOUT decrypting anything
// (ADR 0196): which config paths exist, which carry ciphertext, which are plaintext, empty, or
// still the placeholder the environment generator prints for a secret nobody has set. Paths and
// presence only - no value leaves this module. It has no imports on purpose: the infra program's
// tests load the team reader built on it.

/** What the environment generator emits where a declared secret has no ciphertext yet. Pulumi
 * refuses a whole stack configuration containing it ("validating stack config: bad value")
 * without naming the path, so every reader recognises it by this one constant. */
export const UNSET_SECRET_MARKER = "<UNSET - see findings>";

/** How one config path is filled, judged from the file alone. `opaque`: an ancestor is encrypted
 * as a whole, so what is inside cannot be seen. */
export type ConfigPresence = "encrypted" | "plaintext" | "empty" | "unset" | "absent" | "not-scalar" | "opaque";
export type PathSegment = string | number;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{secure: <ciphertext>}` - Pulumi's spelling of an encrypted leaf or subtree. */
export function isSecureValue(value: unknown): value is { secure: unknown } {
  return isRecord(value) && Object.keys(value).length === 1 && "secure" in value;
}

export function isUnsetSecret(value: unknown): boolean {
  return isSecureValue(value) && value.secure === UNSET_SECRET_MARKER;
}

/** Parse a `pulumi config --path` key: `ns:key.child[0]["dotted.key"]`. Undefined when malformed. */
export function parsePulumiPath(spelled: string): PathSegment[] | undefined {
  const head = /^[^.[\]"]+/.exec(spelled);
  if (!head) return undefined;
  const segments: PathSegment[] = [head[0]];
  let rest = spelled.slice(head[0].length);
  while (rest) {
    const dotted = /^\.([^.[\]"]+)/.exec(rest);
    const indexed = dotted ? null : /^\[(\d+)\]/.exec(rest);
    const quoted = dotted || indexed ? null : /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest);
    if (dotted) segments.push(dotted[1]!);
    else if (indexed) segments.push(Number(indexed[1]));
    else if (quoted) {
      try { segments.push(JSON.parse(`"${quoted[1]}"`) as string); } catch { return undefined; }
    } else return undefined;
    rest = rest.slice((dotted ?? indexed ?? quoted)![0].length);
  }
  return segments;
}

export function formatPulumiPath(segments: readonly PathSegment[]): string {
  return segments.map((segment, i) =>
    typeof segment === "number" ? `[${segment}]`
      : i === 0 ? segment
        : /^[A-Za-z0-9_-]+$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`).join("");
}

/** A bare top-level key belongs to the stack's project, exactly as `pulumi config --path` reads it. */
export function qualifyPath(segments: readonly PathSegment[], project?: string): PathSegment[] {
  const [first, ...rest] = segments;
  return typeof first === "string" && project && !first.includes(":") ? [`${project}:${first}`, ...rest] : [...segments];
}

/** The presence of one config value. `null` counts as empty: the bootstrap would deliver "null". */
export function leafPresence(value: unknown): ConfigPresence {
  if (isSecureValue(value)) {
    if (isUnsetSecret(value)) return "unset";
    return typeof value.secure === "string" && value.secure !== "" ? "encrypted" : "empty";
  }
  if (value === undefined) return "absent";
  if (value === null || value === "") return "empty";
  return typeof value === "object" ? "not-scalar" : "plaintext";
}

/** How the path `spelled` is filled in a parsed stack file (`{config: {...}}`). */
export function configPresence(document: unknown, spelled: string, project?: string): ConfigPresence {
  const parsed = parsePulumiPath(spelled);
  if (!parsed) return "absent";
  let node: unknown = isRecord(document) ? document["config"] : undefined;
  for (const segment of qualifyPath(parsed, project)) {
    if (isSecureValue(node)) return isUnsetSecret(node) ? "unset" : "opaque";
    if (typeof segment === "number") {
      if (!Array.isArray(node) || segment >= node.length) return "absent";
      node = node[segment];
    } else {
      if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, segment)) return "absent";
      node = node[segment];
    }
  }
  return leafPresence(node);
}

/** Every path in a parsed stack file whose value is still the unset placeholder, in file order. */
export function unsetSecretPaths(document: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: PathSegment[]): void => {
    if (isUnsetSecret(node)) { found.push(formatPulumiPath(at)); return; }
    if (isSecureValue(node)) return;
    if (Array.isArray(node)) node.forEach((value, i) => walk(value, [...at, i]));
    else if (isRecord(node)) for (const [key, value] of Object.entries(node)) walk(value, [...at, key]);
  };
  const config = isRecord(document) ? document["config"] : undefined;
  if (isRecord(config)) for (const [key, value] of Object.entries(config)) walk(value, [key]);
  return found;
}
