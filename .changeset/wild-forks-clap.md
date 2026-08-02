---
'@sledorze/falsestart': patch
---

Fixes `no-then-catch` blocking `Effect.catch`, the remedy its own message recommends.

The rule matched `$EXPR.catch(...)` regardless of receiver, so `program.pipe(Effect.catch(recover))`
was denied — the rule blocked the fix it asked for. Effect's own namespaces are now exempt.

Found by a new gate rather than by review: a corpus of ordinary, idiomatic, rule-abiding code that
no rule may flag. Per-rule examples prove a rule catches what its author aimed at; they cannot prove
it is not also catching half the language. A rule matching `$OBJ.$METHOD($$$ARGS)` passes an
examples-only gate and then blocks essentially every write — measured at 148 matches across this
repo's own sources — which is how the hole was demonstrated before it was closed.

Rules must also now carry examples of both kinds. Previously a rule could ship with only positive
examples, which is exactly the shape that looks correct until it fires on innocent code.
