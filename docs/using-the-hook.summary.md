# Using the hook — summary

falsestart runs as a Claude Code `PreToolUse` hook: register it in `.claude/settings.json` with a
`Edit|Write|NotebookEdit` matcher and the CLI invoked by PATH (`node .../dist/cli.js`), because
`node_modules/.bin` is not on a hook's `PATH` and a bare name exits 127 while looking registered.
Settings must be strict JSON. `--doctor` answers "is this guarding anything?" — it prints the
version that answered, the resolved rules, config and per-path rule counts, then sends a real
violation through the decision path. Read its scope block, not just its last line: a nested probe
path is what exposes the `src/**.ts` glob typo that guards top-level files and nothing else. Read
its version line too — a hook wired at a path holding an older copy describes that copy, plausibly. `--rules` is searched recursively and defaults
to `.falsestart/rules`. The matcher is an optimisation, not a safety boundary — tool calls
falsestart has no opinion about are ignored without even loading the rule tree.

`--warn-unscoped` answers the same question for the paths the repo actually writes: a judged write
no rule is scoped to reports itself instead of passing in silence, non-blocking, and it cannot
pre-empt a block since a rule that could block is a rule that applies. Off by default because the
signal is noisy — measured on the shipped presets it fires on every `.md`, `.json` and `.yml`
write under all three. JavaScript and test files are the preset-dependent rows: `clean-code`'s four
rules key on TypeScript syntax and ignore tests, so both warn under it, while `effect` covers both.

Behaviour: an `error`-severity match blocks with the rule's message; softer severities do not
block; a path outside a rule's `files`/`ignores` never runs it; other tools are ignored. A rule
tree that will not load, or a rule that cannot run, produces a visible error while letting the
write proceed — loud, but not able to hold a repository hostage.

The shipped corpus in `rules/` is split by assumption: `rules/clean-code/` is generic TypeScript,
`rules/effect/` assumes an Effect codebase (`no-await` forbids a construct most projects use
freely). Selection is by which rule documents are present, so "what is enforced here" is a directory
listing. Rules come from three sources: `--preset all|clean-code|effect` for the shipped set,
`--rules <dir>` for your own, and `--rules pkg:@acme/falsestart-rules[/subdir]` for another
package, resolved from your project rather than a guessed node_modules path. The `pkg:` prefix is
required rather than inferred, so an existing `--rules rules` keeps meaning the directory. A rules
package is just a `rules/` directory of ast-grep documents. Where each rule applies is re-scopable per repo via `falsestart.config.{ts,mts,js,mjs,json}`
(or `--config <file>`). A TypeScript config is type-checked against the exported `FalsestartConfig`
and `ShippedRuleId`; use a type-only import, since a `.ts` config is type-stripped and imported
without a filesystem location. `files` is required in an override; `ignores` is optional and, when
omitted, the rule keeps its own. Two competing default configs are an error rather than a
precedence rule, and an override for a rule that is not loaded is an error, not a silent no-op.

Rules are ast-grep documents needing `id`, `language`, and `rule`, optionally `message`,
`severity`, `files`, `ignores`, `constraints`, `utils`. Always scope with `files`, and give every
rule worked examples of both kinds — the must-not-fire examples are the ones that catch a rule
turning into a nuisance.

`files` globs match the path relative to the project root the hook reports, so `src/**/*.ts` works
as written; a file outside that root keeps its absolute path. Notebooks scope by the notebook's own
path, so a `**/*.ts` rule does not see TypeScript in a `.ipynb` cell.

A matcher shared by several rules lives in a `_utils/` directory inside the rule tree and is
referenced by `matches:`. Those documents need only `id` and `rule`, are not rules themselves, and
lose a name collision to a rule's own `utils:` block.
