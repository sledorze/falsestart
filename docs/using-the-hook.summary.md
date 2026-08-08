# Using the hook — summary

falsestart runs as an agent's `PreToolUse` hook. For Claude Code, register it in
`.claude/settings.json` with a
`Edit|Write|NotebookEdit` matcher and the CLI invoked by PATH (`node .../dist/cli.js`), because
`node_modules/.bin` is not on a hook's `PATH` and a bare name exits 127 while looking registered.
Settings must be strict JSON. `PreToolUse` is the only event it implements: registered at
`PostToolUse` it refuses on stderr naming the event it was invoked for and judges nothing, where it
used to answer with a document naming the wrong event that the runtime ignored. `PostToolUse` will
not be implemented — nothing can block after the tool has run — so `falsestart scan` is the
`PostToolUse` command for after-the-write reporting. Guarding shell commands is a second `PreToolUse` entry beside this one
— the intended arrangement, not a workaround, since a `matcher` makes the two select disjoint sets
of tool calls, and on a call falsestart does not judge it writes nothing to either stream and exits
0 before its rule tree is read. `--doctor` answers "is this guarding anything?" — it prints the
version that answered, the resolved rules with how many of them declare a blocking severity and how
many advise (a severity tally, not a reachability claim — the scope block answers that), config
and per-path rule counts, then sends a real
violation through the decision path. There is one `rules` row per SOURCE, so a combined
`--preset … --rules …` prints two: a single total cannot answer "did my own rules load, or only the
preset?". Read its scope block, not just its last line: a nested probe
path is what exposes the `src/**.ts` glob typo that guards top-level files and nothing else. Read
its version line too — a hook wired at a path holding an older copy describes that copy, plausibly.
Under it, a `changes` line names the changelog inside that same copy, because a version number alone
cannot say that a MINOR bump added an `error`-severity rule and turned a green repo red (`0.2.0` did
it twice); the line is absent on versions published before it existed, which shipped no changelog at
all. For GitHub Copilot CLI, register it in `.github/hooks/*.json` (or `~/.copilot/hooks/`) under
`{"version":1,"hooks":{"preToolUse":[…]}}` and add `--agent copilot`, without which falsestart
answers in the wrong vocabulary and Copilot denies EVERY tool call in the session. The casing of the
event name decides the payload spelling — `preToolUse` sends `toolName`/`toolArgs`, `PreToolUse`
sends `tool_name`/`tool_input` — and falsestart reads both, so either registration works. There a
deny is exit 2, everything that exits 1 under Claude Code exits 0, `--fail closed` is the recommended
policy, and an advisory finding reaches the user and the log but never the model. Copilot support is
provisional: the tool argument names are inferred, and `--doctor` prints them so a reader can check
them against one real payload.

Serving both runtimes means two registrations in two schemas, and falsestart reads neither — it is
invoked BY the wiring and never inspects it, so `--doctor` cannot answer "is it registered
everywhere I said I use an agent, and does each registration load the same rules". That half is a
recipe rather than a flag: a ~100-line script the repository owns, built out of the exported
`AGENTS` and `WRITE_TOOLS` plus `--list-rules`, given verbatim with the output of every case. It
reports a declared runtime whose config holds someone else's guard and not falsestart; a registration
naming the wrong runtime (the finding that matters most — worse than a missing one, since the whole
Copilot session then denies); a Claude Code matcher that never reaches a write tool; two
registrations resolving DIFFERENT rule sets, the drift a presence check reports green on; and an
unparseable config, which throws rather than degrading to "no hooks". **Absence is not a finding —
declaration is**: no `.github/hooks/` says nothing about Copilot, and reporting there infers intent.
`RULE_FLAGS` is an allow-list because `--list-rules` refuses `--agent` and `--fail`, for two
different reasons, so a registration's command line cannot be replayed verbatim; `--list-rules` also
inherits `--freeze auto`, so it compares the rule sets actually in effect rather than the working
tree. The trap: `--list-rules` exits 2 with empty stdout when the config names a rule the preset does
not load — falsestart's own repository is in that state, re-scoping two `effect` rules — and the
check dies naming it rather than passing. Five wrong answers are stated, two silent and three false
POSITIVE: an unanchored `"Edit|Write"` reads as reaching `NotebookEdit` (what Claude Code applies is
unverified, so the check is deliberately silent where the answer depends on it, which is also one
reason it is not a shipped flag); a command path that does not resolve, that being `--doctor`'s
question; a registration only in `.claude/settings.local.json` or in `~/.copilot/hooks/`, neither of
which is read, the latter deliberately since no commit could fix a finding about it; and two entries
in ONE file layering two rule sets, which this page itself recommends and which the check cannot tell
from drift. Run both.

