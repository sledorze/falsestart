---
'@sledorze/falsestart': minor
---

`--doctor --path <p>` probes a path you actually have, and fails when no rule applies to it.

`--doctor` probes five synthetic paths, all under `src/`. A rule set scoped to a monorepo layout —
`packages/*/src/**` — matches none of them, so the report printed `0 rule(s) apply` five times, said
`no rule applies to any probed path`, and exited **0**. Every path-scoping mistake lands in exactly
that shape, which made the one command meant to answer "is this guarding anything?" useless as a
check for the failure class it exists to catch.

The exit code could not simply be changed, and that is the point of the new flag: a rule set scoped
to `lib/**` or to a monorepo blocks perfectly well while probing zero here, so failing on that
inference would call a working guard broken. A path YOU name carries the meaning the built-in probes
cannot — it is a statement about your layout rather than a guess at it — so naming one asserts it
should be in scope:

```console
$ falsestart --doctor --rules ./.falsestart/rules --path services/api/src/index.ts ; echo $?
check    no rule applies to services/api/src/index.ts — named with --path, so this is a failure rather than a note
1
```

Repeatable, and refused in every other mode, where a real path is already in hand. A `--path` that
is not a file — a typo, a directory, a glob — is reported as its own failure rather than as a
coverage gap; reported as the same red, a mistyped path is indistinguishable from the scoping bug
the flag exists to catch.

An absolute path is relativised against the directory falsestart runs in, which is **not** always the
anchor a judged write uses — the hook prefers the payload's `cwd` when it carries one. In CI they are
the same directory, which is what makes this a usable gate; in a live session whose `cwd` sits below
the project root they are not, and the report says so above the block.

**This can turn a previously-passing CI check red** only if you adopt the flag — nothing changes for
an invocation that does not pass `--path`, including `no rule applies to any probed path` still
exiting 0.

The scope block also now names any loaded rule that **no** probed path reaches — and separately any
whose own `ignores` exclude everything their `files` admit, for which no `--path` value can ever
help. `0 rule(s) apply to
src/a.ts` is a fact about the path and never said which rule was inert; with a dozen loaded and one
scoped to a directory that no longer exists, no line of the report named it. Informational, never
fatal, for the same reason the built-in probes cannot fail.

Reported in #66.
