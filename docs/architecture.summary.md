# Why falsestart is built this way — summary

Explanation rather than a map; [Reference](./reference.md) has the lists.

The design follows from the moment it occupies — between an agent deciding to write and the bytes
landing. So it **judges text, not files** (the content is not on disk yet, and an edit is judged by
what it adds, never by what it leaves behind); it **runs on every tool call**, so the first question
asked is the cheapest one, and a tool that writes no source is answered without loading a rule; and
**being wrong is asymmetric**, since blocking good code teaches people to route around the guard,
which protects nothing.

The cost has those same three parts: a fixed floor every invocation pays (process start, the bundle,
the `@ast-grep/napi` binding), the rule tree above it — re-read every time, because the process is
new every time — and nothing above the floor for a call that is not judged. Deliberately no
millisecond table: one was written and did not survive re-measurement on a machine matching its own
stamp, so the doc states ratios (the floor dominates a small rule set; 7× the rules is nowhere near
7× the cost; a rule's shape is work, not only its count), hands the reader `--version` as the probe
for their own floor, and publishes the loop and the tree construction to reproduce. Nothing is
cached between invocations and nothing promises it will be.

**Scope before content, always.** A rule acts on a file only when its path admits it. Breaking this
is silent in both directions, so path scoping is its own concern with its own negative tests.

**Borrowed semantics.** `constraints`/`utils` go to ast-grep untouched, because every gap between a
copy and the original becomes a rule that silently under-matches. One deliberate exception: the
native binding accepts matcher shapes the real CLI rejects and then matches nearly every node, so a
narrow check — modelled on measured CLI behaviour — rejects them.

**Six failures kept distinct:** code breaks a rule (block), a softer severity matched (show), the
guard could not run (say so loudly, do not block BY DEFAULT), the rule source could not be read AS
COMMITTED (refuse to judge; never fall back), the hook payload is malformed (say so loudly; never the
REASON to block, in any policy), and the payload names a tool from a DIFFERENT contract than
`--agent` declared (say so loudly, on the channel the runtime that really sent it reads; never the
REASON to block either). A rule that cannot run is never reported as "found nothing", but a typo in a
rule file must not hold a repository hostage. The fourth amends the third in the safe direction:
under a freeze a working-tree typo never reaches the loader at all, so what refuses is a COMMITTED
rule set that will not load — falling back there would make breaking git the cheapest disarm
available. The third is a POLICY and `--fail closed` inverts it; the fifth is the row that policy
does not reach, because a malformed payload is the runtime's shape rather than the repository's and
an agent told "denied" would rewrite code that was never judged. The sixth exists because `--agent` can be wrong and one direction of
wrong is silent: membership of the tool name in another contract's declared, closed table is proof
the flag names the wrong runtime, and structural rather than a guess about the name. Under
`--agent copilot` the price list shifts and the table still holds: a deny is exit `2`, and everything
that exits `1` under Claude Code exits `0`, because Copilot denies on every other non-zero exit —
which makes the malformed-payload row stronger there, not weaker. No fifth `Decision` tag: what a
guard failure COSTS is a fact about the invocation, so it is a rendering policy in `hook/respond.ts`
and `decide` stays policy-free.

**Which repository the freeze trusts** is resolved by walking outward from the project to the nearest
`.git` that is a real DIRECTORY, and never by letting git discover one for itself. A `.git` gitfile is
one ordinary write, and it moves a toplevel onto itself so a containment check still passes; a
directory cannot be replaced by a write (`EISDIR`). What the walk cannot verify — a linked worktree
outside its main repository, `--separate-git-dir` — is reported rather than refused by default. The
law behind that, and behind the `for-each-ref` probe being a cost increase rather than a closure: no
probe inside a git directory survives an agent that can write inside that git directory.

**Rules are programs, so they are wrong until shown otherwise** — worked examples of both kinds,
a blast-radius corpus no rule may flag, and a check that every API a message names is real.

**What a rule cannot see.** A rule is evaluated against the syntax tree of one file's text; that
text and the path it is destined for are the whole input, and no code on the matching path opens a
file (the layer reads the filesystem only to load rule documents). There is no repo-wide corpus, no index of files seen before and no rule type running
caller-supplied code at match time, so "flag this unless it is declared somewhere else in the repo"
is not expressible and is not planned — written down rather than left to be inferred, since an
absence cannot say whether a feature is unbuilt or unwanted. The precise line is between a rule's
SCOPE and its MATCH: a config file is executed, so a scope can be computed at load time (a `.ts`
config resolves `node:` builtins but not packages or relative paths; `.mjs` resolves anything),
while the only thing a config may change about a rule is `files`/`ignores` and nothing in it reaches
the matcher. `falsestart scan` answers the corpus-shaped question as far as whole files on disk —
still one file at a time.

**Seven areas, separated by what each may know:** `checking/` (rule documents and source text),
`config/` (a repo's overrides), `hook/` (the agent protocol), `scanning/` (the filesystem: paths in,
a report out), `freezing/` (what a git ref committed, parsed from git's plumbing output — it spawns
nothing), `cli/` (the command line), `testing/`
(helpers for testing your own rules). `hook/` and `scanning/` are the two adapters and are separate
because their policies are opposite: the hook fails OPEN, since a broken rule must not hold every
write hostage, while a scan is a gate and fails CLOSED, since one that cannot run passes everything
while looking healthy. Only `cli.ts` knows a process exists among the code that ships;
`testSupport/` spawns git and bash for this project's own guards and is excluded from the build.
Documents cite entry
points, never internals, so staleness means the offering changed; `*.generated.ts` is tool-written.
