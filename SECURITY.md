# Security

## Reporting a vulnerability

Report privately through GitHub's
[security advisories](https://github.com/sledorze/falsestart/security/advisories/new). Please do not
open a public issue for anything exploitable.

## What this tool does with your code

Worth knowing before you trust it:

- It reads the content a tool call is about to write and matches it against ast-grep rules. It never
  writes to your files.
- It imports your `falsestart.config.{ts,mts,js,mjs}` to read it, which **executes that file**. A
  config is code; treat one you did not write as you would any other dependency.
- With the freeze on (the default) the bytes that execute are the bytes committed at the ref, for
  every config format — they are imported from a `data:` URL built from the committed content, and
  the file on disk is never opened. That is a claim about _which bytes execute_, and nothing more: a
  committed config is free to shell out and read the working tree while it computes a rule's scope,
  which is a documented capability.
- `--rules pkg:<name>` loads rule documents from an installed package. Those are data, not code, but
  they decide what is blocked.
- It judges the text a write tool carries. A shell redirect or heredoc writes a file it never sees —
  see `docs/reference.md`. It is a guard rail, not a sandbox.

## Rules and config are read from a git ref, not from the working tree

By default falsestart resolves its rule documents and its config from `HEAD` (`--freeze-ref` selects
another ref). Editing a rule document in your working tree, adding a config file the repository never
committed, deleting one, and corrupting one all stop changing what is enforced. `falsestart --doctor`
prints what is frozen and lists every working-tree change that is not in effect. `--freeze off`
restores reading the working tree; `--freeze require` refuses to judge at all where there is anything
it cannot verify.

Where there is nothing to freeze, falsestart reads the working tree and says so in `--doctor`: a
project that is not a git repository, a repository with no commit yet, a rules directory outside the
project repository or in a submodule, and rule trees git does not track — which includes `--preset`
and `--rules pkg:`, since those live in `node_modules`. Rules loaded from a package are therefore
**not** protected by this: an agent can write into `node_modules`, and there is no committed version
to compare against. Pin the package version and rely on your lockfile.

### What this actually buys, stated smaller than it is tempting to state it

**falsestart cannot defend against an agent that can rewrite the things which say where its rules
come from.** What the freeze changes is the cost. Disarming used to mean editing a rule; it now means
editing whatever decides which repository and which commit are authoritative. That is a real
improvement and a smaller claim than "it takes a reviewed commit", which is not true. Four things
still do it:

- **Committing.** An agent that can run `git commit` can commit a weakened rule and then write the
  file it guarded. What changes is that the weakening is in a diff a human reviews rather than in an
  uncommitted edit nobody sees.
- **Moving the ref.** `git reset --soft HEAD~1` drops whatever the last commit added while leaving
  the index and working tree untouched, and `git symbolic-ref HEAD …` repoints HEAD entirely. The
  first is indistinguishable from checking out an older commit and is not detected. The second is
  detected only until it is paired with `git update-ref -d`, which empties the signal falsestart uses
  to tell a tampered repository from a fresh one — **no check inside `.git` survives an agent that
  can write inside `.git`**, so this raises the cost of that escape by one command rather than
  closing it. `--freeze-ref origin/main` is the better answer: not because moving it needs a push (it
  does not — a remote-tracking ref is an ordinary local ref), but because `refs/remotes/*` is
  untouched by `reset`, `amend` and `checkout`, so moving one is a deliberate act no ordinary
  workflow performs, and `git fetch` restores it.
- **Repointing the repository, where `.git` is a file.** git honours a `.git` file containing
  `gitdir: <path>`. In a normal repository `.git` is a directory and a write tool cannot replace it,
  and falsestart resolves the repository by walking outward until it finds such a directory — so a
  planted `.git` anywhere below a real repository root is stepped over. What remains is a repository
  with **no** enclosing `.git` directory at all: a linked worktree outside its main repository, or
  one created with `--separate-git-dir`. There, replacing one file substitutes the entire object
  database while the repository's top-level path does not change, and the rules falsestart reads
  become the attacker's. `--freeze-ref` does not help, because the ref is then resolved in the
  substituted repository. falsestart detects the _condition_ rather than the attack: `--doctor`
  prints an `anchor UNVERIFIED` line and `--freeze require` refuses to judge at all. Under
  `--freeze auto` that report is the whole defence.
- **Editing the hook's own command line.** An agent that can edit `.claude/settings.json` can remove
  falsestart altogether. That is why `--freeze` is a command-line flag and is deliberately not
  readable from `falsestart.config.*`: the switch must not live inside the thing being frozen.

falsestart is a guard rail, not a sandbox.