`--rules` is searched recursively and defaults
to `.falsestart/rules`. The matcher is an optimisation, not a safety boundary — tool calls
falsestart has no opinion about are ignored without even loading the rule tree.

`--list-rules` prints the resolved rule set as JSON — the assertable counterpart to `--doctor`'s
prose — so a repo can pin that the hook and the CI gate load the same rules; one rule per line
sorted by id, exit 0 with the document and 2 when it could not be produced, and nothing that narrows a scan
without touching a rule is in it — the config's `exclude`, `--exclude`, or the caller's `.gitignore`.

Rules and config are read from `HEAD` by default rather than from the working tree, so a session that
can write files cannot disarm its own guard. The cost is one surprise — you edit a rule and nothing
changes — and falsestart says so at the moment it happens: a judged write of a rule document inside
the rules directory answers with a `systemMessage`. Widening a rule and expecting a block elsewhere
stays silent, because a signal that fires on most writes gets trained away; `--doctor` lists every
working-tree change that is not in effect, and `--freeze off` reads the working tree for a run. It is
also the other half of pinning the rule set: both gates resolve from the same committed ref.

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
fails CLOSED where the hook fails open by default, because a gate that cannot run must stop rather
than pass everything. It judges whole files where the hook judges introduced text, so it is strictly stricter:
64% of real TypeScript files already carry a finding, which is what `--baseline`/`--update-baseline`
absorb — one entry per occurrence, so accepting two identical lines does not accept a third, and a
baseline that exists but cannot be read exits 2 rather than silently accepting nothing. Every run prints `scanned N, M in scope, K finding(s)`; `M = 0` is the signal that a run
enforced nothing, which otherwise looks identical to success.

Behaviour: an `error`-severity match blocks with the rule's message; softer severities do not
block; a path outside a rule's `files`/`ignores` never runs it; other tools are ignored. A rule
tree that will not load, or a rule that cannot run, produces a visible error while letting the
write proceed — loud, but not able to hold a repository hostage. A repository that would rather have
the opposite adds `--fail closed` to the hook command: the same failures then deny, while a malformed
hook payload, a refused command line and any tool call falsestart does not judge stay exactly as they
were, and a freeze refusal denies either way. The trap to know first is that a load-time failure is
answered before anything is judged, so while `--fail closed` is on and the rule tree is broken every
judged write denies, including the edit that would repair it — the denial says so and names
`--fail open`. Where the broken tree is COMMITTED, the way out is two steps and each denial names the
next: the freeze prints `--freeze off`, and the working tree's copy of the same document then denies
for the guard and prints `--fail open`. Running `falsestart --rules pkg:<missing>` by hand now waits
for a payload rather than exiting, since the answer comes after the payload is read; `--doctor` is
the way to check a setup by hand. `--doctor --fail closed` prints a `policy` line proving it is on, before anything is
resolved.

A rule declaring `warning`, `info` or `hint` is shown to the author as
`{"systemMessage":"falsestart:\n<rule-id> (<line>:<column>): <message>"}` and decides nothing — a
different JSON document from a denial's `hookSpecificOutput`, not the same one with another verdict,
and the same envelope `--warn-unscoped` uses. Severity is a field of the rule document, so one rule
has one severity everywhere it is loaded: a rule that must block in a curated tree and advise in a
wider one exists twice, as two ids or as one document reached by two hook entries, kept in step by
hand.

Laying out a large tree: subdirectories are organisational only, ids are unique across the whole
tree (a duplicate refuses the load, across sources as well as within one), and every matching rule
is reported together. `--rules` combines with `--preset` in one invocation, which is the way to give
a preset and your own tree a SHARED config; layering more than that still means two hook entries —
which gives each its own config and severity policy. The cost of splitting:
a root `_utils/` is out of scope for an entry pointing at one subdirectory, and a rule referencing a
matcher it cannot see fails to run, reported and non-blocking on exit 1.

The shipped corpus in `rules/` is split by assumption: `rules/clean-code/` is generic TypeScript,
`rules/effect/` assumes an Effect codebase (`no-await` forbids a construct most projects use
freely). Selection is by which rule documents are present, so "what is enforced here" is a directory
listing. Rules come from three sources: `--preset all|clean-code|effect` for the shipped set,
`--rules <dir>` for your own, and `--rules pkg:@acme/falsestart-rules[/subdir]` for another
package, resolved from your project rather than a guessed node_modules path. A preset and a
`--rules` source load together, in that order. The `pkg:` prefix is
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
