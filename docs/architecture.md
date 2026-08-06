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
path that string is destined for, and never opens the file it is judging.

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

Measure your own floor: `--version` reads no stdin and loads no rules, so timing it gives the part of
every invocation that happens before falsestart has done anything. That number is worth more than
one of ours.

**There is deliberately no table of millisecond figures here.** One was written, and it did not
survive re-measurement: on a machine matching its own stamp, by two people, running the recipe it
published, the rule-tree rows came back 20% off. An absolute that cannot be reproduced where it was
taken will not reproduce on your hardware, your Node, a loaded CI box or a laptop on battery — which
is the same reason this repo asserts no latency in CI. What follows was measured on one machine, and
is stated as ratios because the ratios are what held across every re-run and both measurers:

- A call falsestart does not judge is indistinguishable from `--version`. The floor is the whole cost.
- With the 23 shipped rules, a judged write costs about **a third more than the floor** — so for a
  small rule set the floor, not the rules, is most of what you pay.
- **168 rules across 8 category directories — 7× the rule count — did not cost 7× as much**: roughly
  two to two and a half times the floor, and under twice a `--preset all` call.
- The same 168 documents written as one-line patterns with short messages cost **15–20% less** than
  168 derived from the shipped corpus. A rule's shape is work, not only its count, so a rule count
  on its own predicts little.
- Reading the rule set from a git ref adds about **4% of a judged write**, at 23 rules and at 168.
  Four `git` invocations, fixed, dominated by process starts rather than by documents: 7× the
  documents cost about 1.5× the added time. Asking `git show` per document instead measured at
  roughly 22× that added cost at 168 and grows linearly, which is nearly a whole judged write again —
  the measurement that chose the shape. A call falsestart does not judge spawns git not at all.

Reproduce all of it yourself, including the tree — that is the input a stranger cannot guess — from a
directory with no `falsestart.config.ts`:

```bash
# The tree: the 23 shipped rules copied round-robin into 8 category directories,
# 21 apiece, each id rewritten so the whole tree still loads.
i=0
for category in clean effect naming structure security style tests types; do
  mkdir -p "rules/$category"
  for n in $(seq 0 20); do
    source=$(ls node_modules/@sledorze/falsestart/rules/*/*.yml | sed -n "$(( i % 23 + 1 ))p")
    sed "s/^id: /id: $category-$n-/" "$source" > "rules/$category/r$n.yml"
    i=$(( i + 1 ))
  done
done

# Confirm it LOADED before timing it. A tree that fails to load is the fastest
# one you will ever measure, and it fails in well under the floor.
node node_modules/@sledorze/falsestart/dist/cli.js --doctor --rules ./rules | grep '^rules'

payload='{"tool_name":"Write","cwd":"'"$PWD"'","tool_input":{"file_path":"'"$PWD"'/src/a.ts","content":"const x = 1"}}'
total=0
for i in $(seq 10); do
  start=$(date +%s%N)
  echo "$payload" | node node_modules/@sledorze/falsestart/dist/cli.js --rules ./rules >/dev/null 2>&1
  total=$(( total + ($(date +%s%N) - start) / 1000000 ))
done
echo "$(( total / 10 )) ms"
```

The three-part shape above is what holds on your machine, and each part of it is anchored to a line
of code rather than to a stopwatch. That is the durable half; the stopwatch half is yours to take.

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

## Six failures that must not be confused

| Situation                                        | Answer                                                                   | Under `--agent copilot`      |
| ------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------- |
| The code breaks a rule                           | Block, with the rule's message                                           | Same, expressed as exit `2`  |
| A rule matched at a softer severity              | Show it; do not block                                                    | Same, on stderr              |
| The guard could not do its job                   | Say so loudly; do not block by default                                   | Same, at exit `0` not `1`    |
| The rule source could not be read _as committed_ | Refuse to judge; do not fall back                                        | Same, expressed as exit `2`  |
| The hook payload is malformed                    | Say so loudly; never the REASON to block                                 | Same, and exit 0 cannot deny |
| The payload names a tool from another contract   | Say so loudly, on the other runtime's channel; never the REASON to block |                              |

The third is the interesting one. A rule that cannot _run_ is never reported as "found nothing" —
conflating those would let a broken rule read as a clean file. But it does not follow that a typo in
a rule file should hold every write in the repository hostage. The failure stays loud without
becoming an outage.

The fourth looks like a contradiction of the third and is an amendment to it, in the safe direction.
Under a freeze a WORKING-TREE typo never reaches the loader at all, so the case the third row
protects is strictly better off than before: corrupting a rule document used to be a one-command
disarm, and is now a no-op. What refuses is a COMMITTED rule set that does not load, or a repository
git said was readable and then would not read — a repository-wide problem a commit introduced, and
exactly what `scan` in CI already fails closed on. Falling back to the working tree there would make
breaking git the cheapest disarm available, which is the whole reason the freeze exists.

The third is a POLICY, and `--fail closed` inverts it. The argument above is about the default, and
it is narrower than it was when it was written: under a freeze the working-tree typo it protects
never reaches the loader, so what is left is mostly the repository with nothing to freeze — where the
typo really is somebody's work in progress. A repository where an edit that cannot be verified must
not land says so on the command line, and the same failure denies instead.

