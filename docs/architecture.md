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

That shape is also the cost model, and it has three parts. There is a **fixed floor** per
invocation, paid whether or not any rule runs: process start, plus loading falsestart's own bundle
and the `@ast-grep/napi` native binding. **Above the floor**, judging a write costs the rule tree,
read from disk every time because the process is new every time. **A call that is not judged** pays
the floor and nothing else — no rule tree read, no syntax tree built — and that is most of the
traffic.

Measure your own floor rather than trusting the numbers below: `--version` reads no stdin and loads
no rules, so timing it gives the part of every invocation that happens before falsestart does
anything.

Measured on aarch64 (Linux container, 15 CPUs), Node 22.16.0, falsestart 0.2.0, on 2026-08-05; cold
process, 10 runs averaged:

| Invocation                                          | Per tool call |
| --------------------------------------------------- | ------------- |
| `--version` — no stdin, no rules: the floor         | 66 ms         |
| A tool call falsestart does not judge               | 66 ms         |
| A judged write, 23 rules (`--preset all`)           | 88 ms         |
| A judged write, 168 rules in 8 category directories | 113 ms        |

Reproduce it with the loop that produced it, from a directory with no `falsestart.config.ts`:

```bash
payload='{"tool_name":"Write","cwd":"'"$PWD"'","tool_input":{"file_path":"'"$PWD"'/src/a.ts","content":"const x = 1"}}'
total=0
for i in $(seq 10); do
  start=$(date +%s%N)
  echo "$payload" | node node_modules/@sledorze/falsestart/dist/cli.js --rules ./rules >/dev/null 2>&1
  total=$(( total + ($(date +%s%N) - start) / 1000000 ))
done
echo "$(( total / 10 )) ms"
```

Rule count is the smaller term: 145 extra rules cost about 25 ms here, against a floor near 65 ms
that no rule set can avoid. The numbers are stamped because they are a fact about that machine on
that day — repeated passes on this one moved them by 10% on their own — and the three-part shape
above is what holds on yours. Each part of it is anchored to a line of code rather than to a
stopwatch.

Nothing is cached between invocations, and nothing here promises that will change. `src/judge.bench.ts`
measures the in-process half and says the same thing where it re-reads the tree: if loading ever
dominates, that is the argument for a cache — and the measurement that would justify its complexity.

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

## What a rule cannot see

A rule is an ast-grep document evaluated against the syntax tree of **one file's text**. The check
receives that text and the path the text is destined for, and nothing else — nothing in the checking
layer opens a file. "It judges text, not files" above says that about write time, because the
content is not on disk yet. This is the stronger claim: that text and that path are the whole input.

There is no repo-wide corpus, no index of files seen before, and no rule type that runs
caller-supplied code at match time. A rule document's fields are exactly `id`, `language`, `rule`,
`message`, `note`, `severity`, `files`, `ignores`, `constraints` and `utils` — a matcher and its
scope, with nowhere for a question about anywhere else to go.

So a rule of the form "flag this identifier unless it is declared as a Value Object somewhere else
in this repository" is not expressible, and is not planned. It is written down rather than left to
be inferred because an absence cannot be read: a field table with no `corpus` entry says the same
thing whether the feature is unbuilt or unwanted, and the two lead to different decisions about
adopting this at all.

The distinction that makes it precise is between a rule's **scope** and a rule's **match**. A config
file is executed — a `.ts` config is type-stripped and imported, a `.mjs` config is imported from its
real path — so a scope can be computed at load time: shell out, build a list of paths, emit globs. A
match cannot. The only thing a config may change about a rule is its `files` and `ignores`; nothing
in a config reaches the matcher.

The two config formats do not reach equally far, and the difference bites exactly here. A `.ts`
config is imported from a `data:` URL, which has no filesystem location to resolve a specifier
against: `import { execSync } from 'node:child_process'` works, because a builtin needs no location,
while `import picomatch from 'picomatch'` and a relative `./helper.ts` both fail to resolve. Shelling
out to compute globs is therefore available in the typed format; a glob library or a shared helper
needs `.mjs`.

Where a corpus-shaped question does have an answer today it is `falsestart scan`, which judges whole
files already on disk — so anything expressible as "this file, in full" is reachable from a gate even
where it is not reachable from the hook. The boundary is worth naming rather than implying: `scan`
still judges one file at a time. It is a wider view of each file, not a view of the repository.

## How the code is divided

Six areas, each presenting a small entry point that the rest of the codebase and these documents
cite. Areas are separated by _what they are allowed to know_:

| Area                                    | Knows about                                                               |
| --------------------------------------- | ------------------------------------------------------------------------- |
| [`checking/`](../src/checking/index.ts) | Rule documents and source text. Not processes, protocols or config files. |
| [`config/`](../src/config/index.ts)     | A repository's own scope overrides, and reading them off disk.            |
| [`hook/`](../src/hook/index.ts)         | The agent protocol: a payload in, a verdict out.                          |
| [`scanning/`](../src/scanning/index.ts) | The filesystem: paths in, a report out.                                   |
| [`cli/`](../src/cli/index.ts)           | What the command line asked for.                                          |
| [`testing/`](../src/testing/index.ts)   | Helpers a consumer uses to test their own rules.                          |

`hook/` and `scanning/` are the two adapters, and they are separate because their failure modes
are opposite. The hook answers before a write lands and must fail OPEN — a typo in a rule file must
not hold every write in the repo hostage. A scan is a gate, and must fail CLOSED — one that cannot
run has to stop, or it passes everything while looking healthy. Same rules underneath, contrary
policies above, which is exactly the kind of thing that goes wrong when one module tries to be both.

Only [`cli.ts`](../src/cli.ts) knows a process exists.

Documents cite entry points and never an area's internals, so a document goes stale when what an
area _offers_ changes — which is when it should be re-read — rather than every time an
implementation detail moves. A file named `*.generated.ts` is written by a tool and never edited by
hand.

That convention is enforced rather than merely stated: each link's target content is hashed, and the
docs check fails when it drifts.
