// OpenTelemetry export (docs/guides/instrumentation). @vercel/otel reads the
// standard OTEL_EXPORTER_OTLP_* variables, so the platform chooses the
// collector by injecting OTEL_EXPORTER_OTLP_ENDPOINT (hermes-gitops.yaml
// `requires` with `optional: true`): unset, nothing is exported and the
// setup is a no-op; set, every turn lands as ai.eve.turn spans. Inputs and
// outputs stay unrecorded (eve's default) - enable them only after
// reviewing the collector's retention.
import { defineInstrumentation } from "eve/instrumentation";
import { registerOTel } from "@vercel/otel";

export default defineInstrumentation({
  setup: ({ agentName }) => {
    if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return;
    registerOTel({ serviceName: agentName });
  },
  traceChannelRequests: true,
});
