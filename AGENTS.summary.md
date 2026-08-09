# AGENTS.md — summary

The conventions this repository holds contributors to. Four of them.

**Documentation summaries.** Every Markdown file past the line threshold has a sibling
`X.summary.md`; every in-scope directory has a `_SUMMARY.md` linking to all of its children.
Freshness is tracked by content hash in `.cairn/` sidecars, outside the docs themselves, so it
survives clone and CI. `--refs` extends this to the _content_ of source files a doc links to, so a
doc goes stale when what it describes changes rather than only when a path breaks. Author the prose,
then `pnpm stamp`, then `pnpm check`. Never resolve a `.cairn/` conflict by hand: on a rebase both
sides are wrong, because the hash describes a merged tree neither parent holds — take either, then
re-stamp. A summary can state a fact about a file it does not LINK to (the tarball inventory in
`README.summary.md` is a claim about `package.json`); cairn 0.10 can see that edge after all, via a
fenced ` ```cairn-refs ` block declaring extra hash targets — adopted here for the five wiring files
AGENTS.md describes, and verified by editing `ci.yml` and watching `pnpm check` report the drift.
Claims naming neither a link nor a declared target still belong in `src/documented.test.ts`. Three
config-only checks exist and none is enabled: `checks.coverage` (doc-kind rules) does report an
invented document that cites nothing, but is satisfied by a link to any sibling doc, so a test
demanding a citation that resolves under `src/` — from any depth, so a doc in a `docs/`
subdirectory is judged by where its link lands rather than by a fixed number of `../` — replaced it; `checks.docCoverage` (is this source file linked
from a doc) contradicts the rule that documents cite entry points and nothing below them; and
`checks.freshness` (commit age) is a proxy for the staleness `--refs` already detects from content.
`refs.scope` is not adopted either — it makes `--refs` quieter, and nothing here is too noisy yet.

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
green while the merge is red). `lefthook` is ADVISORY and gates nothing — `--no-verify`, `LEFTHOOK=0`
and a clone that never installed the hooks all skip it, and no hook runs on a merge made in the
GitHub UI; `.github/workflows/ci.yml` is the only guard a merge can see (codeql.yml's job is gated
off), and it now runs `pnpm mutation:changed` there rather than only in `pre-push`, plus a
pull-request-only deletions report against the base branch — `pnpm check`'s `--report-deletions`
keeps cairn's default of comparing the WORKING TREE against HEAD, which inspects nothing on a CI
checkout, so it had never reported a deletion here. Table-driven tests use `describe.each` + `effect`, since `it.effect.each`'s curried form defeats
oxlint's callee resolution. See every new test fail before trusting it — write it first, or revert the implementation and watch
it go red; a test only ever observed passing is a claim, not a check, and four in one change passed
for reasons unrelated to the code. A green suite at 100% coverage left 269 of 3141 mutants alive on
this tree (score 91.40%), and a new module with a fixture-only test scores 0.00% at 100% coverage —
that gap is what mutation testing is for. A changed `x.test.ts` now drags `x.ts` into that run,
because a branch that only weakens a test used to skip the guard entirely; on a test-only diff read
the survivors, since the per-file floor of 70 catches a collapse and not an erosion. It does not
reach `src/cli.ts`, a test with no sibling implementation, or a source file no test imports (that
last is `coverage:ci`'s catch, not this one), and making it BLOCK is a manual branch-protection
step. Dogfood the real behaviour against the scenario a
feature is meant to catch, including the negative case, then convert that proof into a permanent
test. Treat a structural claim in a doc as unverified until checked, not merely re-read. Before
pushing, get an adversarial review from ONE subagent prompted to refute, given the artifact rather
than your reasoning, told that finding nothing is a valid answer — and verify each finding yourself,
in a scratch directory outside this repo, before acting on it. One concern per PR, branched off the
right parent.

`--refs` only protects prose that LINKS to the code it describes: the two behaviour docs now carry
link blocks to the parser, decision path, diagnostic, freeze and rule scoping — they tracked zero
source files while the architecture doc tracked eight, and held every false sentence found. That
convention is now a test, because on its own it did not hold: forty lines of invention with a
one-character summary passed `check` and the whole suite. An enumeration a document calls exhaustive
needs a test too: the shipped rules had one and stayed right, the exports had none and were missing
seven.

**No check here reads a document for truth, and none can.** A flatly false sentence inserted into
`reference.md` — the inverse of what `--fail` does — passed `pnpm check` at exit 0 once the
documented `pnpm format && pnpm stamp` had run, and passed all 28 assertions of the very test file
that exists to pin documentation claims. The guards fire on the EDIT, never on
its content. Adversarial review is therefore the PRIMARY control for prose truth, not a backstop;
what tooling contributes is the precondition, that a doc cites code at all and that its enumerations
are pinned.

Three guards exist because prose went false under a green `check`. `pnpm stamp` is NOT a
remediation — it clears a stale-summary report without changing a byte of the digest, so `pre-commit`
runs `scripts/stamped-not-written.sh`, which refuses a commit staging a summary's sidecar without the
summary (`SUMMARIES_REVIEWED=1` is the explicit opt-out). It covers FILE summaries only: `.cairn/refs/**` and
`_SUMMARY.md` are both exempt on purpose, the latter because a directory summary goes stale by Merkle
cascade on every descendant edit while its prose stays right. It did fire on the false-sentence
experiment, naming the summary whose sidecar moved without its prose — the one guard that noticed
anything. And it is a prompt, not a gate: lefthook is skippable, CI runs none, and the
opt-out is one word. It stays LOCAL and should not become a cairn
check: it is a policy rather than a tree invariant, needs the git index cairn never reads, and was
measured false 21% of the time on correct work.

`cairn config` (0.10) prints the resolved config and expanded roots — the way to answer "why is that
doc not checked". `stampCommand` is set in `.cairnrc.json` because cairn's own agent guidance reads
it: unset, it names a command that omits `--refs` and stamps before the formatter.
