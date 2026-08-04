---
'@sledorze/falsestart': minor
---

New `effect` rule: `no-effect-assertion` — and it is the first rule that judges your test files.

**This can turn a previously-passing repo red, including one that changed nothing.** It is `error`
severity and lives in `effect`, so `--preset effect` and `--preset all` gain it automatically. Unlike
every other assertion rule it has **no test-file exemption**, so a repo whose sources are clean can
still go red on a helper in `*.test.ts`.

It catches asserting a value INTO an Effect type — `x as Effect.Effect<A>`, and the same for
`Stream`, `Layer`, `Sink`, `Channel`, `Fiber`, `Deferred` and `STM`. Those type parameters are the
error and requirement channels; asserting into them tells the compiler to stop tracking what can fail
and what must be provided, and the failure resurfaces at runtime with nothing in the signature that
predicted it. The usual shape is a pipeline whose inferred error channel is not `never`, cast until
it compiles:

```ts
const stdout = handle.stdout.pipe(decodeText, mkString) as Effect.Effect<string>
```

That says "this cannot fail" about a stream that can.

**Why no test exemption, when every other assertion rule has one.** That exemption is real and stays:
a mock needs `as never` to satisfy a signature it will never honour, and this rule leaves that
completely alone — asserted as a case, not assumed. But the exemption is a whole-file blanket, and it
was also waving through coercions that erase an error channel. This was found by falsestart failing
to do its job on its own repo: three of these reached `main` in test files while the hook was wired,
running, and correctly allowing them. Piping identical content at two paths through the built binary
returned `deny` for `src/packaging.ts` and silence for `src/packaging.test.ts`. A helper claiming an
infallible stream is exactly as wrong as a source file claiming one, and less likely to be read.

It matches the TYPE being asserted to, never a variable's name and never the expression, so a value
called `effect` is not the subject. `as const`, `as unknown` and an ordinary `const run:
Effect.Effect<string> = …` annotation are untouched — the annotation is the remedy the message names,
so it could never be the offence.

TypeScript-only, like the other five assertion rules: valid JavaScript has no `as` expression to find.

To keep the old behaviour, scope it away in `falsestart.config.ts`:

```ts
export default {
  rules: { 'no-effect-assertion': { files: ['src/**/*.{ts,tsx,mts,cts}'], ignores: ['**/*.test.*'] } },
} satisfies FalsestartConfig
```
