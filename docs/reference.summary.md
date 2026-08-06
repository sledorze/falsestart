# Reference — summary

The lists: command line, rule document format, configuration, shipped rules, library exports.

**Judged tool calls, per contract.** Claude Code (the default), envelope `tool_name`/`tool_input`:
`Write` (`file_path`/`content`), `Edit` (`file_path`/`new_string`), `NotebookEdit`
(`notebook_path`/`new_source`) — the complete set of built-ins carrying file content. GitHub Copilot
CLI under `--agent copilot`, envelope `toolName`/`toolArgs` or `tool_name`/`tool_input` depending on
the casing of the event name in the hook config, with `toolArgs` possibly a JSON-encoded string:
`create` (`path`/`content`), `edit` (`path`/`new_str`) — **inferred names, not documented by
GitHub**. Anything else is allowed in silence under either contract. `Bash` is deliberately absent,
so a shell redirect writes a file falsestart never sees.

**Command line:** `--preset all|clean-code|effect`, `--rules <dir>`, `--rules pkg:<name>`,
`--config <file>`, `--doctor`, `--list-rules`, `--fail <policy>`, `--agent <name>`, `--warn-unscoped`, `--version`, `--help`. One invocation loads one
rule source: a preset and any `--rules` are refused together rather than ranked, and between the two
`--rules` forms the `pkg:` one wins whichever came first — so layering two rule sets means two hook
entries. `--doctor` reports what was
resolved, says how many loaded rules block and how many advise, probes five paths for reachability, and names any rule whose override covers fewer
extensions than it ships with — an override REPLACES `files` rather than merging, so a restated
glob that omits an extension silently unguards it. It also names the changelog shipped inside the
installation it reports on, so an upgrade's new rules are readable where the upgrade is verified.
It names the active `--fail` policy when one was given, names the active agent contract on EVERY
run, lists each judged tool with the field names it will read, and reports a rules package it could
not resolve rather than exiting with no report at all. Reads no stdin.

`--list-rules` prints the resolved rule set — after preset/`pkg:` resolution and after config
overrides — as JSON on stdout and exits, so a repo can assert that the rules blocking writes are the
rules its CI gate checks. Five fields per rule (`files`, `id`, `ignores`, `language`, `severity`),
one rule per line, sorted by id so two runs diff cleanly; the matcher and the prose are deliberately
absent, so a pattern refactor cannot break an assertion, and the config's top-level `exclude` is
absent too because it belongs to `scan` rather than to a rule — as are `--exclude` and the caller's
`.gitignore`, which narrow what a scan answers for the same way. `null` files means "no scope
declared", the opposite of `[]`. Exits 0 with the document or 2 if it could not be produced; a
refused hook command line still exits 1, because exit 2 from a hook blocks the write (a refused
`scan` still exits 2, as it always has). Reads no stdin, and
there is no `--json` flag.

`--fail closed|open` decides what a failure of falsestart ITSELF costs; `open` is the default and is
the 0.2.0 behaviour. `closed` denies on a rule tree or `pkg:` package that will not load, a config
that will not load, an override naming a rule that is not loaded, and a rule that cannot run at match
time. It is never the REASON to deny a malformed hook payload or a refused command line — neither is a
fact about the repository, and neither is fixable from inside it; a guard failure hit first still
denies whatever payload arrives, naming that failure and not the payload, as the freeze already
does — it applies to a judged write only, and it is
a policy about failures rather than a claim that any rule covers what you write. `--fail open` does
not re-open a freeze refusal, and with both switches in play the way out is two steps, each denial
printing the next: the freeze names `--freeze off`, and the working tree's copy of the same broken
document then denies for the guard and names `--fail open`. Every governed failure is answered AFTER
the payload is read, which is what keeps a non-judged tool call silent and is why
`falsestart --rules pkg:<missing>` run by hand now waits for a payload instead of exiting — a hook
runner closes stdin, and `--doctor` is the way to check a setup by hand. Command line only, for the reason `--freeze` is: one of the failures it
denies on is a config that will not load. Refused with `scan` and `--list-rules`, which already exit
2 when they cannot run. The denial says the guard failed before it says anything else, never names a
rule, and warns that repairing the broken rule document needs `--fail open` too — every judged write
denies while the guard is broken, including that one.

`--agent claude-code|copilot` names the runtime on the other end — DECLARED, never sniffed, because a
payload says nothing about how the runtime reads the ANSWER and guessing that wrong turns a deny into
an allow. Command line only, refused with `scan` and `--list-rules` in either value. A payload naming
a tool from the other contract's closed table is reported as a misdeclared flag, on the channel the
runtime that really sent it reads. `copilot` is PROVISIONAL: its tool argument names are inferred,
and whether stderr is readable at exit 0 is undocumented.

