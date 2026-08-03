---
'@sledorze/falsestart': minor
---

Two rules for Effect's throwing APIs.

`no-throwing-decode` flags `Schema.decodeUnknownSync` and its `decode`/`encode` siblings, which
return a value or throw — the signature promises a decoded value unconditionally, which is the lie
decoding exists to stop telling. Use `Schema.decodeUnknownEffect`, or `decodeUnknownResult` when you
want a value rather than an Effect.

`no-unsafe-api` flags Effect's `Unsafe`/`OrThrow`-suffixed escape hatches — `Context.makeUnsafe`,
`Chunk.headUnsafe`, `Result.getOrThrow` — in favour of the total counterparts that return an Option,
a Result or an Effect.

**Both pin the namespace, not just the method name.** `Sync` is not a signal on its own: Effect also
uses it for LAZY constructors (`Effect.failSync`, `Deferred.failSync`, `Channel.endSync`) that take
a thunk and throw nothing, so the rule pins the `decode`/`encode` verb too. And `Unsafe` is a
convention anyone may adopt, so `myOwnHelper.readUnsafe(path)` is deliberately not matched — the
rule lists the 38 Effect namespaces that actually export such a name.

Not ruled, deliberately: `Schema.Class` constructors do validate and throw, but banning
`new Widget({ id, size })` would contradict `prefer-smart-constructor`, which recommends exactly
that. The construct is not the problem — the provenance of its input is, and that is invisible to a
syntactic matcher.
