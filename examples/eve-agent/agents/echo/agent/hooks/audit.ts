// An observe-only hook (docs/guides/hooks): fires after the event, cannot
// inject model context, a throw surfaces as turn.failed. One JSON line per
// completed turn on stdout, which is the pod log - the platform's log
// pipeline picks it up like any other container line.
import { defineHook } from "eve/hooks";

export default defineHook({
  events: {
    async "turn.completed"(event, ctx) {
      console.info(
        JSON.stringify({
          audit: "turn.completed",
          agent: ctx.agent.name,
          sessionId: ctx.session.id,
          turnId: (event as { turnId?: string }).turnId ?? null,
        }),
      );
    },
  },
});
