# Using the hook — summary

falsestart runs as a Claude Code `PreToolUse` hook: register it in `.claude/settings.json` with a
`Edit|Write|NotebookEdit` matcher and the CLI invoked by PATH (`node .../dist/cli.js`), because
`node_modules/.bin` is not on a hook's `PATH` and a bare name exits 127 while looking registered.
Settings must be strict JSON. Guarding shell commands is a second `PreToolUse` entry beside this one
— the intended arrangement, not a workaround, since a `matcher` makes the two select disjoint sets
of tool calls, and on a call falsestart does not judge it writes nothing to either stream and exits
0 before its rule tree is read. `--doctor` answers "is this guarding anything?" — it prints the
version that answered, the resolved rules with how many of them declare a blocking severity and how
many advise (a severity tally, not a reachability claim — the scope block answers that), config
and per-path rule counts, then sends a real
violation through the decision path. Read its scope block, not just its last line: a nested probe
path is what exposes the `src/**.ts` glob typo that guards top-level files and nothing else. Read
its version line too — a hook wired at a path holding an older copy describes that copy, plausibly.
Under it, a `changes` line names the changelog inside that same copy, because a version number alone
cannot say that a MINOR bump added an `error`-severity rule and turned a green repo red (`0.2.0` did
it twice); the line is absent on versions published before it existed, which shipped no changelog at
all. `--rules` is searched recursively and defaults
to `.falsestart/rules`. The matcher is an optimisation, not a safety boundary — tool calls
falsestart has no opinion about are ignored without even loading the rule tree.

`--list-rules` prints the resolved rule set as JSON — the assertable counterpart to `--doctor`'s
prose — so a repo can pin that the hook and the CI gate load the same rules; one rule per line
sorted by id, exit 0 with the document and 2 when it could not be produced, and the config's
`exclude` is deliberately not in it.

`--warn-unscoped` answers the same question for the paths the repo actually writes: a judged write
no rule is scoped to reports itself instead of passing in silence, non-blocking, and it cannot
pre-empt a block since a rule that could block is a rule that applies. Off by default because the
signal is noisy — measured on the shipped presets it fires on every `.md`, `.json` and `.yml`
write under all three. Test files are the preset-dependent row: all six `clean-code` rules ignore
them, so they warn under it, while `effect` carries three rules that exist to judge them.

**`falsestart scan [paths…]`** is the second enforcement point, for a git hook or CI, because the
write-time hook sees only `Edit`/`Write`/`NotebookEdit` — a `Bash` heredoc, any git operation, an
editor, another agent and every pre-existing file bypass it. Paths come from the caller (lefthook's
`{staged_files}`/`{push_files}`, husky's `git diff`), never discovered; use `-z`/`-0`, since git
C-quotes non-ASCII paths into something that opens as ENOENT. `{push_files}` is the whole tree on a
branch's first push. `node_modules` and `.git` are always excluded and `.gitignore` is honoured via `git check-ignore`
(best-effort), while `dist`/`build`/`vendor` are not, since projects author real source there;
`--exclude <glob>` covers the rest and every exclusion is counted. Exit codes are its own contract — 0 clean, 1 findings, 2 could-not-run — and it
fails CLOSED where the hook fails open, because a gate that cannot run must stop rather than pass
everything. It judges whole files where the hook judges introduced text, so it is strictly stricter:
64% of real TypeScript files already carry a finding, which is what `--baseline`/`--update-baseline`
absorb — one entry per occurrence, so accepting two identical lines does not accept a third, and a
baseline that exists but cannot be read exits 2 rather than silently accepting nothing. Every run prints `scanned N, M in scope, K finding(s)`; `M = 0` is the signal that a run
enforced nothing, which otherwise looks identical to success.

Behaviour: an `error`-severity match blocks with the rule's message; softer severities do not
block; a path outside a rule's `files`/`ignores` never runs it; other tools are ignored. A rule
tree that will not load, or a rule that cannot run, produces a visible error while letting the
write proceed — loud, but not able to hold a repository hostage.

A rule declaring `warning`, `info` or `hint` is shown to the author as
`{"systemMessage":"falsestart:\n<rule-id> (<line>:<column>): <message>"}` and decides nothing — a
different JSON document from a denial's `hookSpecificOutput`, not the same one with another verdict,
and the same envelope `--warn-unscoped` uses. Severity is a field of the rule document, so one rule
has one severity everywhere it is loaded: a rule that must block in a curated tree and advise in a
wider one exists twice, as two ids or as one document reached by two hook entries, kept in step by
hand.

Laying out a large tree: subdirectories are organisational only, ids are unique across the whole
tree (a duplicate refuses the load), and every matching rule is reported together. `--rules` names
one rule source per invocation and cannot be combined with `--preset`, so layering two trees means
two hook entries — which also gives each its own config and severity policy. The cost of splitting:
a root `_utils/` is out of scope for an entry pointing at one subdirectory, and a rule referencing a
matcher it cannot see fails to run, reported and non-blocking on exit 1.

The shipped corpus in `rules/` is split by assumption: `rules/clean-code/` is generic TypeScript,
`rules/effect/` assumes an Effect codebase (`no-await` forbids a construct most projects use
freely). Selection is by which rule documents are present, so "what is enforced here" is a directory
listing. Rules come from three sources: `--preset all|clean-code|effect` for the shipped set,
`--rules <dir>` for your own, and `--rules pkg:@acme/falsestart-rules[/subdir]` for another
package, resolved from your project rather than a guessed node_modules path. The `pkg:` prefix is
required rather than inferred, so an existing `--rules rules` keeps meaning the directory. A rules
package is just a `rules/` directory of ast-grep documents. Where each rule applies is re-scopable per repo via `falsestart.config.{ts,mts,js,mjs,json}`
(or `--config <file>`). A TypeScript config is type-checked against the exported `FalsestartConfig`
and `ShippedRuleId`; import that type with `import type`, since a `.ts` config is type-stripped and imported
from a `data:` URL with no filesystem location — it cannot resolve a package or relative value
import, though `node:` builtins do resolve, which is enough to compute a scope by shelling out. `files` is required in an override; `ignores` is optional and, when
omitted, the rule keeps its own. Two competing default configs are an error rather than a
precedence rule, and an override for a rule that is not loaded is an error, not a silent no-op. An
override REPLACES `files` rather than merging into them, so an extension left out of the
restatement is silently unguarded; `--doctor` names the rule and the extensions dropped, and
`findNarrowedScopes` exposes the same comparison to a test suite.

Rules are ast-grep documents needing `id`, `language`, and `rule`, optionally `message`,
`severity`, `files`, `ignores`, `constraints`, `utils`. Always scope with `files`, and give every
rule worked examples of both kinds — the must-not-fire examples are the ones that catch a rule
turning into a nuisance.

`files` globs match the path relative to the project root the hook reports, so `src/**/*.ts` works
as written; a file outside that root keeps its absolute path. Notebooks scope by the notebook's own
path, so a `**/*.ts` rule does not see TypeScript in a `.ipynb` cell.

A matcher shared by several rules lives in a `_utils/` directory at the top level of the tree
`--rules` names — not inside a category — and is referenced by `matches:`. Those documents need only
`id` and `rule`, are not rules themselves, and lose a name collision to a rule's own `utils:` block.
Only the first path segment is recognised: a nested `_utils/` is loaded as a rule, fails validation
for the fields a fragment does not carry, and takes the whole tree down with a message naming the
missing `language` rather than the misplaced directory.
