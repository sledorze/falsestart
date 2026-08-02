---
'@sledorze/falsestart': minor
---

Six new rules, and every rule now blocks.

New: `no-type-assertion` (any `x as T`, allowing `as const` and `as unknown` — widening cannot
lie, and import/export aliases are a different AST node so they were never matched),
`no-raw-coercion` (`String`/`Number`/`Boolean`/`!!`, exempting the rendering of a caught
throwable), `no-raw-error` (built-in `Error` constructors, pointing at `Data.TaggedError`),
`no-vi-mocking` and `no-test-lifecycle-hooks` (both applying **only** to test files, the inverse of
every other rule), and `prefer-smart-constructor`.

**Every rule is `error` severity, so every rule blocks.** `prefer-smart-constructor` in particular
fires on any object literal with a declared type; it excludes `Record`/`Map`/array annotations, but
expect to narrow its `files` globs for your own repo rather than to soften it.

Rule messages now name concrete Effect APIs, and a test checks that every API named in a message
actually exists. Four were already wrong — `Effect.async`, `Effect.catchAll`, `Config.integer` and
`Schema.decodeUnknown` do not exist in Effect 4 — so a rule could block your code and then advise a
remedy that does not compile.

Findings below `error` severity are now surfaced as a `systemMessage` instead of being discarded.
Previously a `warning` rule did nothing observable at all.
