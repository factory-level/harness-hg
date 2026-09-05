# Endpoints and exposure

**What this page tells you:** how something of yours becomes reachable, and how to ask for a
capability without naming a provider.

| You want | Declare |
|---|---|
| Something of mine should be reachable | `endpoints` |
| I need something that already exists | `requires` |

## Endpoints

### What it means

An endpoint says "this port, on this workload, should have an address". Its `type` says who
may reach it: `internal`, `private`, `authenticated`, `public`, `webhook`, `external`.

### What you write

```yaml
# agents/eve/<name>/harness-hg/endpoints.yaml
endpoints:
  - name: api
    port: 8080
    type: private
```

Your agent's endpoints go at the top level. An endpoint on one of your apps goes inside that
app's entry and names the real rendered Service. `type: webhook` needs a `signature`.

### What you get

The environment decides whether it becomes an ingress or a tunnel, what hostname it gets,
and what authenticates it. The same declaration produces different infrastructure in
different environments. `endpoints` is agent-owned: an override cannot add, remove or retype
one.

## Requires

### What it means

`requires` asks for a capability by name, not a service or a URL.

### What you write

```yaml
requires:
  - capability: object-storage
    inject:
      env: STORAGE_URL
```

`optional: true` means an unsatisfied requirement is not a compile error. Use it when your
application degrades rather than fails.

### What you get

The topology compiler binds it from the team's `capabilities.yaml` or the environment's
grants, and injects the resolved value where you said. Two errors to know:

| Error | Means |
|---|---|
| `TOPO004` | no provider for the capability |
| `TOPO005` | more than one provider. Refused on purpose; a silent winner is a production bug |

## Topology

`topology.supportedLayouts` says which layouts your agent can run in. An environment cannot
deploy you into one you did not list. Placement is the environment's decision; what you
support is yours.

## In Nexus UI

Endpoints appear on a card as links where the environment exposed them. Capability bindings
appear as resolved relationships.

## The exact fields

[Agent team contract](../reference/contracts/agent-team.md). The platform side:
[Networking](../platform/topology.md).
