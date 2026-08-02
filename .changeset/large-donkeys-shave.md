---
'@sledorze/falsestart': minor
---

falsestart can now block code as it is written.

The `falsestart` executable reads a PreToolUse hook payload on stdin and answers with a decision,
so a rule violation is caught at the moment an agent writes it rather than at CI. Point it at a
directory of ast-grep rule documents:

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "falsestart --rules .falsestart/rules" }],
      },
    ],
  },
}
```

**This can flip a previously-passing setup to blocking.** Once the hook is registered, any `Write`
or `Edit` whose content matches an `error`-severity rule is denied outright. Findings below `error`
severity never block. Rules apply only where their own `files`/`ignores` globs admit the path, so
scope is the control for how much a rule can reach.

Two failure modes are deliberately non-blocking and show up as an error notice instead: a rule tree
that cannot be loaded (malformed document, duplicate rule id, missing directory), and a rule that
cannot be run. These surface loudly but let the write proceed, so a typo in a rule file cannot hold
a repository hostage.

An `Edit` is judged by the text it introduces, not by the resulting file, which the hook never
sees — an edit is checked for what it adds, not for what it leaves behind elsewhere.
