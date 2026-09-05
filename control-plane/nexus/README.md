# control-plane/nexus/

**Purpose.** The operations canvas (read-only fleet surface).

**Chart / machinery.** `chart/` serves the committed projection `chart/files/` of this directory (`make chart-test` gates drift; regenerate with `infra/scripts/sync-nexus-chart.sh`).

**Signals.** This directory IS the re-homed installable unit (#666–#668, built from `nexus-ui/`). Coverage is inventoried per component in #662.
