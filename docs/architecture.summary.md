# Architecture — summary

falsestart is a one-directional pipeline: a YAML rule document is parsed, scoped to a path,
matched against source text, judged into a decision, and rendered as process output. Each stage is
its own module and none knows about the next.

Stages: `core/rule.ts` (is this rule runnable?), `core/loader.ts` (what rules are in this
directory?), `core/scope.ts` (may this rule touch this path?), `core/matcher.ts` (where does it
match?), `core/engine.ts` (what does this rule set find?), `hook/decide.ts` (block, ignore, or
complain?), `hook/respond.ts` (what to emit), `cli.ts` (the only module naming a runtime or
process). Beside the pipeline sit `core/config.ts` (per-repo scope overrides), `hook/options.ts` (what did
the command line ask for?),
`testing/assess.ts` (does this rule do what its author thinks?) and `index.ts` (the consumer-facing
surface).

Load-bearing decisions:

- **Scope precedes content.** A rule is filtered by path before its matcher runs, so content
  matching alone can never cause a rule to act on a file.
- **Content is a string, not a file.** The guard judges text about to be written; `loader.ts` is
  the only module touching the filesystem, and only to read rule documents. An `Edit` is judged by
  what it adds.
- **`constraints`/`utils` go to ast-grep verbatim**, because a reimplementation's gaps become
  silently under-matching rules — notably negated constraints and Rust-dialect `(?i)` regexes.
- **A rule that cannot run is not "found nothing".** The engine propagates the failure; `decide.ts`
  turns it into a visible-but-non-blocking report.
- **Only `error` severity blocks.**
- **Loading is all-or-nothing**, reports every problem at once, refuses duplicate ids, and sorts by
  path because the directory walk's order is not dependable.
