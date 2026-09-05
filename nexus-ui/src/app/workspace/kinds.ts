// The frozen 8-kind registry (#399, carried verbatim): the single
// authority for palette, picker and placement. The freeze is the point -
// the old vocabulary hit 25 entries before it was frozen.
export interface KindDef {
  id: string;
  label: string;
  family: "people" | "agents" | "tools" | "communication";
  /** Plan-sourced kinds are placeable by REFERENCE only - "you cannot
   * invent an agent by naming one". */
  planSourced: boolean;
}

export const DOMAIN_KINDS: KindDef[] = [
  { id: "person", label: "Person", family: "people", planSourced: true },
  { id: "group", label: "Group", family: "people", planSourced: true },
  { id: "agent", label: "Agent", family: "agents", planSourced: true },
  { id: "agent-bundle", label: "Agent bundle", family: "agents", planSourced: true },
  { id: "tool", label: "Tool", family: "tools", planSourced: true },
  { id: "external-tool", label: "External tool", family: "tools", planSourced: false },
  { id: "comm-in", label: "Inbound events", family: "communication", planSourced: false },
  { id: "comm-out", label: "Outbound events", family: "communication", planSourced: false },
];

export const FAMILIES: Array<{ id: KindDef["family"]; label: string }> = [
  { id: "people", label: "People" },
  { id: "agents", label: "Agents" },
  { id: "tools", label: "Tools" },
  { id: "communication", label: "Communication" },
];
