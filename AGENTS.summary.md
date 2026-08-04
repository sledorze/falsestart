# AGENTS.md — summary

The conventions this repository holds contributors to. Four of them.

**Documentation summaries.** Every Markdown file past the line threshold has a sibling
`X.summary.md`; every in-scope directory has a `_SUMMARY.md` linking to all of its children.
Freshness is tracked by content hash in `.cairn/` sidecars, outside the docs themselves, so it
survives clone and CI. `--refs` extends this to the _content_ of source files a doc links to, so a
doc goes stale when what it describes changes rather than only when a path breaks. Author the prose,
then `pnpm stamp`, then `pnpm check`. Never resolve a `.cairn/` conflict by hand: on a rebase both
sides are wrong, because the hash describes a merged tree neither parent holds — take either, then
re-stamp. And a summary can state a fact about a file it does not LINK to (the tarball inventory in
`README.summary.md` is a claim about `package.json`), which cairn cannot see at all; claims of that
shape belong in `src/documented.test.ts`. Three config-only checks exist and none is enabled:
`checks.coverage` (doc-kind rules) would restate in config what four documents already say,
`checks.docCoverage` (is this source file linked from a doc) contradicts the rule that documents
cite entry points and nothing below them, and `checks.freshness` (commit age) is a proxy for the
staleness `--refs` already detects from content.

**Releases** run on Changesets and are live — `RELEASES_ENABLED` and `NPM_TOKEN` are both set, and
`0.1.0` was published from `release.yml` with provenance. A user-facing change should carry a
changeset written for someone who will never read the PR, and `README.md`/`docs/` count as
user-facing: they ship inside the package, so a docs fix with no changeset never reaches npm.

**Content-mutation safety.** Anything that writes back to a file a person authored must decide _what
it may touch_ structurally — by path or declared role — never by a content pattern alone. A regex can
always fire on a file it was not meant for. Pair such a change with a negative test proving an
adjacent, similar-looking file is left alone.

**Shipping one iteration well.** Full local verify before every push (`pnpm verify`: lint,
format:check, typecheck, coverage:ci, build, docs — it must cover every gate CI applies, or verify can be
green while the merge is red). `pre-push` runs typecheck+test+build+docs+coverage+mutation. Table-driven tests use `describe.each` + `effect`, since `it.effect.each`'s curried form defeats
oxlint's callee resolution. See every new test fail before trusting it — write it first, or revert the implementation and watch
it go red; a test only ever observed passing is a claim, not a check, and four in one change passed
for reasons unrelated to the code. Dogfood the real behaviour against the scenario a
feature is meant to catch, including the negative case, then convert that proof into a permanent
test. Treat a structural claim in a doc as unverified until checked, not merely re-read. Before
pushing, get an adversarial review from ONE subagent prompted to refute, given the artifact rather
than your reasoning, told that finding nothing is a valid answer — and verify each finding yourself,
in a scratch directory outside this repo, before acting on it. One concern per PR, branched off the
right parent.
