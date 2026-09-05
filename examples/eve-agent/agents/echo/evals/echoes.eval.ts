// The echo agent's own eve eval (docs/evals): drives the agent through its
// real session API and asserts on the run. Deterministic - no judge - so it
// runs against the deployed agent with nothing but the platform's minted
// credential (`hg agent evals`, which is `eve eval --url` from inside the pod).
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "The reply is the prompt prefixed 'echo: ', with no tool use, across two turns of one session.",
  tags: ["smoke"],
  async test(t) {
    await t.send("the factory hums at night");
    const first = t.sessionId;
    t.check(t.reply, includes("echo: the factory hums at night"));

    // A follow-up on the SAME session (eve's documented multi-turn shape).
    const second = await t.send("and the kiln glows");
    second.expectOk();
    if (t.sessionId !== first) {
      throw new Error(`expected one session; got ${first} then ${t.sessionId}`);
    }
    t.check(second.message, includes("echo: and the kiln glows"));

    // eve 0.42.0 names the run-level assertions succeeded()/parked() (its
    // bundled docs still say completed()/waiting(); the shipped typings and
    // runtime agree on these).
    t.succeeded();
    t.usedNoTools();
  },
});
