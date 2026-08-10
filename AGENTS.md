# AGENTS.md

# Documentation summary convention

This repo enforces a **hierarchical, content-hashed documentation summary** tree.
CI runs `cairn check` and **fails the merge** if any summary is missing,
stale, or a link is broken. Treat green `check` as a hard requirement, not a nicety.

## The invariant

1. **File summaries** — every Markdown file longer than the threshold (default 30
   lines) has a sibling `X.summary.md`: a fast-to-read digest of the CURRENT content
   of `X.md`.
2. **Directory summaries** — every in-scope directory has a `_SUMMARY.md` that
   aggregates its direct docs (each doc's `.summary.md` if the doc is big, else the
   doc itself) plus the `_SUMMARY.md` of each direct sub-directory. It links to
   **every** direct child file and sub-directory (link-completeness).
3. **Freshness by content hash, tracked OUTSIDE your docs** — each summary's hash is
   recorded in a hidden sidecar under `.cairn/`, one JSON file mirroring each summary's
   path (e.g. `.cairn/docs/a.summary.md.json`). The checker recomputes the source hash
   and compares it to the sidecar; mismatch = stale, absent = missing. This survives git
   clone and CI (mtime does not), and it means the tracking system leaves **zero bytes**
   in the docs you write — no stamp comment to see, ignore, or accidentally hand-edit.
   Commit `.cairn/` alongside your docs; it's not gitignored.
4. **Bottom-up in one pass** — a directory summary hashes a manifest of its children's
   hashes (a Merkle tree), so (re)write leaves-first: file summaries, then directories
   deepest-first, then stamp.
5. **Deletions are caught too** — a sidecar left behind with no matching doc (its source
   was deleted or renamed) is flagged as a deleted-source stamp; `--prune` removes both
   the leftover summary and its sidecar.

## Workflow when you edit docs

When you create or edit any doc — **or any source file a doc links to**:

1. If the doc is longer than the threshold, create or update its `X.summary.md` to
   reflect the new content.
2. Update the `_SUMMARY.md` of every affected directory, walking **up** the tree
   leaves-first, and keep a link to every child file and sub-directory.
3. Run the stamp command to (re)write the sidecar hashes under `.cairn/` bottom-up:
   `pnpm stamp` (`cairn check --summaries-only --refs --stamp`). Stamp AFTER formatting: prettier
   reflows markdown tables, and a stamp taken before it is stale the moment the formatter runs.
4. Run `pnpm check` and ensure it exits 0 (green) before you finish.
5. Commit your doc changes **together with** the `.cairn/` sidecar changes — a doc
   edit without its matching sidecar update is exactly what `check` is designed to catch.

**Never resolve a `.cairn/` conflict by hand.** A rebase across two branches that both touched docs
conflicts on the sidecar hashes, and BOTH SIDES ARE WRONG — the hash describes the merged tree,
which neither parent contains. Observed: resolving `.cairn/_SUMMARY.md.json` by taking one side and
then running `pnpm stamp` produced a _third_ value. Take either side to get the rebase moving, then
re-stamp and commit that; picking a side and stopping records a hash for a tree that never existed,
and `check` goes green on it.

Also worth knowing about the tool's reach: a summary can state a fact about a file it does not LINK
to — `README.summary.md` lists what the tarball ships, which is a claim about `package.json`.
`--refs` hashes the targets of `[text](path)` links, and `--prose-refs` fires on a backticked path
that MOVED. A sentence naming neither stays green while going false, which is what happened when
`CHANGELOG.md` was added to `files`.

