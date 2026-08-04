---
'@sledorze/falsestart': minor
---

`--doctor` now names any rule whose config override covers fewer file extensions than the rule
ships with, and the same comparison is exported as `findNarrowedScopes`.

A scope override replaces a rule's `files` rather than merging into them. That is the right
behaviour — a merge could never remove anything — but it means an override written to add a single
file exemption has to restate the rule's entire glob, and any extension missing from that
restatement is silently no longer guarded. Nothing fails, because there is typically no file with
that extension in the repo yet for anyone to notice going unchecked.

falsestart's own config had been doing this since the release that added `.mts`/`.cts` coverage:
two overlooked extensions on `no-type-assertion`, six on `no-json-global`, full test suite green,
`--doctor` reporting a healthy installation the whole time. The new report is what finally named
it.

```
config   falsestart.config.ts — 1 override(s): no-try-catch
         no-try-catch stops covering .mts, .cts, .js, .jsx, .mjs, .cjs — the override replaces the rule's own files
```

Reported, never refused, and the exit code is unchanged: narrowing is what overrides are for, and
only you know whether a particular narrowing was meant. Only the language dimension is compared,
never directories, because that is where narrowing is almost always an accident of restating a glob
rather than a decision someone made.

`findNarrowedScopes(shipped, scoped)` returns the same data if you would rather assert it in your
own test suite than read it in a report.
