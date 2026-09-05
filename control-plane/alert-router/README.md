# control-plane/alert-router/

**Purpose.** The alerting library chart (`lib/` — was charts/hermes-alerting): receivers guard + shared alert templates.

**Chart / machinery.** `lib/` is a library, never deployed; committed copies live inside the monitoring and fleet-dashboard charts (`make alerting-lib`).

**Signals.** rename from hermes-alerting tracked in the naming ledger (#649). Coverage is inventoried per component in #662.
