---
'@sledorze/falsestart': patch
---

Setup instructions that actually work, and `docs/` now ships with the package.

An AI agent asked to "set up falsestart" was given the README and could not get a working guard from
it. Four separate problems, each of which fails by looking like success:

- **The settings snippet was not valid JSON.** It was fenced ` ```jsonc ` with a header comment and
  trailing commas. Pasted into `.claude/settings.json`, that file no longer parses — which discards
  every hook and permission rule in it, not just falsestart's. Now strict JSON, and a test parses
  every `json` block in the README and the hook guide so it cannot regress.
- **`"command": "falsestart --preset all"` never resolved.** `node_modules/.bin` is not on `PATH`
  for a hook command, so a bare name exits 127; Claude Code treats that as a non-blocking error, the
  write proceeds, and the hook still shows as registered. The docs now invoke it by path.
- **`--preset all` was the only example shown.** It is both rule sets, and the `effect` set forbids
  `await`, `try/catch`, `new Promise`, `.then`, `JSON.parse` and `process.env` — seven blocks on one
  ordinary async function. Correct in an Effect repo, wrong everywhere else. The examples now use
  `clean-code` and the trade-off is stated where the choice is made.
- **The matcher omitted `NotebookEdit`**, while the same guide explains how to scope a rule to
  `**/*.ipynb` — an instruction that could never take effect.

Two documentation defects fixed alongside:

- **`docs/` was not published** (`files: ["dist", "rules"]`), so the README's three doc links were
  dead in the tarball and an npm consumer's entire documentation was the README. `docs` is now in
  `files`; the exit-code contract, `pkg:` semantics and the whole config system ship with it.
- **Two docs contradicted each other on where the config goes** — "beside the rules directory" versus
  "beside the project". Neither was right: it is the process's working directory, with no upward
  search. Following the first put the file where falsestart never looks, and the override was
  silently ignored.

Also now stated: every shipped rule matches `**/*.{ts,tsx}` only, so a repo written in `.mts`,
`.cts` or `.js` needs its own `files` globs or the guard is installed and inert.

No behaviour change — the code is untouched apart from `files` in `package.json`.