The fifth is the row that policy does NOT reach, and it earns its place precisely because the flag
would otherwise read as "everything denies". A malformed payload is not a fact about the repository:
the runtime on the other end of the pipe sent an unexpected shape, there is nothing in the project to
fix, and an agent told "denied" would rewrite code that was never judged. It would also make
availability depend on another product's release cadence, since the fields falsestart reads are that
product's.

"Never the reason" is the whole claim, and it is narrower than "never denied". The failures are
answered in order and a malformed payload is discovered last, so a broken rule tree denies whatever
payload arrives — naming the tree, which the repository owns and can fix, and never the payload. The
freeze has done this since it shipped. Answering the malformed payload earlier would buy the stronger
sentence at the cost of the freeze: a committed rule set that will not load would go back to exit 1
on that payload, which is the fail-open disarm the freeze exists to close.

The sixth exists because the flag can be wrong, and one direction of wrong is silent. `Write`,
`Edit` and `NotebookEdit` cannot come from Copilot, whose tool table is documented and closed, and
`create`/`edit` cannot come from Claude Code — so a tool name in the OTHER contract's table is proof
the flag names the wrong runtime rather than a tool falsestart has no opinion about. It is answered
with the emitter of the runtime that really sent it, because a message about a misdeclared `--agent`
is worth nothing on a channel the runtime that is actually there does not read. Structural, like
every other discriminator here: membership in a declared table, never a guess about what a name
looks like.

The third row's default reads as exit `0` under Copilot rather than exit `1`, and that is forced
rather than chosen: every non-zero exit other than 2 denies the tool call there, so `1` would invert
`--fail open` into fail-closed with a reason nobody can act on. For the same reason the fifth row is
STRONGER under Copilot than under Claude Code — exit 0 cannot deny even in principle.

None of this adds a fifth `Decision` tag. What a guard failure COSTS is a fact about the invocation
rather than about the code, so it is a rendering policy in `hook/respond.ts` — where the protocol's
price list already lives — and `decide` stays policy-free. A fifth outcome would have moved the
policy into the judgement, and `--doctor` would then have had to un-pick it again to keep calling a
failed sample unhealthy.

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
receives that text and the path the text is destined for, and nothing else: no code on the matching
path opens a file, so there is no second file for a rule to consult. (The layer does read the
filesystem — `loadRules` walks the rule tree — but that happens before any judging and reads only
rule documents.) "It judges text, not files" above says this about write time, because the content
is not on disk yet. This is the stronger claim: that text and that path are the whole input.

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

Seven areas, each presenting a small entry point that the rest of the codebase and these documents
cite. Areas are separated by _what they are allowed to know_:

| Area                                    | Knows about                                                                         |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| [`checking/`](../src/checking/index.ts) | Rule documents and source text. Not processes, protocols or config files.           |
| [`config/`](../src/config/index.ts)     | A repository's own scope overrides, and reading them off disk.                      |
| [`hook/`](../src/hook/index.ts)         | The agent protocolS: a payload in, a verdict out, in each runtime's own vocabulary. |
| [`scanning/`](../src/scanning/index.ts) | The filesystem: paths in, a report out.                                             |
| [`freezing/`](../src/freezing/index.ts) | What a git ref committed. Not processes: it parses git's plumbing output.           |
| [`cli/`](../src/cli/index.ts)           | What the command line asked for.                                                    |
| [`testing/`](../src/testing/index.ts)   | Helpers a consumer uses to test their own rules.                                    |

`hook/` and `scanning/` are the two adapters, and they are separate because their failure modes
are opposite. The hook answers before a write lands and fails OPEN by default, and says so as a
policy the caller can invert — a typo in a rule file must not hold every write in the repo hostage
unless the repository asks for that. A scan is a gate, and must fail CLOSED — one that cannot run has
to stop, or it passes everything while looking healthy. Same rules underneath, contrary
policies above, which is exactly the kind of thing that goes wrong when one module tries to be both.

Only [`cli.ts`](../src/cli.ts) knows a process exists. `freezing/` is the sharpest case of that
split: it decides everything about what a git ref committed and spawns nothing, because `cli.ts` is
excluded from the coverage ratchet and from mutation testing — a decision that lives there is a
decision nothing observes.

### Which repository the freeze trusts

Resolved by walking **outward from the project** to the nearest directory whose `.git` is a real
directory, and never by letting git discover a repository for itself. Both halves are structural
invariants rather than defensive coding.

git honours a `.git` that is an ordinary one-line file containing `gitdir: <path>`, and a write tool
produces one without a shell. Running git with a cwd inside the rules directory therefore hands the
choice of repository to whoever can write there. Planting the same file one level up a monorepo moves
that directory's toplevel onto itself, so a containment check passes cleanly while the object
database has been replaced. The walk steps over such a file onto a root whose `.git` is a directory,
which `writeFileSync` cannot replace — `EISDIR`.

What the walk cannot do is verify a repository that has no enclosing `.git` directory anywhere: a
linked worktree outside its main repository, or `--separate-git-dir`. Those are reported rather than
refused under the default, because they are supported git workflows. The general law behind that,
and behind the `for-each-ref` probe being a cost increase rather than a closure: **no probe inside a
git directory survives an agent that can write inside that git directory.**

Documents cite entry points and never an area's internals, so a document goes stale when what an
area _offers_ changes — which is when it should be re-read — rather than every time an
implementation detail moves. A file named `*.generated.ts` is written by a tool and never edited by
hand.

That convention is enforced rather than merely stated: each link's target content is hashed, and the
docs check fails when it drifts.