This file used to say cairn **cannot see that edge at all**, and as of 0.10 that is no longer true:
a fenced ` ```cairn-refs ` block declares extra targets, hashed and drift-reported exactly like a
real link's, for the claims that have no hyperlink to make. The block below this section's closing
line does that for the five files whose wiring this document describes — the claims that went stale
first, and the ones a reader has no way to re-derive. Verified by appending one line to
`.github/workflows/ci.yml` and running `pnpm check`:
`~ .github/workflows/ci.yml (83055438 → 69c18cbf)`, exit 1. Removing the line made it green again.

A claim about a file that is neither linked nor declared still belongs in `src/documented.test.ts`,
where several already live — and a claim about an ENUMERATION belongs there regardless, because a
hash says a file changed, never that a list of its contents is complete.

## Commands

- `pnpm check` — check summaries + links + **reference drift** (exit 1 on any problem).
  `--refs` is what makes a doc's claim about a source file re-checkable: every `[text](../src/x.ts)`
  link has its target's content hashed, and a later run fails when that content has changed. Without
  it cairn verifies only that the PATH resolves — `src/checking/scope.ts` could be replaced wholesale
  with `export const appliesTo = () => true` and the check would stay green.
- `cairn check --summaries-only` / `--links-only`.
- `cairn check --links-only --fix` — auto-repair unambiguous dead links.
- `cairn config` — print the RESOLVED config, where it came from, and the expanded roots. New in
  0.10, and the way to answer "why is that doc not checked" without guessing. It also shows the keys
  you never set: `onlyGitTracked`, `refs.scope`, `proseRefs.ignore`, `stampCommand`.
- `stampCommand` is set in `.cairnrc.json`, and setting it is load-bearing rather than tidy. cairn
  0.10's own agent guidance tells an agent to read that key and run what it names; unset, it falls
  back to `--summaries-only --stamp` — which omits `--refs`, and stamps BEFORE the formatter runs.
  The value here is `pnpm format && pnpm stamp`, so the ordering this file insists on is machine
  readable rather than a paragraph an agent has to find.
- `pnpm stamp` — write the `.cairn/` sidecar hashes of EXISTING summaries bottom-up, and of every
  source file the docs link to. It does **not** author prose; you write the content, then stamp.
  Re-stamping after a source change is the point, not a chore: it is where you say the doc's claim
  about that file is still true.
- `cairn check --explain` — say WHY each stale or missing summary is not ok. Useful because the
  tree is a Merkle tree: editing one document marks its `_SUMMARY.md` stale too, and the report
  alone does not say which child caused it. Observed on a one-line edit to `docs/overview.md`:
  `dir docs/_SUMMARY.md (stale): driven by stale/missing child: docs/overview.md`.
- `cairn check --prune` — delete orphan summaries and orphan `.cairn/` sidecars
  (source doc deleted, renamed, or below threshold).
- `--prose-refs` — checks bare-backtick file citations in prose (`` `src/x.ts` ``, with no
  `[text](path)` syntax), which read as documentation but are invisible to a link checker. On in
  `pnpm check`. It found a changeset citing a rule path months after the rule moved. As of cairn
  0.7 its help text says "safe for permanent use" rather than calling it a migration aid, and 0.10
  still does — though its clean-run wording changed from "no drifted" to "no broken" references.
- `--report-deletions` — informational, never affects the exit code: names what a deleted document
  took with it (its outbound references and headings) when nothing else in the tree carries them.
  On in `pnpm check`, comparing against the working tree; pass `--deletions-since <ref>` to check
  deletions already committed on a branch. This exists because a lossy dedup here removed the only
  description of `--refs`, `--prose-refs` and `checks.coverage`, and every check stayed green.
- Three checks are **config-only**, with no flag of their own — enabled by naming them in
  `.cairnrc.json`. As of 0.9 the `check --help` description lists all three, which it did not in
  0.7, and 0.10 keeps them; the note here used to say `checks.coverage` was invisible to `--help`, and that stopped being
  true at the upgrade. None of the three is enabled, and each for a reason worth keeping:
  - `checks.coverage` declares document _kinds_ by path glob and _rules_ between them ("every
    explanation doc must link to a reference doc"), then reports the ones missing. It is the check
    that would notice a missing Diátaxis quadrant. With four documents the rules would be asserted
    both in `.cairnrc.json` and in the docs themselves. Revisit if the doc set grows.
  - `checks.docCoverage` asks the other direction — is this SOURCE file documented anywhere at all,
    by a link from some doc that already exists. It overlaps `src/documented.test.ts`, which already
    asserts every area entry point is cited by the architecture doc. It is not adopted because this
    repo's rule is narrower than "documented somewhere": the architecture doc deliberately cites
    entry points and NOTHING below them, so a check demanding every source file be linked would
    contradict the convention it was meant to enforce. The test also asserts the inverse — that no
    file below an entry point is cited — which `docCoverage` cannot express.
  - `checks.freshness` reports a doc whose most recent commit is older than `maxAgeDays`. It is a
    proxy for staleness, and this repo already has the causal signal: `--refs` fails when the
    CONTENT a doc cites has changed, whether that was yesterday or last year. Age would add noise on
    documents that are old and correct, which most of these are meant to be.

`CHANGELOG.md` is excluded in `.cairnrc.json`, and the reason generalises: the convention is for
docs a person AUTHORS. The changelog is generated by `changeset version`, so a summary of it would
be a hand-written digest of machine-written text, stale at every release and re-stamped by reflex —
the exact failure this convention exists to prevent. Without the exclusion the release itself fails,
since `release.yml` runs `pnpm verify` before publishing and the generated file arrives with no
summary. Anything a person writes is still covered: verified by dropping a forty-line authored
document into `docs/` and watching the check demand a summary for it.

You author the prose. The tool only verifies and stamps — and it never touches your prose to do it.

```cairn-refs
.github/workflows/ci.yml
lefthook.yml
scripts/mutate-changed.sh
scripts/stamped-not-written.sh
stryker.config.json
```

**Link a behaviour doc to the code that decides the behaviour.** `--refs` is only armed on the docs
that actually carry `[text](../src/x.ts)` links. `architecture.md` carried eight and stayed correct;
`reference.md` and `using-the-hook.md` carried **zero** — and those two held every false sentence
found this week, green the whole time. Both now open with a block of links to the parser, the
decision path, the diagnostic and the freeze, so a change to any of them fails `check` and forces
the prose to be re-read. The links exist to be hashed, not followed.

Enforced by `src/documented.test.ts` rather than by the convention alone, because the convention
alone did not hold: a forty-line document of pure invention was added to `docs/`, given a
one-character summary and a line in `docs/_SUMMARY.md`, stamped, and passed `pnpm check` and the
whole suite. Every markdown file in `docs/` must now cite at least one file under `src/`, RESOLVED
from wherever the document sits — `../src/x.ts` at the top of `docs/`, `../../src/x.ts` one
directory down — rather than matched at a fixed depth. That distinction is not pedantry: the first
version of this test read the directory recursively but matched a single `../`, so the same document
with the same valid citation passed in `docs/` and failed in `docs/guides/`, accusing the doc of
citing nothing while `cairn check --links-only` resolved the link. It cuts the other way too — a
citation with the wrong number of `../` lands on a `src/` directory beneath `docs/` that does not
exist, and no longer counts merely because the tail of the string looks right. Two
exemptions that are structural rather than editorial — a `.summary.md`, whose parent carries the
citations, and `_SUMMARY.md`, which is a link index. `overview.md` is exempt by name as the
one-paragraph front door; if it ever describes behaviour, delete the exemption.

**What that test does NOT do is make the prose true**, and neither does anything else here. See "The
boundary of the documentation guards" below before trusting a green `check` to mean a document is
correct.

**An enumeration a document claims to be exhaustive about needs a test.** `reference.md` opens
"Every flag, export and shipped rule". The rules were pinned by a test and stayed right; the exports
were pinned by nothing and were missing seven entries, six of them from that week's own work.
`src/documented.test.ts` now pins them too.

**`pnpm stamp` is not a remediation.** cairn reports a stale summary correctly; stamping clears the
report without changing a byte of the digest, so the command that makes the complaint go away is
cheaper than the work it is complaining about. Four summaries went stale under a green `check` in a
single week, every one caught by a reviewer reading the prose rather than by a tool. `pre-commit`
now runs `scripts/stamped-not-written.sh`, which refuses a commit that stages a summary's sidecar
without staging the summary — the one question the hashes cannot ask. It covers FILE summaries only. Two things
are exempt and both on purpose: `.cairn/refs/**`, which hashes a doc's link targets rather than its
digest, and `_SUMMARY.md`, whose prose is a link index over the child SET while its hash is a Merkle
hash over child CONTENT — so it goes stale on every descendant edit with its prose still correct.
Including it was tried, after a review called the exclusion a coverage gap, and it fired immediately
on a `_SUMMARY.md` that was right: near-100% false positives, which is how a check gets disabled.

It is not a gate. `lefthook` is skippable with `--no-verify`, CI runs no lefthook at all, and
`SUMMARIES_REVIEWED=1` is one word. It is a prompt at the moment the question is answerable, not a
guarantee that it was answered.

That script **stays here, and should not become a cairn check** — a first pass concluded the
opposite and the measurement reversed it.

It is a policy, not an invariant. Every check cairn ships is a property of the tree: the summary
exists, its hash matches, the link resolves, the referenced content has not drifted. "A human
rewrote the digest when the source changed" is a claim about how a commit was made, and over sixty
commits here it was **false 21% of the time while everything was correct** — 18 of 86 doc edits
changed a source without its summary, median four added lines, almost all of them a row appended to
a reference table. That is the most common doc edit in this repo and it never changes the digest. A
published check firing on one doc edit in five, mostly wrongly, is one adopters disable — which is
the reasoning `--warn-unscoped` is off by default for, applied to cairn.

It also needs the git INDEX. cairn compares the working tree against a ref and reads commit history;
it never inspects what is staged, and the guard's question only exists at the moment of staging.

What cairn genuinely lacked was already there or already filed. Cause 1 was closed by arming
`--refs`, a feature cairn has shipped all along and this repo had simply never pointed at its
behaviour docs. Cause 3 was closed by a test here, as this file already prescribed.
[cairn#131](https://github.com/sledorze/cairn/issues/131) covers the remaining ground with a better
shape than a new check — scoped and interactive stamping, which PREVENTS the reflex instead of
detecting it afterwards, and so has no false positives to suppress.

## The boundary of the documentation guards

**No check in this repository reads a document for truth, and none can.** Everything above verifies
a RELATIONSHIP — the summary exists, its hash matches, the link resolves, the cited content has not
drifted, the doc cites something. A sentence that is simply false about code nobody has touched
satisfies every one of them.

Measured rather than argued. `docs/reference.md` carries `--refs` links to the parser, the decision
path, the diagnostic, the freeze, rule scoping and the config, and this sentence was inserted into
it:

> falsestart denies every write by default, and `--fail open` is required to allow anything.

It is the exact inverse of what `--fail` does. `pnpm check` failed at first — not on the sentence,
but because `reference.md`'s own hash had moved — and the documented remediation, `pnpm format &&
pnpm stamp`, cleared it: `✅ Markdown links OK`, `✅ Hierarchical summaries OK`, `✅ References OK`,
exit 0. `src/documented.test.ts`, the file that exists to pin documentation claims, passed all 28 of
its assertions over that text. The guard fires on the EDIT, never on its content, and the fix
for the edit is one command.

One thing did notice, and it is worth knowing exactly how far it goes.
`scripts/stamped-not-written.sh` refused the commit, naming `docs/reference.summary.md`, because the
sidecar was staged and the digest was not. That is the moment of maximum leverage — someone is being
asked, at the keyboard, whether the digest still holds — and it is also a pre-commit hook, cleared by
`SUMMARIES_REVIEWED=1`, by `--no-verify`, or by editing one word of the summary.

So for the truth of prose, **adversarial review is the primary control, not the backstop.** The
review convention further down is load-bearing in a way no CI job can replace: give the reviewer the
document and the code and tell it to find the sentence that is false, because that is the only reader
of any kind that will.

Two things a tool CAN do, and both are now done, because they are the preconditions the review
depends on: every behaviour doc cites source (so `--refs` has something to hash, and a change to the
code forces the prose back in front of someone), and every enumeration a doc claims to be exhaustive
about is pinned by a test. Neither is truth. Both are what makes a false sentence more likely to be
re-read by someone who can tell.

Re-tested against the current doc set, since a rejection is only as good as its date:

- `checks.coverage` is now **half adopted in spirit and rejected as config**. A kind of "every doc
  in `docs/`" with a rule `{ "to": { "external": "path" } }` does report the invented document —
  verified, `✗ no link ("cites_code") to an existing file`. It is weaker than the test that replaced
  it: adding `[the overview](./overview.md)` to the same fiction satisfied it (`✅ Coverage OK`),
  because any resolvable path counts, including a sibling doc. `src/documented.test.ts` demands a
  citation that RESOLVES under `src/` specifically, needs no config, and runs in the suite CI already
  gates on.
- `checks.docCoverage` — unchanged and still rejected, for the reason already recorded: it cannot
  express "cites entry points and nothing below them", which is the actual convention here.
- `checks.freshness` — unchanged and still rejected. Age is a proxy; `--refs` is the causal signal.
  A false sentence about code that has not changed is exactly the case age would not catch either.
- `refs.scope` — considered and NOT adopted. It exempts globs from hashing, i.e. it makes `--refs`
  quieter. Nothing here is too noisy yet; adopt it the day a churn-heavy target starts producing
  drift reports nobody reads, and not before.

# Release convention

Releases are automated via [Changesets](https://github.com/changesets/changesets) (see
`.github/workflows/release.yml`) — merging to `main` with unconsumed `.changeset/*.md`
files opens a "Version Packages" PR (bumped `package.json`, generated `CHANGELOG.md`);
merging that PR publishes to npm, pushes the git tag, and creates a GitHub Release.

**Both switches are on and the pipeline has run.** `RELEASES_ENABLED` is set and `NPM_TOKEN`
exists; `0.1.0` is on npm, published by `release.yml` from `refs/heads/main` — provable without
repository access, since the tarball carries SLSA provenance naming that workflow and run. This
paragraph said "two switches away" for a while after that stopped being true, which is the same
staleness the documentation convention above exists to catch, in the file a contributor agent
reads first.

The variable name is `RELEASES_ENABLED` with underscores, not hyphens: GitHub rejects a hyphenated
variable name with HTTP 422, and the gate originally named one that could never exist, so the
release job could never have run at all. Worth keeping in mind if it is ever renamed.

The practical consequence, now that releases are live: **`README.md` and `docs/` are inside the
published `files` array, so a documentation fix is a user-facing change.** Without a changeset
there is no version bump, `changeset publish` no-ops, and the registry keeps serving the old prose
indefinitely — the corrected text sits on `main` where the person who needed it will never see it.

If your PR is a user-facing change (not docs-only, not internal tooling with no effect
on the published package), run `pnpm changeset` and commit the generated file alongside
your change. Not enforced by CI — a missing changeset just means that change won't show
up in the next changelog, not a build failure.

# Content-mutation safety (writing to files this codebase doesn't fully own)

Any code path that WRITES BACK to a file the user authored — not a build artifact, an
actual doc/source/config file the user might have written by hand — must scope _which
files it's allowed to touch_ structurally (by path/role classification: is this a
generated artifact? a managed summary? a config this tool owns?), **never by a
content-pattern match alone**. A regex/string match against file content can legitimately
fire on a file that isn't the kind of file the operation is meant for — e.g. a doc that
_documents_ a format falsestart itself manages, with a real-looking example of it in
prose, or a source file that happens to contain a string shaped like a pattern the tool
is meant to rewrite elsewhere.

**When you add or review any new write path** (an auto-fix flag, a migration, an
auto-repair, or — given what this tool does — a rule that edits/blocks code as it's
written): ask "what stops this from firing on a file it wasn't meant for?" If the answer
is only "the content happened to match," that's not yet a real answer. Identify the exact
structural element you're allowed to touch first (a specific AST node, a specific
declared file role, a specific link target), then mutate only that — never "find this
pattern anywhere and act on it."

Pair the fix with a NEGATIVE test — not just "the target file gets acted on correctly,"
but "an adjacent, superficially-similar file is provably left untouched."

# Shipping one iteration well

**Full local verify before every push, every time — not just before "done."**
`pnpm lint && pnpm format:check && pnpm typecheck && pnpm coverage:ci && pnpm build && pnpm check &&
pnpm mutation:changed` (`pnpm verify` runs all seven — `format:check` is in there because CI enforces
it, and a verify that omits a gate CI applies is a verify that can be green while the merge is red).

That rule used to be broken by `verify` itself: it ran `pnpm test`, while CI and `pre-push` both run
`pnpm coverage:ci`, whose 100% thresholds `pnpm test` does not apply. A change with uncovered
branches therefore passed a full local `verify` and was rejected at push — observed, not theorised.
`coverage:ci` runs the same tests, so nothing is lost by using the stricter one.

It was broken again the moment CI gained the `mutation` job, in the same way, by the change that
added the job — and by a reviewer's reading rather than by anything that could observe it. So the
list is no longer maintained by hand: `src/guards.test.ts` reads both `package.json` and `ci.yml` and
fails when a `pnpm` step CI runs is absent from `verify`. Two costs worth knowing. `mutation:changed`
adds about a minute per changed source file, and nothing at all on a docs-only branch. And it scores
`HEAD` in a disposable worktree, never your working tree, so run it after committing — before that
it is answering about the previous commit.

**`lefthook.yml` is advisory. It gates nothing.** `pre-commit` runs lint/format/docs and the stamp
guard; `pre-push` runs typecheck+test+build+docs+coverage+mutation — and every one of those is
skipped by `git ... --no-verify`, by `LEFTHOOK=0` (verified: `LEFTHOOK=0 lefthook run pre-push` exits
0 having printed nothing), by `LEFTHOOK_EXCLUDE=<name>` for one command at a time, and entirely by a
clone where `pnpm install` never ran `prepare` — which is `lefthook install || true`, so a failure to
install the hooks is silent by design. No hook of any kind runs on a merge performed in the GitHub
UI, which is how most of them land here.

The only guard a merge can see is `.github/workflows/ci.yml`. `codeql.yml`'s single job is behind
`if: vars.codeql-enabled == 'true'`, which its own comment says is off until Advanced Security is
enabled, and `dependabot-auto-merge.yml` merges rather than checks. (Whether CI is a _required_
check is branch protection, which lives outside this repository and cannot be read from it; a green
tick nobody made mandatory blocks nothing — **adding the `mutation` job to the required set is a
manual step, and until someone does it that job reports rather than blocks**, while
`dependabot-auto-merge.yml` merges as soon as the currently-required checks pass.) CI runs
lint, format:check, typecheck, coverage:ci, build, check — and, since the `mutation` job was added,
`pnpm mutation:changed` on every pull request. That job is where the "a test that cannot fail" guard
lives now; before it, that guard ran only in the skippable hook, which is the same as nowhere.

Two things stay hook-only, and both because CI cannot express them.
`scripts/stamped-not-written.sh` asks a question about the git INDEX — what is staged next to what —
and a CI checkout has no index to ask about. And no hook, and no job, can construct the scenario a
feature is meant to catch for you (see "Dogfood," next). Treat the hooks as a prompt at the moment a
question is answerable, never as evidence the question was answered.

**Dogfood the actual CLI/behavior against a real scenario before calling a feature
done — unit tests that pass are necessary, not sufficient.** Run the real build and
exercise it for real, including the negative case: construct the exact scenario the
feature is meant to catch, confirm it's reported/blocked, then revert and confirm it's
clean again.

**See every new test fail before you trust it.** Write it first, or if you did not, revert the
implementation and watch it go red. A test that has only ever been observed passing is a claim, not
a check — and the failure is silent, because a green suite is exactly what it looks like.

This is not hypothetical here. One test asserted the `--doctor` flag was carried onto a code path
that did not consume it, and passed the whole time nothing did. One searched the entire README for
an install command and passed against a README saying "do NOT run this command". One asserted three
substrings that already appeared elsewhere in the same output, and passed against a diagnostic that
reported nothing at all. One claimed to guard a path-normalisation bug while a `realPath` call
upstream made it green either way — that one is now documented in place, pointing at the test that
does guard it.

None were caught by review. All four were caught by reverting the fix and looking.

**How much a green suite at 100% coverage does not prove, in a number.** A full `pnpm mutation` run
of this branch: score 91.40%, 3141 mutants, **269 survivors** — 269 single-point changes to `src/`
that no test objects to, at 100% statements, branches, functions and lines. Worst areas `scanning`
(87.10) and `config` (89.56); best `cli` (94.67). That is the size of the gap `pnpm coverage:ci`
cannot see, and the reason `pnpm mutation:changed` now runs on every pull request rather than only in
a hook. Read the survivors when you touch a file; the score is a threshold, the survivors are the
information.

**A branch that only weakens a test is the shape that gate was blindest to.** `mutate-changed.sh`
selected changed SOURCE files and filtered tests out, so deleting every assertion about `appliesTo`
from `src/checking/scope.test.ts` while touching no source printed `no mutatable source changed on
this branch, skipping` and exited 0 — the guard against tests that stop constraining code, skipping
the change that stops a test constraining code. A changed `x.test.ts` now pulls `x.ts` into the
mutated set, mapped by the file-role convention rather than by guessing which sources a test touches.
Its limit, measured on that same branch: the run then reports `scope.ts` at 90.38% with 15 survivors
and stays GREEN, because the floor of 70 catches a collapse and not an erosion, and `--mutate <file>`
scores the whole file rather than the change. Read the survivor list on a test-only diff; the exit
code is not the signal there. Three more things it does not reach: `src/cli.ts`, excluded from
mutation entirely; a test with no sibling implementation, which has nothing to score; and a source
file no test reaches at all, which Stryker's `allowEmpty` passes with zero mutants run — that last
one is caught by `coverage:ci`'s 100% thresholds instead, by the other gate rather than this one.

Its counterpart in the small: a new module with a test that calls every function and asserts only
properties of its own fixture reports 100% coverage and a green suite, and scores **0.00%** with all
fourteen of its mutants surviving. That is a real reading, not an illustration: add such a pair on a
branch, run `MUTATION_REQUIRE_BASE=1 pnpm mutation:changed`, and watch the job that CI runs go red on
a change that `pnpm verify` calls clean.

**Table-driven tests use `describe.each` + `effect`, not `it.effect.each`.** The curried form
`it.effect.each(table)(name, fn)` leaves oxlint's vitest plugin unable to resolve the callee:
`no-standalone-expect` can be satisfied by adding it to `additionalTestBlockFunctions`, but
`expect-expect` still reports every case as a test with no assertions. `describe.each` wrapping the
`effect` wrapper this repo already registers needs no config change and lints clean.

**Convert every manual dogfooding proof into a permanent test before moving on.** A bug
you found by hand and fixed, with no test added, is a bug that can silently come back.
Prefer a real temp directory / real filesystem fixture over an in-memory test double
alone when the thing under test is specifically about real filesystem or process
behaviour — the in-memory double is faster and still worth keeping alongside it, but it
can't catch what only the real integration exercises.

**Treat a structural/architectural claim in a doc as unverified until grepped, not just
re-read.** "The architecture doc reflects the code" and "these two modules don't depend
on each other" are exactly the kind of claim that silently rots as a codebase grows.
Verify by construction: grep every import, confirm every doc-linked path resolves,
confirm every real source file is named somewhere. For anything you can't easily
self-check (you wrote both the code and the doc, so you're not a neutral reader of
either), get an independent read — see the adversarial-review convention below, which
applies to structural claims as much as to code.

**Always get an adversarial subagent review before you push — prompted to refute, with no access
to your reasoning.** Not "review this", not "check my work": the subagent must be told to assume the
change is wrong and to find where it does not hold, and it must be given the artifact rather than
your account of it. You wrote both the code and the justification, so you are not a neutral reader
of either; a reviewer who has seen your reasoning inherits your blind spots along with it.

**One agent, not a fleet.** A single reviewer with a sharp prompt outperforms three with vague ones,
and three vague ones cost three times as much to produce overlapping style notes. If you are tempted
to fan out by "lens" — correctness, then idiom, then docs — write those as targets in one prompt
instead. Reach for a second agent only when the first returns something you cannot verify yourself.

What makes it worth the tokens rather than a ritual:

- **Give it the diff, the branch, and the claim** — "this change claims X; verify X" — and tell it
  to run things rather than reason about them. Findings that cite a command and its output are the
  only ones worth acting on.
- **Name what to attack**: the coverage claims, the measurements, the failure modes, what the change
  is silent about. A reviewer with no target defaults to style.
- **Tell it that finding nothing is a valid answer**, so it does not manufacture findings to look
  useful — and that restating a limitation you already documented is worthless.
- **Verify every finding yourself before acting on it.** Subagents are confidently wrong often
  enough that an unverified finding is a rumour — and run the check in a scratch directory outside
  this repo, because this repo's own config silently changes the answer for anything involving
  presets or overrides.
- **Adopt or refute each finding explicitly** where you record the change. A finding you decided
  against is more useful to the next reader than one you quietly dropped.

Not enforceable by CI — nothing can observe whether you asked. It is a convention, and the reason to
keep it is that it earns its cost: on the change that introduced this paragraph it found a diagnostic
that reported a broken rule set as healthy, a flag that hung the process with no output, and three
doc summaries re-stamped without their prose being updated — the one convention below that the same
change had broken.

**One logical concern per PR, based on the right parent branch.** If work B genuinely
depends on work A landing first, branch B off A's branch, not off `main` — don't let a
dependent change get PR'd against a `main` that doesn't have the prerequisite yet. Small,
focused PRs are also what makes the rest of this section practical: a full verify pass
and a dogfooding pass are fast and legible on one concern, and slow and easy to skim past
on five.

**A changeset for every user-facing change** (see "Release convention" above) — and write
its summary for someone who will never read the PR description: what changed, and whether
it can flip a previously-passing repo to failing (a new check getting stricter is a real,
sharp-edged behaviour change, not just a bugfix, even though it "only" makes the tool more
correct).
