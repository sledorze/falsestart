---
'@sledorze/falsestart': patch
---

A hook payload that carries no `cwd` no longer silently disables every repo-relative rule.

A rule's `files` glob is authored project-relative (`packages/*/src/**/*.ts`) while a hook reports an
absolute path, so something has to say which prefix to strip. The payload's `cwd` says it — and when
the payload carried none, the absolute path was matched raw, so every repo-relative glob admitted
nothing. That failure is total and completely silent: the rule loads, validates, reports on nothing,
and an unguarded file is indistinguishable from a clean one, in an installation `--doctor` calls
healthy. It now falls back to the directory falsestart is running in, which is where it resolved your
rules, your config and the freeze.

**This can turn a previously-passing repo red**, and that is the point: a rule that starts firing was
always meant to and never could. It reaches anything driving the hook that does not send `cwd` —
Claude Code always does, the Copilot envelope is provisional, and a hand-rolled integration may not.

The payload's `cwd` still **wins** when it names one. That is deliberate and was measured: preferring
the process directory instead stopped `cd packages/app && falsestart --rules ../../rules` blocking at
all, turning a deny into exit 0 with nothing on either stream. Both are legitimate anchors and only
the rule's author knows which their globs were written against, so nothing is silently re-pointed.

`--doctor` now names the anchor above the scope block — both halves of it, since it reads no payload
and can only report the fallback:

```
scope
         paths below are matched relative to /repo
         a judged write uses the payload's cwd when it carries one, and this directory when it does not
```

If those two differ, the rule counts below them are not the counts a judged write will get. That
disagreement is the remaining sharp edge in this area and the report now makes it visible instead of
leaving it to be discovered.

`DecideOptions.projectDirectory` is the new optional field, so a library caller written against 0.2.0
is unchanged.
