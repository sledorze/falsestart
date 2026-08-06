# Overview

falsestart blocks risky code patterns the instant an AI writes them — before the file
lands, not just at CI. It can also enforce structure/architecture conventions.

It runs as a `PreToolUse` hook for Claude Code or, with `--agent copilot`, for GitHub Copilot CLI:
the tool call arrives on stdin, and falsestart answers with a decision. Code that breaks a rule never
reaches the file.

Rules are [ast-grep](https://ast-grep.github.io) documents, so the same file stays readable by the
upstream CLI. A rule only ever acts on files its own `files`/`ignores` globs admit — matching
content is never on its own a reason to touch a file.

See [Using the hook](./using-the-hook.md) to set it up, and [Architecture](./architecture.md) for
how the pieces fit.
