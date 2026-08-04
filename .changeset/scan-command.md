---
'@sledorze/falsestart': minor
---

New `falsestart scan [paths…]` command, so violations are caught at pre-commit, pre-push or in CI —
not only at write time.

The hook judges a _tool call_. It sees `Edit`, `Write` and `NotebookEdit` and nothing else, so a
`Bash` heredoc, a `>` redirect, `git checkout`, `git merge`, `git revert`, a person in an editor,
another agent, and every file that predates the hook being installed all reach disk unexamined.
`scan` is the second enforcement point that closes it.

```yaml
# lefthook.yml
pre-push:
  commands:
    falsestart:
      run: node node_modules/@sledorze/falsestart/dist/cli.js scan --preset all {push_files}
```

```sh
# .husky/pre-commit
git diff --cached --name-only --diff-filter=ACM -z |
  node node_modules/@sledorze/falsestart/dist/cli.js scan --preset all -0
```

Use `-z`/`-0` rather than newlines: `git diff --name-only` C-quotes any non-ASCII path, which then
opens as ENOENT and is silently skipped by the gate meant to check it.

**Dependencies are never judged.** `node_modules` and `.git` are always excluded, and anything
`.gitignore` covers is excluded too — asked of `git check-ignore` rather than reimplemented, and
best-effort so a scan still works without git. Anything else belongs in `falsestart.config.ts` as a top-level `exclude` array — the repository's
standing policy, stated once instead of repeated in `lefthook.yml`, a husky script and CI, where
the copies drift. `--exclude <glob>` adds to it for a single run rather than replacing it. `dist/`,
`build/` and `vendor/` are deliberately not default exclusions, because projects author real source
in directories with those names. Every exclusion is counted in the summary.

**Paths come from the caller, never discovered.** Your hook runner already computes the list and
does it better. One thing worth knowing: `{push_files}` is the whole tree on a branch's _first_
push, because there is no upstream to diff against.

**Exit codes are `scan`'s own contract:** `0` clean, `1` findings, `2` could not run. The hook's are
unchanged. `1` and `2` are distinct because a gate that cannot tell "your code has violations" from
"the linter is broken" teaches people to reach for `--no-verify`. It also inverts the hook's policy
on purpose: the hook fails **open**, since a broken rule must not hold every write in the repo
hostage, while a scan is a gate and fails **closed**, since one that cannot run passes everything
while looking healthy.

**It is stricter than the hook.** An `Edit` carries only the text it would introduce, so the hook
judges what a change adds; a scan parses whole files. Measured over 424 files of real hand-written
TypeScript, 64% already carry at least one finding. So `--baseline <file>` and `--update-baseline`
ship with it — accept what is already there once, and only new findings fail afterwards. The
baseline holds fingerprints rather than line numbers, so a finding that moves is still the same
finding and reformatting does not churn the file.

Every run ends with `scanned N file(s), M in scope, K finding(s)`. `M` matters: a bare "no findings"
is printed by a genuinely clean run, by one whose paths matched no rule, by one given no paths, and
by `scan` mis-wired as the `PreToolUse` command — where exit 0 with non-JSON on stdout reads as
"allow" and silently permits every write. When `M` is `0` the report says so outright.

Also fixes a latent bug this surfaced: `Exit` carried an exit code that nothing read, so every
non-zero exit was `1` regardless. Invisible while every exit was 1; it would have made the code
above decorative.
