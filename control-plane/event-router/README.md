# control-plane/event-router/

**Purpose.** The communication plane: typed events, durability, ordering, DLQ.

**Chart / machinery.** `chart/` (re-homed by ADR 0163) + `image/` (the router container build).

**Signals.** `hg event` / `hg communication prove` are its acceptance surface. Coverage is inventoried per component in #662.
