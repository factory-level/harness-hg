# control-plane/dex-sso/

**Purpose.** Identity for the control-plane UIs.

**Chart / machinery.** managed by the bootstrap Pulumi program / identity machinery (`hg identity`, `hg auth prove`).

**Signals.** auth acceptance is `hg auth prove`. Coverage is inventoried per component in #662.
