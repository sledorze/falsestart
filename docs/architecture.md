# Why falsestart is built this way

Explanation, not a map. For the list of exports, flags and rules see [Reference](./reference.md);
to set it up see [Using the hook](./using-the-hook.md).

## The problem shapes everything

An agent writes a file. Between deciding to write and the bytes landing there is one moment where a
rule can still be applied cheaply — and after it the cost of undoing rises steeply: a test run, a
review, a revert. falsestart lives in that moment.

Three consequences follow, and most of the design is downstream of them.

**It judges text, not files.** The content does not exist on disk yet. Anything that worked by
reading the file back could not block anything before the fact. So a check takes a string plus the
path that string is destined for, and nothing in the checking layer opens a file.

That has a limit worth stating: an edit is judged by the text it _introduces_, not by the file that
results. It is checked for what it adds, never for what it leaves behind elsewhere.

**It runs on every tool call.** Not every write — every call, including the reads and searches that
are most of an agent's traffic. So the first question asked is the cheapest one: does this tool
write source at all? A call that does not is answered without loading a single rule.

**Being wrong is asymmetric.** Blocking good code teaches people to work around the guard, and a
guard people route around protects nothing. Failing to block bad code costs one violation. The
design leans accordingly: narrow rules, and errors that surface without stopping work.

## Scope before content, always

A rule acts on a file only when that file's _path_ admits it. Matching content is never on its own a
reason to touch a file.

This is the invariant worth defending in isolation, because breaking it is silent in both
directions. Too broad and a rule fires where nobody intended; too narrow and it quietly protects
nothing. Neither announces itself, so path scoping is its own concern with its own negative tests —
evidence that a rule provably does _not_ reach an adjacent, similar-looking file.

## Borrowed semantics, not copied ones

Rules are [ast-grep](https://ast-grep.github.io) documents, and a matcher's `constraints` and
`utils` are handed to ast-grep untouched rather than re-implemented.

Re-implementing them means re-deriving a matcher's whole semantics — negated constraints used as
exemptions, regexes in the Rust dialect whose inline `(?i)` flag JavaScript's own `RegExp` cannot
parse. Every gap between copy and original becomes a rule that silently under-matches, which is the
failure this tool exists to prevent.

One exception is deliberate: the native binding accepts matcher shapes the real `ast-grep` CLI
rejects, and then matches essentially every node. A rule upstream considers broken would fire
indiscriminately here. So a narrow check rejects those shapes — modelled on behaviour measured
against the actual CLI rather than reasoned about.

## Three failures that must not be confused

| Situation                           | Answer                         |
| ----------------------------------- | ------------------------------ |
| The code breaks a rule              | Block, with the rule's message |
| A rule matched at a softer severity | Show it; do not block          |
| The guard could not do its job      | Say so loudly; do not block    |

The third is the interesting one. A rule that cannot _run_ is never reported as "found nothing" —
conflating those would let a broken rule read as a clean file. But it does not follow that a typo in
a rule file should hold every write in the repository hostage. The failure stays loud without
becoming an outage.

## Rules are programs, and programs are wrong

A rule is a small program in a pattern language, so it is wrong until shown otherwise. Three
independent checks say so, each verified by breaking it rather than by reading it:

- **Worked examples.** Every rule carries code it must catch _and_ code it must leave alone. The
  second kind matters more: a rule with only positive examples looks correct right until it fires on
  something innocent.
- **Blast radius.** A body of ordinary, idiomatic, rule-abiding code that no rule may flag. Examples
  prove a rule catches what its author aimed at; they cannot prove it is not also catching half the
  language. A rule matching any method call passes an examples-only gate and then blocks nearly
  every write.
- **Remedies exist.** Every API named in a rule's message must be real. A rule that blocks your code
  and then recommends something that does not compile is worse than one that says nothing.

## How the code is divided

Five areas, each presenting a small entry point that the rest of the codebase and these documents
cite. Areas are separated by _what they are allowed to know_:

| Area                                    | Knows about                                                               |
| --------------------------------------- | ------------------------------------------------------------------------- |
| [`checking/`](../src/checking/index.ts) | Rule documents and source text. Not processes, protocols or config files. |
| [`config/`](../src/config/index.ts)     | A repository's own scope overrides, and reading them off disk.            |
| [`hook/`](../src/hook/index.ts)         | The agent protocol: a payload in, a verdict out.                          |
| [`cli/`](../src/cli/index.ts)           | What the command line asked for.                                          |
| [`testing/`](../src/testing/index.ts)   | Helpers a consumer uses to test their own rules.                          |

Only [`cli.ts`](../src/cli.ts) knows a process exists.

Documents cite entry points and never an area's internals, so a document goes stale when what an
area _offers_ changes — which is when it should be re-read — rather than every time an
implementation detail moves. A file named `*.generated.ts` is written by a tool and never edited by
hand.

That convention is enforced rather than merely stated: each link's target content is hashed, and the
docs check fails when it drifts.
