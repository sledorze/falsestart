---
'@sledorze/falsestart': patch
---

`--doctor` now fails when no rule loaded from any source, and two shipped documents that said
`--preset` and `--rules` cannot be combined are corrected.

A rules directory that EXISTS but holds no rule documents reported `0 loaded`, printed `no rule
applies to any probed path`, and exited **0** — while every judged write under it was allowed in
silence, `--fail closed` included. That is the state this command exists to catch, in its own words:
registered, silent, and enforcing nothing. A _missing_ directory already failed; an empty one did not.

It needs no inference, which is what separates it from the sentence beside it. `no rule applies to
any probed path` stays green because a rule set scoped to `lib/**` really does guard something, and
failing on that would call a working guard broken. Zero rules guards nothing, whatever the layout.

```
rules    ./.falsestart/rules — 0 loaded (0 block, 0 advise)
         NOTHING TO ENFORCE — no rule loaded from any source, so every write is allowed
```

Counted across every source, so an empty `--rules` directory beside a preset that loaded is not an
empty rule set.

Separately, `docs/using-the-hook.md` still said in two places that `--preset` and `--rules` are
mutually exclusive and that layering two trees means two hook entries. Both have been false since
they began combining. `docs/` ships inside the published `files` array, so the correction is
user-facing.
