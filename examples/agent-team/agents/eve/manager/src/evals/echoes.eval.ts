// The agent's own eve eval: drives the real session API and asserts on the
// run. Deterministic, so it runs against the deployed agent with nothing
// but the platform's minted credential (`hg agent evals`).
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "The reply is the prompt prefixed 'echo: ', with no tool use, across two turns of one session.",
  tags: ["smoke"],
  async test(t) {
    await t.send("the factory hums at night");
    const first = t.sessionId;
    t.check(t.reply, includes("echo: the factory hums at night"));

    const second = await t.send("and the kiln glows");
    second.expectOk();
    if (t.sessionId !== first) {
      throw new Error(`expected one session; got ${first} then ${t.sessionId}`);
    }
    t.check(second.message, includes("echo: and the kiln glows"));

    t.succeeded();
    t.usedNoTools();
  },
});
