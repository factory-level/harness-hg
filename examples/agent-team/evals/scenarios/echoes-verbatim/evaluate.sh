#!/usr/bin/env sh
# Exit 0 = pass, 1 = assertion failed, anything else = harness error (the
# evals contract). The runner put the agent's reply in $HG_EVAL_RESPONSE.
set -eu
reply="$(tr -d '\r' < "$HG_EVAL_RESPONSE")"
want='echo: the factory hums at night'
if [ "$(printf '%s' "$reply" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" = "$want" ]; then
  echo "reply is the prompt prefixed 'echo: '"
  exit 0
fi
echo "expected '$want', got: $reply"
exit 1
