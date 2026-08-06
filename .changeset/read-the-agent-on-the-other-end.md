---
'@sledorze/falsestart': minor
---

`--agent copilot`: read GitHub Copilot CLI's payload, and answer where it looks

falsestart's wire contract was Claude Code's, in and out. Under Copilot that was not merely
unenforced — it **denied every tool call in the session**, `bash`, `view` and `grep` included,
because Copilot treats any non-zero exit other than 2 as `Denied by preToolUse hook (hook errored)`
and falsestart's fail-open report is exit 1. `--agent copilot` is the whole setup:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "type": "command", "command": "npx falsestart --preset all --agent copilot --fail closed" }]
  }
}
```

**Can a previously-passing setup change behaviour? Almost nowhere.** `--agent` defaults to
`claude-code`; every parse path, emit path and exit code without the flag is what it was. Three
report texts change unconditionally, all of them diagnostics rather than decisions:

- `--doctor` prints an `agent` line on every run. Stated because the previous release's changeset
  made the opposite promise about `--doctor`; the reason is that the person asking "why did my deny
  not block" is by definition the one who never passed `--agent`.
- `--doctor`'s `tools` line now names each tool's field names —
  `Write (file_path/content)` rather than `Write`.
- A payload carrying a write tool without the fields to judge now names the keys it DID carry:
  `Write carried no content/file_path to judge (tool_input carried: content)`. Under Copilot that
  clause is what makes a wrong field-name inference diagnosable rather than mysterious; it is
  unconditional because the diagnostic is worth the same on both contracts.

**What `--agent copilot` changes.** falsestart reads `toolName`/`toolArgs` **and** the VS Code
compatible `tool_name`/`tool_input` — the casing of the event name in your Copilot hook config
decides which you get, and falsestart reads both — including `toolArgs` delivered as a JSON-encoded
string. It judges Copilot's `create` and `edit`. A deny is **exit 2**, with Copilot's own top-level
deny document on stdout and the reason on stderr; the keys are top-level rather than under
`hookSpecificOutput`, which Copilot ignores. **There is no exit 1**: a reported guard failure, a
malformed payload and a refused command line all exit 0, because every other non-zero exit denies
there. A `severity: warning` finding reaches the user and the log but **not the model** — Copilot's
hook output has three keys and none is non-deciding, so advice goes to stderr and decides nothing.
`--fail closed` is recommended under Copilot for the same reason.

**`--agent copilot` ships PROVISIONAL.** GitHub documents Copilot's tool NAMES and nowhere documents
its tool ARGUMENTS, so `edit`'s `path`/`new_str` and `create`'s `path`/`content` are inferred, and
the reference does not say whether stderr is readable at exit 0 at all. Run
`falsestart --doctor --agent copilot`: it prints the names it will read, with a `PROVISIONAL` note.
Compare them against one real hook payload and please report a mismatch — each correction is one
literal and one table row. If a name is wrong that tool is unjudged at write time, and
`falsestart scan` in a git hook or CI is the backstop, exactly as it is for a `Bash` heredoc.

**Setting the flag wrong is caught.** A payload naming a tool from the other contract's declared,
closed table is reported rather than deferred, on the channel the runtime that really sent it reads —
"this payload names the tool Write, which belongs to the claude-code contract, but --agent copilot
was given". Without that, `--agent copilot` in front of Claude Code would be exit 0 and silence —
unguarded indefinitely, looking healthy the whole time.

**One trade, stated.** A refused hook command line naming any `--agent` value other than
`claude-code` exits **0** rather than 1, including a misspelled one: under Copilot exit 1 denies, so
refusing `--agent copilto --bogus` at exit 1 would be a repository-wide outage rather than a message.
`falsestart --agent copilot --bogus; echo $?` therefore prints 0. The message is still on stderr, and
`--doctor` is the answer, as it already is for `--list-rules`.

New exports `AGENTS` and `AGENT_CONTRACTS`, and types `AgentId`, `AgentContract`, `Envelope`. New
optional `RespondOptions.agent`, `DiagnoseOptions.agent`, `DecideOptions.agent`, and an optional
second parameter on `judgesPayload` — all optional, so no consumer's `tsc` turns red. `scan` and
`--list-rules` **refuse** `--agent` in either value; no command line that parsed yesterday contains
it.
