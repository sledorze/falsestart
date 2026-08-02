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
   `pnpm stamp` (`cairn check --summaries-only --refs --stamp`).
4. Run `pnpm check` and ensure it exits 0 (green) before you finish.
5. Commit your doc changes **together with** the `.cairn/` sidecar changes — a doc
   edit without its matching sidecar update is exactly what `check` is designed to catch.

## Commands

- `pnpm check` — check summaries + links + **reference drift** (exit 1 on any problem).
  `--refs` is what makes a doc's claim about a source file re-checkable: every `[text](../src/x.ts)`
  link has its target's content hashed, and a later run fails when that content has changed. Without
  it cairn verifies only that the PATH resolves — `src/core/scope.ts` could be replaced wholesale
  with `export const appliesTo = () => true` and the check would stay green.
- `cairn check --summaries-only` / `--links-only`.
- `cairn check --links-only --fix` — auto-repair unambiguous dead links.
- `pnpm stamp` — write the `.cairn/` sidecar hashes of EXISTING summaries bottom-up, and of every
  source file the docs link to. It does **not** author prose; you write the content, then stamp.
  Re-stamping after a source change is the point, not a chore: it is where you say the doc's claim
  about that file is still true.
- `cairn check --prune` — delete orphan summaries and orphan `.cairn/` sidecars
  (source doc deleted, renamed, or below threshold).

You author the prose. The tool only verifies and stamps — and it never touches your prose to do it.

# Release convention

Releases are automated via [Changesets](https://github.com/changesets/changesets) (see
`.github/workflows/release.yml`) — merging to `main` with unconsumed `.changeset/*.md`
files opens a "Version Packages" PR (bumped `package.json`, generated `CHANGELOG.md`);
merging that PR publishes to npm, pushes the git tag, and creates a GitHub Release.

**Currently deactivated**: the release job is gated on the `releases-enabled` repository
variable, unset by default, and the package itself is `"private": true`. Nothing publishes
until that variable and an `NPM_TOKEN` secret are deliberately configured.

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
`pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm check` (`pnpm verify` runs
all five). `lefthook.yml`'s hooks already automate most of this — `pre-commit` runs
lint/format, `pre-push` runs typecheck+test+build+coverage+docs — but that's not a reason
to treat it as covered: hooks are skippable (`git ... --no-verify`), and no hook can
construct the actual scenario a feature is meant to catch for you (see "Dogfood," next).
Treat the hooks as the backstop, not the practice.

**Dogfood the actual CLI/behavior against a real scenario before calling a feature
done — unit tests that pass are necessary, not sufficient.** Run the real build and
exercise it for real, including the negative case: construct the exact scenario the
feature is meant to catch, confirm it's reported/blocked, then revert and confirm it's
clean again.

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
either), get an independent read — a fresh subagent with no context beyond "verify this
claim," not a re-read of your own reasoning.

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
