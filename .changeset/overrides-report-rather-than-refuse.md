---
'@sledorze/falsestart': minor
---

A config override naming a rule this invocation did not load is now **reported by `--doctor`**
instead of failing the run.

**This makes falsestart less strict, deliberately, because the strictness was the bug.** The check
runs on the judging path, where the guard fails open — so a config written for a sibling hook entry
meant exit 1 with the write **proceeding unchecked**, and under `--fail closed` a denial of every
write in the repository. A scope override that did not apply became a guard that did not run.

It is also an ordinary state rather than a mistake. Two hook entries auto-discover the same
`falsestart.config.*`, so each necessarily sees overrides for rules only the other loaded.
`--preset` and `--rules` combining removed the common case; it did not remove two local trees, two
rule packages, or two presets, all of which still need two entries.

Measured in a repo with a preset entry and a `--rules` entry sharing one config: a `Date.now()` write
the loaded rule would have denied was allowed instead, exit 1, stderr swallowed by the agent runtime.

`--doctor` now names the ids so they are not silent either:

```
config   falsestart.config.json — 1 override(s): no-as-any
         no-as-any — no rule loaded here has that id, so the override does nothing.
         Expected if another hook entry loads it; otherwise a typo.
```

A typo looks exactly like the sibling entry's rule, and only you can tell them apart —
`ShippedRuleId` still catches typos at compile time in a `.ts` config.

**`--fail closed` no longer covers this case**, and its documentation is corrected accordingly: the
rules loaded and the config loaded, so the write can be checked.

`findUnappliedOverrides` is exported. `applyScopeOverrides` no longer fails, so its error channel
narrowed from `ConfigError` to `never` — source-compatible unless you were catching that tag.
