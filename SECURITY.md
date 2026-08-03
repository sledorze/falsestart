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
- `--rules pkg:<name>` loads rule documents from an installed package. Those are data, not code, but
  they decide what is blocked.
- It judges the text a write tool carries. A shell redirect or heredoc writes a file it never sees —
  see `docs/reference.md`. It is a guard rail, not a sandbox.
