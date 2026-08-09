---
'@sledorze/falsestart': minor
---

Registered at another hook event, falsestart says so instead of emitting a document that is ignored

falsestart is a `PreToolUse` guard. Registered at `PostToolUse` — a reasonable thing to try — it
judged the payload as though it were a `PreToolUse` one and answered with

```json
{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "…": "…" } }
```

naming an event that is not the one that invoked it and carrying `permissionDecision`, a field
`PostToolUse` does not define. Claude Code ignores it. Nothing errored, nothing warned, and the hook
showed as registered — a guard that is installed, wired and inert, which is the exact failure shape
this tool exists to prevent.

Both runtimes name the event in the payload (`hook_event_name` — Claude Code on every payload,
GitHub Copilot CLI on the VS Code compatible spelling a PascalCase hook config selects), so
falsestart now reads which event it was invoked for instead of assuming, and refuses:

```
falsestart: this hook was invoked for `PostToolUse`, and falsestart only implements `PreToolUse` — nothing was judged. A decision emitted here would name the wrong event and be ignored. Register falsestart on PreToolUse, or run `falsestart scan` for after-the-write reporting.
```

**Can a previously-passing setup change behaviour? Only one that was already not working.** A
payload naming `PreToolUse`, and a payload naming no event at all, are judged exactly as they were —
absence is not a claim, and every library caller and fixture that omits the field is untouched.
What changes is a registration at some other event, which was never being guarded:

- **Claude Code:** exit `1` with the line above on stderr, where it used to be exit `0` with the
  ignored document. Exit 1 is a non-blocking error notice — the write still proceeds — and it is the
  row `PostToolUse` itself is stuck with, since exit 2 there feeds stderr to the model as a finding
  about code nothing judged.
- **`--agent copilot`:** exit `0` with the line on stderr, and **never** exit 1. A violating write at
  `PostToolUse` used to exit `2` — a deny, of a tool call the runtime had already run — in **both**
  `--fail` policies, because the deny came from the rule rather than from the policy. It no longer
  denies in either. Exit 0 is the declared contract's price list rather than an inference from the
  payload: GitHub's fail-closed rule is `preToolUse`-specific, but falsestart never reads an exit
  code off an event name, and a shim in front of a hook registered at `preToolUse` could send any
  event name it liked — there an exit 1 would deny every tool call in the repository.
- **A misdeclared `--agent` still outranks all of this.** A payload naming a tool from the other
  contract's table is answered `Set --agent claude-code` on that runtime's channel at exit 1,
  whatever event it names — a tool name is proof of who is on the other end and `hook_event_name` is
  not, so the misdeclaration is the only one of the two that can be read where it lands.
- A tool call falsestart would have deferred anyway (`Bash`, `view`, `grep`) stays silent at every
  event, and the refusal is answered before the rules source, the freeze and the rule tree are
  touched, so it costs what a deferred call costs.
- Copilot's camelCase payload carries no event field at all, so a hook registered as `postToolUse`
  in that spelling cannot be detected and is judged as before.

**`PostToolUse` is not implemented, and will not be in this shape.** Once the tool has run neither
runtime can block — Claude Code's exit-2 row reads "No | Shows stderr to Claude; the tool already
ran", and Copilot's `postToolUse` is fail-open — so `Deny` and `Advise` collapse into one emission
and the `severity` of every rule stops meaning anything. That is `falsestart scan`, which already
does it: register `falsestart scan` as your `PostToolUse` command for after-the-write reporting.

No API change. `EVENT_KEY` and `IMPLEMENTED_EVENT` are internal to the hook area; `IMPLEMENTED_EVENT`
is also what the deny document names, so the event falsestart implements and the event it claims in
its answer can no longer drift apart.
