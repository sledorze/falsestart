---
'@sledorze/falsestart': minor
---

A leading `!` in `files` or `ignores` is now refused at load, in rule documents and config overrides
alike.

**This can turn a previously-loading rule set into a hard failure, and that is the point** — the rule
set was not doing what it looked like it was doing.

The globs are matched as an OR, so `files: ['src/**/*.ts', '!**/*.test.ts']` admits every path that
is _not_ a test file. Measured against the real binary, that rule fired on:

- `docs/README.md` — a Markdown file, from a rule declaring `language: tsx`
- `lib/x.js` — outside `src` entirely
- `src/a.test.ts` — the file the negation was written to exempt

Nothing failed and nothing warned. A rule acting on files its globs never admitted is the exact
failure the content-mutation safety rule in `AGENTS.md` exists to prevent, reached from the other
direction: not a pattern that matched too loosely, but a scope that silently stopped being a scope.
It reads like the exclusion syntax every other tool has, which is what made it dangerous.

`ignores` is the mechanism, applied after `files` precisely so an exclusion cannot widen anything:

```yaml
files:
  - 'src/**/*.ts'
ignores:
  - '**/*.test.ts'
```

A `!` anywhere other than the first character is untouched — it is a legal path character.
