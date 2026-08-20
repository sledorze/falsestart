---
'@sledorze/falsestart': minor
---

Move to Effect `4.0.0-rc.111`, and say so in `peerDependencies`.

**This can flip a previously-installing consumer to failing**, which is why it is a minor rather than
a patch: `peerDependencies` moves from `^4.0.0-beta.100` to `^4.0.0-rc.111` for both `effect` and
`@effect/platform-node`. A project still on the 4.0 beta line will now get a peer warning, or an
install failure under strict peer resolution. The old range was in any case an untested claim — CI
had been testing beta.102 alone, and never any beta from `.100` upward.

The only source change the upgrade required: `Schema.UnknownFromJsonString` no longer exists.
Effect's own Schema migration guide maps v3's `parseJson()` to `UnknownFromJsonString` and
`parseJson(schema)` to `fromJsonString(schema)`; the former was then removed inside the v4 line,
leaving `fromJsonString(schema, options?)` as the single JSON-string helper. Every call site now
composes it as `Schema.fromJsonString(Schema.Unknown)`, which is the same decode.

Verified rather than assumed, on the built binary: malformed input is still refused
(`could not read the hook payload as JSON (SchemaError(Expected a valid JSON string))`, exit 1), a
valid payload is still parsed and judged, and a clean write still passes with exit 0.

No behaviour change otherwise. 803 tests, 100% coverage and the full check suite pass on rc.111.
