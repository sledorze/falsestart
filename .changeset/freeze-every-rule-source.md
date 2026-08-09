---
'@sledorze/falsestart': minor
---

`--freeze` now classifies every rule source independently, and by where its path actually sits.

`--preset` and `--rules` combine as of this release, and the freeze only ever classified one of the
two. Combined, the preset stopped being classified at all: `--doctor` printed `frozen`, exited
0, and judged with an unverified rule set the report never mentioned.

The first attempt at closing that refused under `--freeze require` whenever a preset was named. That
was a **content-free check wearing a policy hat** — it asked "was a preset named?" rather than "is
this path outside the repository?" — and it was wrong in both directions. A repository that vendors
its falsestart install commits those rule documents, and falsestart's own repository is one: it was
told `rules/clean-code` was "outside the project repository", with six of those documents in
`git ls-files`. Meanwhile a preset named ALONE was still frozen, so the same directory in the same
repository was refused with `--rules` and frozen without it.

Every source now goes through the same `classifyRules` the caller's own directory goes through:

- a preset in `node_modules` is untracked — the working tree under `auto`, refused under `require`,
  which is what it has always been;
- a **vendored** preset the repository commits is genuinely frozen and read from the ref, which is
  strictly more than it got before;
- `--doctor` prints one `shipped` row per preset saying which of the two it is.

It also fixes a separate silent wrong answer the refusal introduced: it returned before the ref probe
ran and handed the config classifier no evidence at all. Under `require` with a preset, a **committed
config was reported as absent and its overrides silently dropped**, an explicit `--config` was
reported as not committed, and a `--freeze-ref` that does not resolve was reported as `frozen`. Those
verdicts now come from the probe like every other.

`FreezeOutcome` gains an optional `shipped`, and `shippedRuleSources` is exported.
