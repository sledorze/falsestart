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
new every time — and nothing above the floor for a call that is not judged. The doc carries a
stamped measurement of each with the loop that produced it, and hands the reader `--version` as the
probe for their own floor. Nothing is cached between invocations and nothing promises it will be.

**Scope before content, always.** A rule acts on a file only when its path admits it. Breaking this
is silent in both directions, so path scoping is its own concern with its own negative tests.

**Borrowed semantics.** `constraints`/`utils` go to ast-grep untouched, because every gap between a
copy and the original becomes a rule that silently under-matches. One deliberate exception: the
native binding accepts matcher shapes the real CLI rejects and then matches nearly every node, so a
narrow check — modelled on measured CLI behaviour — rejects them.

**Three failures kept distinct:** code breaks a rule (block), a softer severity matched (show), the
guard could not run (say so loudly, do not block). A rule that cannot run is never reported as
"found nothing", but a typo in a rule file must not hold a repository hostage.

**Rules are programs, so they are wrong until shown otherwise** — worked examples of both kinds,
a blast-radius corpus no rule may flag, and a check that every API a message names is real.

**What a rule cannot see.** A rule is evaluated against the syntax tree of one file's text; that
text and the path it is destined for are the whole input, and nothing in the checking layer opens a
file. There is no repo-wide corpus, no index of files seen before and no rule type running
caller-supplied code at match time, so "flag this unless it is declared somewhere else in the repo"
is not expressible and is not planned — written down rather than left to be inferred, since an
absence cannot say whether a feature is unbuilt or unwanted. The precise line is between a rule's
SCOPE and its MATCH: a config file is executed, so a scope can be computed at load time (a `.ts`
config resolves `node:` builtins but not packages or relative paths; `.mjs` resolves anything),
while the only thing a config may change about a rule is `files`/`ignores` and nothing in it reaches
the matcher. `falsestart scan` answers the corpus-shaped question as far as whole files on disk —
still one file at a time.

**Six areas, separated by what each may know:** `checking/` (rule documents and source text),
`config/` (a repo's overrides), `hook/` (the agent protocol), `scanning/` (the filesystem: paths in,
a report out), `cli/` (the command line), `testing/`
(helpers for testing your own rules). `hook/` and `scanning/` are the two adapters and are separate
because their policies are opposite: the hook fails OPEN, since a broken rule must not hold every
write hostage, while a scan is a gate and fails CLOSED, since one that cannot run passes everything
while looking healthy. Only `cli.ts` knows a process exists. Documents cite entry
points, never internals, so staleness means the offering changed; `*.generated.ts` is tool-written.
