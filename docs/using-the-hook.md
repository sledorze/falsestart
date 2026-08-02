# Using the hook

falsestart runs as a Claude Code `PreToolUse` hook. It reads the tool call on stdin and answers
with a decision, so a rule violation is caught as the code is written rather than at CI.

## Register it

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "falsestart --preset all" }],
      },
    ],
  },
}
```

Rules can come from three places:

| Source                  | How                                                     |
| ----------------------- | ------------------------------------------------------- |
| Shipped with falsestart | `--preset all` (or `clean-code`, `effect`)              |
| Your own repo           | `--rules ./rules` — any directory, searched recursively |
| Another package         | `--rules pkg:@acme/falsestart-rules`                    |

`--preset` and `--rules` are mutually exclusive; giving both is refused rather than ranked.

A package specifier may name a subdirectory — `pkg:@acme/falsestart-rules/strict` — to take part of
a rule set. The package is expected to keep its rules in a `rules/` directory, as falsestart does,
and is resolved from **your project**, so it is found wherever your package manager put it rather
than at a guessed `node_modules` path that pnpm's layout does not have.

The `pkg:` prefix is required rather than inferred. `--rules rules` has always meant the `rules/`
directory, and quietly reinterpreting a bare name as a package would change which rule set an
existing setup loads — the worst failure available to a tool whose job is enforcing a rule set.

A package that will not resolve is reported and does not block, like every other misconfiguration:
a missing dependency must not stop every write in the repo.

## Publishing your own rules

A rules package is a directory of ast-grep documents under `rules/` and nothing more:

```
@acme/falsestart-rules/
  package.json
  rules/
    strict/no-console.yml
```

The `matcher` is an optimisation, not a safety boundary — falsestart ignores tool calls it has no
opinion about, and does not even load the rule tree for them.

## What it does

| Situation                                 | Behaviour                                                      |
| ----------------------------------------- | -------------------------------------------------------------- |
| Write/Edit matching an `error` rule       | Blocked, with the rule's message                               |
| Write/Edit matching a softer rule         | Allowed; advice that blocks is indistinguishable from an error |
| Path outside the rule's `files`/`ignores` | Rule never runs                                                |
| Any other tool                            | Ignored                                                        |
| Rule tree will not load                   | Visible error, write proceeds                                  |
| A rule cannot run                         | Visible error, write proceeds                                  |

The last two are deliberate. A guard that refuses to run should say so loudly, but a typo in a
rule file should not hold a repository hostage.

## Choosing rules

The shipped corpus lives in [`rules/`](../rules) and is split by what it assumes:

- `rules/clean-code/` — generic TypeScript. No framework assumptions.
- `rules/effect/` — assumes an Effect codebase. `no-await` in particular forbids a construct most
  TypeScript projects use freely, so adopt this directory only if that is what you want.

Point `--rules` at a directory holding only the subset you want. Which rules are _active_ is decided
by which rule documents are present, so the answer to "what is enforced here" is a directory
listing.

## Re-scoping a rule to your layout

A rule ships with `files`/`ignores` chosen by an author who does not know your directory structure.
A config re-scopes it without touching the rule. Write it in TypeScript and the compiler checks it:

```ts
// falsestart.config.ts
import type { FalsestartConfig } from '@sledorze/falsestart'

export default {
  rules: {
    'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] },
    'no-await': { files: ['src/**/*.ts'], ignores: ['src/legacy/**'] },
  },
} satisfies FalsestartConfig
```

Use a **type-only** import here. A `.ts` config has its types stripped and is imported without a
filesystem location, so it cannot resolve a value import; `import type` is erased and works.

A `.mjs` config is imported from its real path and may import anything, including the smart
constructor:

```js
// falsestart.config.mjs
import { makeConfigUnsafe } from '@sledorze/falsestart'

export default makeConfigUnsafe({
  rules: { 'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] } },
})
```

`makeConfigUnsafe` validates and throws at import, so a malformed config fails at the config file
rather than somewhere downstream. `makeConfig` is the same check returning an `Effect`, for
building a config in code. Prefer `.mjs` over `.js`: a `.js` config in a package without
`"type": "module"` makes Node reparse it and warn.

JSON works too, with the same shape and no type checking.

`files` is **required**. An override exists to say where a rule applies in _this_ repo, and one
that adjusts only `ignores` leaves that answer inherited from someone who never saw your layout.

`ignores` is optional, and omitting it keeps the rule's own — narrowing where a rule looks must not
quietly discard the test-file exemption its author wrote.

Without `--config`, falsestart looks for `falsestart.config.{ts,mts,js,mjs,json}` beside the rules
directory. None present means no overrides. **Two** present is an error rather than a precedence
rule: silently picking one of two configs is the kind of quiet wrong answer this tool exists to
prevent. A config named explicitly with `--config` must exist.

An override naming a rule that is not loaded is an error rather than a no-op, because a typo'd id
would otherwise be a scope change that silently never happens. `ShippedRuleId` is exported if you
want that caught at compile time instead.

This is the supported answer when a rule fires somewhere it should not. Editing the rule documents
under `node_modules` is not: the next install undoes it.

## Writing a rule

A rule is an [ast-grep](https://ast-grep.github.io) rule document. `id`, `language`, and `rule` are
required; `message`, `severity`, `files`, `ignores`, `constraints`, and `utils` are optional.

```yaml
id: no-as-any
language: tsx
severity: error
message: '`as any` erases the type rather than establishing it.'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,tsx}'
ignores:
  - '**/*.test.{ts,tsx}'
```

Scope every rule with `files`. A rule with no `files` runs against every path, including ones
where its language makes no sense.

Globs are matched against the path **relative to the project root** the hook reports (`cwd`), so
`src/**/*.ts` works as written. A file outside that root keeps its absolute path, and a rule can
still reach it with a leading `**/`.

Notebooks are scoped by the notebook's own path, not by the cell's language. A rule scoped to
`**/*.ts` will not see TypeScript typed into a `.ipynb` cell — add `**/*.ipynb` to its `files` if
you want it to.

## Shared matchers

A matcher needed by several rules goes in a `_utils/` directory inside the rule tree, where every
rule can reference it by name:

```yaml
# rules/_utils/any-keyword.yml
id: anyKeyword
rule:
  kind: predefined_type
  regex: '^any$'
```

```yaml
# rules/type-safety/no-any-assertion.yml
rule:
  kind: as_expression
  has:
    matches: anyKeyword
```

Documents under `_utils/` are fragments, not rules: they need only `id` and `rule`, and they never
match on their own. A rule's own `utils:` block wins a name collision — the shared set is a
default, not an override.

Give every rule worked examples of both kinds — code it must catch and code it must leave alone.
`assessRule` runs them, and the second kind is the one that matters: a rule with only positive
examples looks correct right up until it fires on something nobody meant to forbid.
