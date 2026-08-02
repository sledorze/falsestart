# Using the hook — summary

falsestart runs as a Claude Code `PreToolUse` hook: register it in `.claude/settings.json` with a
`Edit|Write` matcher and `falsestart --rules <dir>`. `--rules` is searched recursively and defaults
to `.falsestart/rules`. The matcher is an optimisation, not a safety boundary — tool calls
falsestart has no opinion about are ignored without even loading the rule tree.

Behaviour: an `error`-severity match blocks with the rule's message; softer severities do not
block; a path outside a rule's `files`/`ignores` never runs it; other tools are ignored. A rule
tree that will not load, or a rule that cannot run, produces a visible error while letting the
write proceed — loud, but not able to hold a repository hostage.

The shipped corpus in `rules/` is split by assumption: `rules/clean-code/` is generic TypeScript,
`rules/effect/` assumes an Effect codebase (`no-await` forbids a construct most projects use
freely). Selection is by which rule documents are present, not by a runtime toggle, so "what is
enforced here" is a directory listing.

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
