// Subagent delegation, asserted on the run: a `shout:` message must reach
// the declared subagent and its answer must come back. calledSubagent
// matches the subagent.called/completed pair, the same events EVE016 reads.
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "A 'shout:' message is delegated to the shout subagent and its upper-case answer is returned.",
  tags: ["smoke", "composition"],
  async test(t) {
    await t.send("shout: the kiln is lit");
    t.check(t.reply, includes("THE KILN IS LIT"));
    t.calledSubagent("shout", { count: 1 });
    t.succeeded();
  },
});
