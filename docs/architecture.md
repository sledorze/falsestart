# Architecture

falsestart is a pipeline with one direction of flow. Each stage is a module, each is usable on
its own, and no stage knows about the one after it.

```
rule document ──parse──▶ Rule ──scope──▶ applicable? ──match──▶ Violation ──judge──▶ Decision ──▶ exit code
   (YAML)          │                          │                     │                  │              │
                   │                          │                     │                  │              │
              core/rule.ts              core/scope.ts        core/matcher.ts      hook/decide.ts   cli.ts
                                                                    │                  │
                                                             core/engine.ts      hook/respond.ts
```

## The stages

| Module                                      | Answers                                     |
| ------------------------------------------- | ------------------------------------------- |
| [`core/rule.ts`](../src/core/rule.ts)       | Is this a rule we can actually run?         |
| [`core/loader.ts`](../src/core/loader.ts)   | What rules does this directory hold?        |
| [`core/scope.ts`](../src/core/scope.ts)     | May this rule act on this path?             |
| [`core/matcher.ts`](../src/core/matcher.ts) | Where does this rule match this text?       |
| [`core/engine.ts`](../src/core/engine.ts)   | What does this rule set find in this file?  |
| [`hook/decide.ts`](../src/hook/decide.ts)   | Block, ignore, or complain?                 |
| [`hook/respond.ts`](../src/hook/respond.ts) | What should the process emit?               |
| [`cli.ts`](../src/cli.ts)                   | Wiring to stdin, stdout, and the exit code. |

Four modules sit beside the pipeline rather than in it:

| Module                                          | Answers                                       |
| ----------------------------------------------- | --------------------------------------------- |
| [`core/config.ts`](../src/core/config.ts)       | Where does THIS repo want each rule to apply? |
| [`hook/options.ts`](../src/hook/options.ts)     | What did the command line ask for?            |
| [`testing/assess.ts`](../src/testing/assess.ts) | Does this rule do what its author thinks?     |
| [`index.ts`](../src/index.ts)                   | What may a consumer import?                   |

`cli.ts` is the only module that names a runtime or a process.

## Decisions worth knowing

**Scope is checked before content, always.** `engine.ts` filters by path and only then runs the
matcher. A rule cannot act on a file merely because the content looked right — the file's path
has to admit it first. This is the structural guarantee `AGENTS.md` asks of any write path, and
it is why `scope.ts` is its own module with its own negative tests.

**Content is a string, never a file.** The guard judges text that is about to be written and does
not exist on disk yet. `loader.ts` is the only module that touches the filesystem, and it reads
rule documents — never the file being judged. (`respond.ts` names `FileSystem` in its signature,
but only to thread the loader's requirement through; it performs no I/O of its own.) An `Edit` is
therefore checked for what it ADDS, since the resulting file is not something the hook ever sees.

**`constraints` and `utils` are ast-grep's, not ours.** They are handed to the upstream matcher
verbatim rather than reimplemented. A reimplementation has to re-derive the whole semantics —
negated constraints, and regexes in the Rust `regex` dialect whose inline `(?i)` flag JavaScript's
own `RegExp` cannot parse — and every gap between copy and original becomes a rule that silently
under-matches.

**Failing to run a rule is not the same as finding nothing.** `engine.ts` propagates the failure
rather than returning an empty result, so a broken rule can never read as a clean file. What to
do about it is policy, and it lives one layer up: `decide.ts` reports rather than blocks, because
a typo in a rule file should be loud without holding a repository hostage.

**Only `error` severity blocks.** Anything softer is advice, and advice that blocks is
indistinguishable from an error.

## Loading is all-or-nothing

A tree with one unreadable rule fails to load rather than silently yielding the rules that
happened to parse. A guard running with a smaller rule set than its author believes is invisible
from the outside. Every problem in the tree is reported together, and duplicate rule ids are
refused outright rather than resolved by load order.

Results are sorted by path. The directory walk's own order is not dependable — measured against a
real tree it returned sibling directories in reverse.
