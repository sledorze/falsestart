---
'@sledorze/falsestart': minor
---

Adds `--doctor` and `--version`.

There was no way to tell a working guard from a broken one. Every misconfiguration degrades to the
same place — exit 1, a line on stderr the agent runtime swallows, and the write proceeding — so a
registered hook that enforces nothing looks exactly like one with nothing to complain about. The
exit codes make it worse rather than better, because they are the hook contract's and not a human's:
blocking is exit 0 **with** stdout, allowing is exit 0 **without**, and failure is exit 1. So
`falsestart … ; echo $?` cannot distinguish "allowed" from "blocked", and a shell `if` reads a broken
guard as success. The only check available before this was hand-writing a hook payload, which nothing
documented.

`--doctor` reports what falsestart resolved — rules directory and count, where the config came from
and which rules it overrides, the tool calls it judges, and how many rules reach each of five probe
paths — then sends a real violation through the real decision path and reports what happened.

The probe paths include a **nested** one deliberately: `src/**.ts` and `src/**/*.ts` look alike and
behave completely differently, and a rule set with that typo guards top-level files while leaving
every nested source file unguarded. It reads no stdin, and exits 1 when a step fails to resolve or when the
sample cannot be judged at all — a rule that parses but is rejected by ast-grep at match time loads
cleanly, appears in every count, and then fails every real write with the reason swallowed.

An unreachable probe is reported, not failed: "misses five `src/` paths" is not "misses everything",
and a rule set scoped to `lib/**` blocks perfectly well while probing zero here.

The sample is reported as an observation rather than a verdict: `rules/effect` forbids no type
assertion, so a version that treated "sample not blocked" as failure told users of a working effect
guard that nothing was enforcing.

The case worth knowing: an override naming a rule the current preset does not load is a hard error,
so narrowing `--preset all` to `--preset clean-code` while keeping a config that mentions an Effect
rule turns the entire guard off. `--doctor` now says so and names the rule; previously it was
invisible.

`--version` previously exited 1 with `unrecognised argument: --version`.
