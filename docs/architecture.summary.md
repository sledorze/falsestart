# Why falsestart is built this way — summary

Explanation rather than a map; [Reference](./reference.md) has the lists.

The design follows from the moment it occupies — between an agent deciding to write and the bytes
landing. So it **judges text, not files** (the content is not on disk yet, and an edit is judged by
what it adds, never by what it leaves behind); it **runs on every tool call**, so the first question
asked is the cheapest one, and a tool that writes no source is answered without loading a rule; and
**being wrong is asymmetric**, since blocking good code teaches people to route around the guard,
which protects nothing.

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

**Five areas, separated by what each may know:** `checking/` (rule documents and source text),
`config/` (a repo's overrides), `hook/` (the agent protocol), `cli/` (the command line), `testing/`
(helpers for testing your own rules). Only `cli.ts` knows a process exists. Documents cite entry
points, never internals, so staleness means the offering changed; `*.generated.ts` is tool-written.
