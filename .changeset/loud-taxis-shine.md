---
'@sledorze/falsestart': patch
---

Fixes `no-then-catch` blocking legitimate Effect code, and corrects a false claim in
`no-unsafe-api`'s note.

**`no-then-catch` no longer blocks namespace combinators it had not been told about.** The rule
exempted its own remedy by listing ten Effect namespace names. That list was wrong twice over: five
of the ten (`Fiber`, `Exit`, `Option`, `Result`, `Schedule`) export no `catch`/`then`/`finally`
member at all, and it missed `HttpClient.catch(...)` — legitimate Effect 4 code — because
`effect/unstable/http` is not re-exported by the root import and nobody thinks to enumerate
subpaths. Writing it was denied, with a message advising `Effect.catch`, which is what the author
was already doing the equivalent of. There was no way to comply.

The exemption is now structural: the receiver must be an `identifier` **node** that is capitalised —
a namespace reference, by the convention every module object follows. That covers every Effect
namespace, present and future, in the root import and in subpaths, with no list to maintain.

This makes the rule strictly **less** likely to block, so it cannot flip a passing repo to failing.
Two consequences to be aware of: a capitalised static method (`SomeClass.catch(...)`) is no longer
matched, and a promise held in a capitalised variable (`const P = fetch(u); P.catch(h)`) is not
matched either. Ordinary promise chaining is unaffected — `promise.catch(h)`, `fetch(u).then(use)`
and `load().finally(cleanup)` are still blocked, and so is `Promise.resolve(v).catch(h)`, whose
receiver is a call expression rather than a namespace reference.

**`no-unsafe-api`'s note no longer claims a mechanism that does not exist.** It said its
38-namespace list "is kept honest by the API-surface lock rather than by anyone remembering to
update it." There is no such lock — the list is hand-maintained, and the sentence turned a known gap
into an apparently closed one for anyone reading the rule to decide whether to trust it. The note
now says so, records that the list is correct as of effect 4.0.0-beta.102, and states the limit it
was hiding: the list covers the root import only, so 21 further risky APIs under `effect/unstable/*`
(`Cookies.makeCookieUnsafe`, `AsyncResult.getOrThrow`, `WorkflowEngine.makeUnsafe`, …) are not
matched. No matching behaviour changes.
