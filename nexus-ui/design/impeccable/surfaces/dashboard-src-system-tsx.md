---
version: 1
slug: "dashboard-src-system-tsx"
primary_target: "dashboard/src/system.tsx"
related_targets: ["dashboard/src/index.tsx","dashboard/src/mark.tsx"]
---

# System (Hermes control plane) — surface brief

Scope: `#/system` view (dashboard/src/system.tsx), entered via the Hermes Hg logo
in the global header. Visitor mode: Operate.

Audience/job: fleet operator entering "the control plane itself" — understand what
Hermes runs for them (capabilities, not vendors), check each capability's health
evidence on demand, and manage People & Groups.

Chosen direction (seed f66afbfc, assigned lead, structure #4 of ranked list):
ORBITAL MANDALA — the animated Hermes sphere (HermesMarkLive) as nucleus, capability
arc segments on two orbital tiers: inner orbit = core control plane (synchronization,
monitoring, alert routing, queueing), outer orbit = edge-facing (connectivity,
webhook ingress, people & groups, Nexus itself). Hover lights an arc + its label;
click opens the capability detail panel (radial-anchored, dimmed backdrop) with
health evidence, vendor implementation named only inside the panel, and deep links.
People & Groups panel is a management surface (create/edit people and groups).

Memorable moment: the nucleus breathes (existing HermesMarkLive animation) and the
hovered orbit arc brightens with its capability constellation while all else recedes.

Constraints: established nx-* visual world (style.css tokens, light/dark), SDK React,
no vendor names at first level, no card wall, no firing-alert wall on landing,
truth-over-green (unknown health reads unknown). Fleet Canvas loses its System
affordance; header brand becomes the doorway.

Unresolved: exact capability slice list may grow; People & Groups persistence rides
the existing nexus save-state path (deliberate lazy choice, upgrade to dedicated
store when multi-user editing matters).
