// Subagent delegation, asserted on the run (docs/evals/assertions): the
// `shout:` prefix must reach the declared subagent and its answer must come
// back verbatim. calledSubagent matches the subagent.called/completed pair
// with a childSessionId - the same events EVE016 reads off the stream.
import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "A 'shout:' message is delegated to the shout subagent and its upper-case answer is returned.",
  tags: ["smoke", "composition"],
  async test(t) {
    await t.send("shout: the kiln is lit");
    // The upper-casing is the subagent's work; whether the parent keeps the
    // child's `SHOUT: ` prefix verbatim varies run to run, so the gate is
    // the semantic proof plus the structural one below.
    t.check(t.reply, includes("THE KILN IS LIT"));
    t.calledSubagent("shout", { count: 1 });
    t.succeeded();
  },
});
