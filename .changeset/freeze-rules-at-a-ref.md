---
'@sledorze/falsestart': minor
---

Read rule documents and the config from a git ref instead of the working tree.

An agent session that can write files could disarm its own guard: edit a rule's `files:` glob, add a
scope override to `falsestart.config.json`, add a second config file so the load fails, or corrupt a
rule document so the load fails. All four end in exit 0 or a fail-open exit 1, byte-identical to a
write that broke no rule. Rules and config are now resolved from `HEAD` by default, so weakening a
guard takes a change to what the ref denotes rather than an uncommitted edit.

**A previously-passing setup can change behaviour.** Uncommitted rule edits and uncommitted config
files stop taking effect: if you were relying on an uncommitted `falsestart.config.json`, or you edit
rules without committing them, the guard runs the committed version and your change is ignored until
you commit it. `falsestart --doctor` prints what is frozen and lists every working-tree change that
is not in effect. `--freeze off` restores the old behaviour.

**A previously-passing setup can also start failing, and the hook now denies writes where it used to
allow them.** These all deny rather than falling back to the working tree:

- a committed rule tree that does not load, or a committed config that does not parse or import —
  previously exit 1 with the write proceeding;
- a `.js`/`.mjs` config that imports a package or a relative file. Under the freeze every config
  format is imported from a `data:` URL built from the committed bytes, so the restrictions already
  documented for `.ts` configs now apply to `.js`/`.mjs` as well, including `makeConfigUnsafe`;
- a `--config` path the ref does not hold;
- a rule document committed as a symlink, which cannot be frozen as a regular file;
- a rules **directory** that is a symlink on disk pointing somewhere other than the path the command
  line named. falsestart freezes the path it was given; if your `--rules` path is a symlink, point it
  at the real directory or pass `--freeze off`;
- `HEAD` not resolving in a repository that has refs.

A rules directory that has been **deleted** from the working tree no longer stops the guard: the
rules come from the ref, so the committed set still applies. That is a behaviour change in the safe
direction, and it is the reason `--freeze require` can now honestly claim to refuse what it cannot
verify.

Where there is nothing to freeze, nothing changes and nothing fails: a project that is not a git
repository, a repository with no commit yet, a rules directory outside the project repository or in a
submodule, and `--preset` / `--rules pkg:` trees inside `node_modules` all keep reading the working
tree, and `--doctor` says which and why. `--freeze require` turns those into refusals for
repositories that want them to be, and additionally refuses where no enclosing directory has a `.git`
**directory** — a linked worktree outside its main repository, or `--separate-git-dir` — because a
single write repoints such a repository. Under `--freeze auto` those keep working and `--doctor`
prints an `anchor UNVERIFIED` line instead. `--freeze-ref <ref>` freezes against something other than
`HEAD`; `refs/remotes/*` is not touched by `reset`, `amend` or `checkout`, so `origin/main` is the
setting a routine git operation cannot weaken.

What this buys is smaller than "a weakened rule now needs a reviewed commit", and `SECURITY.md` says
so: falsestart cannot defend against an agent that can rewrite the things which say where its rules
come from. Disarming used to mean editing a rule; it now means editing whatever decides which
repository and which commit are authoritative.

Cost: about 4% of a judged write, at 23 and at 168 rules — four fixed `git` spawns, not one per
document. A tool call falsestart does not judge never spawns git at all.
