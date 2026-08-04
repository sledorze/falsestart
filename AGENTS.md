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

## Commands

- `pnpm check` — check summaries + links + **reference drift** (exit 1 on any problem).
  `--refs` is what makes a doc's claim about a source file re-checkable: every `[text](../src/x.ts)`
  link has its target's content hashed, and a later run fails when that content has changed. Without
  it cairn verifies only that the PATH resolves — `src/checking/scope.ts` could be replaced wholesale
  with `export const appliesTo = () => true` and the check would stay green.
- `cairn check --summaries-only` / `--links-only`.
- `cairn check --links-only --fix` — auto-repair unambiguous dead links.
- `pnpm stamp` — write the `.cairn/` sidecar hashes of EXISTING summaries bottom-up, and of every
  source file the docs link to. It does **not** author prose; you write the content, then stamp.
  Re-stamping after a source change is the point, not a chore: it is where you say the doc's claim
  about that file is still true.
- `cairn check --prune` — delete orphan summaries and orphan `.cairn/` sidecars
  (source doc deleted, renamed, or below threshold).
- `--prose-refs` — checks bare-backtick file citations in prose (`` `src/x.ts` ``, with no
  `[text](path)` syntax), which read as documentation but are invisible to a link checker. On in
  `pnpm check`. It found a changeset citing a rule path months after the rule moved. As of cairn
  0.7 its help text says "safe for permanent use" rather than calling it a migration aid.
- `--report-deletions` — informational, never affects the exit code: names what a deleted document
  took with it (its outbound references and headings) when nothing else in the tree carries them.
  On in `pnpm check`, comparing against the working tree; pass `--deletions-since <ref>` to check
  deletions already committed on a branch. This exists because a lossy dedup here removed the only
  description of `--refs`, `--prose-refs` and `checks.coverage`, and every check stayed green.
- `checks.coverage` — **config only, absent from `--help`**, so you will not find it by asking the
  tool. Declares document _kinds_ by path glob and _rules_ between them ("every explanation doc must
  link to a reference doc"), then reports the ones missing. It is the check that would notice a
  missing Diátaxis quadrant. Not enabled here: with four documents the rules would be asserted both
  in `.cairnrc.json` and in the docs themselves. Revisit if the doc set grows.

`CHANGELOG.md` is excluded in `.cairnrc.json`, and the reason generalises: the convention is for
docs a person AUTHORS. The changelog is generated by `changeset version`, so a summary of it would
be a hand-written digest of machine-written text, stale at every release and re-stamped by reflex —
the exact failure this convention exists to prevent. Without the exclusion the release itself fails,
since `release.yml` runs `pnpm verify` before publishing and the generated file arrives with no
summary. Anything a person writes is still covered: verified by dropping a forty-line authored
document into `docs/` and watching the check demand a summary for it.

You author the prose. The tool only verifies and stamps — and it never touches your prose to do it.

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
`pnpm lint && pnpm format:check && pnpm typecheck && pnpm coverage:ci && pnpm build && pnpm check`
(`pnpm verify` runs all six — `format:check` is in there because CI enforces it, and a verify that
omits a gate CI applies is a verify that can be green while the merge is red).

That rule used to be broken by `verify` itself: it ran `pnpm test`, while CI and `pre-push` both run
`pnpm coverage:ci`, whose 100% thresholds `pnpm test` does not apply. A change with uncovered
branches therefore passed a full local `verify` and was rejected at push — observed, not theorised.
`coverage:ci` runs the same tests, so nothing is lost by using the stricter one.

`lefthook.yml`'s hooks already automate most of this — `pre-commit` runs
lint/format+docs, `pre-push` runs typecheck+test+build+docs+coverage+mutation — but that's not a reason
to treat it as covered: hooks are skippable (`git ... --no-verify`), and no hook can
construct the actual scenario a feature is meant to catch for you (see "Dogfood," next).
Treat the hooks as the backstop, not the practice.

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