`--warn-unscoped` reports a
judged write no rule is scoped to rather than passing it in silence; non-blocking, off by default. Under claude-code, exit 0 carries either a decision (`hookSpecificOutput`, a block) or advice
(`systemMessage`, which decides nothing, and comes either from a softer-than-`error` rule or from
`--warn-unscoped` with no rule involved at all) — separate documents, not one with a different verdict —
exit 0 with no output defers, and exit 1 reports a
problem without blocking. Blocking is deliberately not exit 2 there, which discards stdout. Under
`copilot` there is **no exit 1 at all** — every non-zero exit other than 2 denies the tool call — so a
deny is exit 2 with top-level `permissionDecision` keys on stdout and the reason on stderr, advice
and reported problems are exit 0 with stderr only, and a refused command line exits 0 too.

**`scan [paths…]`:** judges files on disk for a git hook or CI. Paths from the caller, `-`/`-0` for
stdin, `--baseline`/`--update-baseline` to absorb pre-existing findings, `--warn-unscoped` refused.
Its own exit codes — 0 clean, 1 findings, 2 could-not-run — and it fails closed where the hook fails
open by default.

**Rule document:** `id`, `language` and `rule` required; `message`, `note`, `severity`, `files`,
`ignores`, `constraints`, `utils` optional. Severity defaults to `error`, and only `error` denies a
write. Documents under a `_utils/` directory at the TOP LEVEL of the loaded tree are fragments
needing only `id` and `rule`; only the first path segment is recognised, so a nested `_utils/` is
loaded as a rule and fails the whole tree.

Seventeen of twenty-three shipped rules match `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` — the constructs they catch
exist in both languages. Six (`no-as-any`, `no-as-never`, `no-double-cast`, `no-effect-assertion`, `no-type-assertion`,
`prefer-smart-constructor`) stay TypeScript-only: they do fire on TS syntax at a `.js` path, since
the parser follows `language: tsx` rather than the extension, but valid JavaScript cannot contain
an `as` expression or a typed `const` to find. A JSDoc cast is caught by nothing.

`no-effect-assertion` is the one rule with NO test-file exemption, deliberately: the blanket every
other assertion rule carries exists for a fixture cast a mock needs (`as never`), which this rule
leaves alone, but it was also waving through `x as Effect.Effect<A>` — a claim that a stream which
can fail cannot. Found by falsestart allowing three of them into this repo's own tests while wired
and running.

**Configuration:** per-rule `files` (required) and `ignores` (optional, omission keeps the rule's
own), plus a top-level `exclude` glob list for `scan` — the repository's standing policy, which
`--exclude` adds to rather than replaces. A malformed `exclude` is an error, not ignored. An override for a rule that is not loaded is an error. A `.ts` config must import its config
type as a type-only import: imported from a `data:` URL, it cannot resolve a package or relative value import,
though `node:` builtins do resolve — which is enough to compute a scope at load time.

**Shipped rules:** twenty-three, all `error` severity; `clean-code` assumes no framework and now reaches JavaScript too, `effect`
assumes Effect, and `no-vi-mocking`, `no-test-lifecycle-hooks` and `no-manual-effect-run-in-tests` apply only to test files. `Schema.Class` constructors throw but are deliberately not ruled — that would contradict `prefer-smart-constructor`.

**Freezing the rule set:** `--freeze auto|off|require` (default `auto`) and `--freeze-ref <ref>`
(default `HEAD`), on the command line only — never from `falsestart.config.*` or the environment,
because the thing being frozen must not carry its own off switch. Rules and config are classified
INDEPENDENTLY into `Frozen` (the ref's bytes run), `Unfrozen` (nothing to freeze: no repository, no
commit, an out-of-repository or untracked tree including `--preset` and `pkg:`, a submodule, a
committed symlink — read the working tree and say so) and `Broken` (git said it was readable and then
was not — refuse, and never fall back). `Broken` denies at the hook, exits 2 for `scan` and
`--list-rules`, and fails `--doctor`. `require` extends `Broken` to every `Unfrozen` row. Four fixed
`git` invocations, about 4% of a judged write at 23 and at 168 rules; a call falsestart does not judge
spawns git not at all. Where no enclosing `.git` DIRECTORY exists — a linked worktree outside its main
repository, `--separate-git-dir` — `--doctor` prints `anchor UNVERIFIED` and `require` refuses.

**Library:** the exported functions, error classes and constants, with the area each belongs to,
plus the exported types. `AGENTS` and `AGENT_CONTRACTS` are exported so the contracts can be
asserted against rather than copied. `effect` is a required peer; `@effect/platform-node` is optional.
