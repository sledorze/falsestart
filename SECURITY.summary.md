# Security — summary

**Reporting.** Privately, through GitHub security advisories. Never a public issue for anything
exploitable.

**What the tool executes.** It reads the content a tool call is about to write and matches it against
ast-grep rules; it never writes to your files. It **imports** your `falsestart.config.*`, so a config
is code — with the freeze on, the bytes that execute are the ones committed at the ref, imported from
a `data:` URL, and the file on disk is never opened. That is a claim about which bytes execute and
nothing more. `--rules pkg:` loads rule documents from an installed package: data, but they decide
what is blocked. It judges the text a write tool carries, so a heredoc or shell redirect writes a file
it never sees.

**The freeze.** Rules and config resolve from `HEAD` by default (`--freeze-ref` selects another).
Editing a rule in the working tree, adding a config the repository never committed, deleting one and
corrupting one all stop changing what is enforced. Where there is nothing to freeze — no repository,
no commit, an untracked or out-of-repository rules tree, a submodule, and anything under
`node_modules` including `--preset` and `pkg:` — the working tree is read and `--doctor` says so.
Package rule sets are therefore not protected; pin the version and rely on the lockfile.

**The boundary, stated smaller than it is tempting to state it.** falsestart cannot defend against an
agent that can rewrite the things which say where its rules come from. Four escapes remain: committing
a weakened rule (now visible in a diff); moving the ref (`reset --soft` is undetectable,
`symbolic-ref` costs one extra command — `refs/remotes/*` resists both because no ordinary workflow
touches it); repointing the repository where `.git` is a **file**, which survives only where no
enclosing `.git` **directory** exists — a linked worktree outside its main repository, or
`--separate-git-dir` — and which `--doctor` reports and `--freeze require` refuses; and editing
`.claude/settings.json`, which is why `--freeze` is a flag and not a config key.

A guard rail, not a sandbox.
