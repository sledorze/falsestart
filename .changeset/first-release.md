---
'@sledorze/falsestart': minor
---

First release.

falsestart runs as a Claude Code `PreToolUse` hook and blocks risky code patterns at the moment an
agent writes them, before the file lands. Rules are [ast-grep](https://ast-grep.github.io)
documents, so the same file stays readable by the upstream CLI.

**Twenty rules, in two presets.** `clean-code` is four TypeScript rules and assumes nothing else:
`no-as-any`, `no-as-never`, `no-double-cast`, `no-type-assertion`. `effect` is sixteen that assume
an Effect codebase — they forbid `await`, `try/catch`, `new Promise`, `.then`, `JSON.parse`,
`fetch`, `process.env`, `process.exit`, raw `Error`, raw coercion, Effect's `Unsafe`/`OrThrow`
escape hatches and its throwing `Sync` decoders, plus three that apply only to test files. Pick
deliberately: on an ordinary async function `--preset all` produces seven blocks, which is correct
in an Effect repo and wrong everywhere else. Every rule is `error` severity and scoped to
`**/*.{ts,tsx,mts,cts}`.

**Rules from anywhere.** `--preset <name>` for the shipped set, `--rules <dir>` for your own,
`--rules pkg:@acme/falsestart-rules` for another package's.

**Per-repo scoping without editing rules.** `falsestart.config.{ts,mts,js,mjs,json}` re-scopes any
loaded rule's `files`/`ignores`. A TypeScript config is type-checked against the exported
`FalsestartConfig`, so a mistyped rule id is a compile error in your editor. An override naming a
rule that is not loaded is an error rather than a no-op.

**`--doctor`.** Every misconfiguration a hook can have degrades to the same place — exit 1, a line
on stderr the runtime swallows, and the write proceeding — so a hook that enforces nothing looks
exactly like one with nothing to say. `--doctor` reports what was resolved, how many rules reach
each of five probe paths, and sends a real violation through the real decision path. Read the scope
block: a nested probe path is what exposes a `src/**.ts` glob that guards top-level files only.

**Also exported as a library**, for building your own checks: `checkFile`, `loadRules`, `parseRule`,
`appliesTo`, `decide`, `respond`, `diagnose`, config helpers and the rule-authoring test helpers.

### Known limits, stated rather than discovered

- **`Bash` is not judged.** falsestart inspects the text a write tool carries, so a heredoc or shell
  redirect writes a file it never sees. A guard rail, not a sandbox.
- **Matching is syntactic.** `import { Chunk as C }` then `C.headUnsafe(c)` is not matched; a local
  object named `Chunk` is. Rules record spellings, not APIs.
- **`.js`, `.jsx`, `.mjs`, `.cjs` are excluded by design.** The assertion rules match syntax that
  does not exist in JavaScript, and `.js` in a TypeScript repo is usually generated or build code.
- **A `.ts` config is type-stripped and imported without a filesystem location**, so it may use
  type-only imports but not value imports. Use `.mjs` if you want the `makeConfigUnsafe` smart
  constructor.
- **`no-unsafe-api` covers the root `effect` import only.** Twenty-one risky APIs live in
  `effect/unstable/*` subpaths and are not matched; widening would pull in `Headers` and `Worker`,
  which are ordinary identifiers.
