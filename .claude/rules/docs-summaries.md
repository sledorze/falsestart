---
paths:
  - 'docs/**'
---

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

## Upgrading from an older cairn (legacy `<!-- source-sha256 -->` stamp)

**Nothing special to do — do not go looking for a migration step.** If a summary still
carries the old in-content `<!-- source-sha256: ... -->` comment, the ordinary stamp
command (`npx cairn check --summaries-only --stamp`) strips it and writes the
`.cairn/` sidecar in the same run, automatically. There is no separate command to
discover or remember: whatever `stampCommand` this repo already runs already does it.
(`--migrate-stamps` also exists, purely as an optional explicit/reportable alias for
the same self-healing behaviour — never required.)

## Workflow when you edit docs

When you create or edit any doc:

1. If the doc is longer than the threshold, create or update its `X.summary.md` to
   reflect the new content.
2. Update the `_SUMMARY.md` of every affected directory, walking **up** the tree
   leaves-first, and keep a link to every child file and sub-directory.
3. Run the stamp command to (re)write the sidecar hashes under `.cairn/` bottom-up:
   `npx cairn check --summaries-only --stamp`.
4. Run `npx cairn check` and ensure it exits 0 (green) before you finish.
5. Commit your doc changes **together with** the `.cairn/` sidecar changes — a doc
   edit without its matching sidecar update is exactly what `check` is designed to catch.

## Commands

- `npx cairn check` — check summaries + links (exit 1 on any problem).
- `npx cairn check --summaries-only` / `--links-only`.
- `npx cairn check --links-only --fix` — auto-repair unambiguous dead links.
- `npx cairn check --summaries-only --stamp` — write the `.cairn/` sidecar hash of
  EXISTING summaries bottom-up. It does **not** author prose; you write the content,
  then stamp.
- `npx cairn check --prune` — delete orphan summaries and orphan `.cairn/` sidecars
  (source doc deleted, renamed, or below threshold).
- `npx cairn check --migrate-stamps` — optional: the same self-healing `--stamp`
  already does for a legacy in-content stamp, as its own named/reported step. Never
  required.

## Other opt-in checks (all off by default — see the README for full details)

- `--refs` (with `--stamp`) — tracks the _content_ of what a link points to, not
  just whether it resolves: `--refs --stamp` records a hash of every reference
  target; a later `--refs` run reports any that changed since.
- `--prose-refs` — migration aid: flags a bare-backtick file citation in prose
  (e.g. a citation with no `[text](path)` syntax) whose target has moved or been
  deleted. Silent for anything that still resolves.
- `checks.coverage` (config only, no CLI flag) — for docs beyond code reference
  (PRDs, specs, decision logs): declares doc **kinds** by path glob and **rules**
  ("every `feature` doc must link to a `decision` doc"), then reports missing
  links and orphaned docs. Catches something the checks above can't: a repo can have
  zero broken links and still have unrelated feature/decision docs that were never
  actually connected. Worth checking for if you're asked to organize product
  knowledge, not just code docs.

You author the prose. The tool only verifies and stamps — and it never touches your prose to do it.
