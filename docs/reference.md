# Reference

Every flag, export and shipped rule. For why any of it is shaped this way see
[Why falsestart is built this way](./architecture.md); to set it up see
[Using the hook](./using-the-hook.md).

## Command line

| Flag                 | Meaning                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--preset <name>`    | Use rules shipped with falsestart: `all`, `clean-code`, `effect`. Refused alongside `--rules` in either of its forms, rather than ranked against it.                                                                                                                                                                                                            |
| `--rules <dir>`      | A directory of rule documents, searched recursively. Defaults to `.falsestart/rules`. Repeating this form keeps the last directory given.                                                                                                                                                                                                                       |
| `--rules pkg:<name>` | Rules from an installed package, e.g. `pkg:@acme/falsestart-rules`, optionally with a subdirectory. Given alongside the directory form it wins, in either order.                                                                                                                                                                                                |
| `--config <file>`    | Scope overrides. Defaults to `falsestart.config.{ts,mts,js,mjs,json}` in the process's working directory, without searching upward.                                                                                                                                                                                                                             |
| `--doctor`           | Report what falsestart resolved — including how many loaded rules block and how many advise — name the changelog shipped beside it, and prove the pipeline end to end. Names the active `--fail` policy when one was given, and reports a rules package it could not resolve rather than exiting silently. Reads no stdin; exits 1 if anything did not resolve. |
| `--list-rules`       | Print the resolved rule set as JSON on stdout and exit. Reads no stdin. Exits `0` with the document or `2` if it could not be produced; a refused hook command line still exits `1`. Refused with `scan`, `--doctor`, `--version` and `--warn-unscoped`.                                                                                                        |
| `--freeze <mode>`    | Where rules and config are read from: `auto` (the default), `off`, `require`. See [Freezing the rule set](#freezing-the-rule-set). Command line only — never read from `falsestart.config.*` or from the environment.                                                                                                                                           |
| `--freeze-ref <ref>` | Which ref to freeze against. Defaults to `HEAD`. A ref named here that does not resolve is an error in every mode.                                                                                                                                                                                                                                              |
| `--fail <policy>`    | What a failure of falsestart **itself** costs: `open` (the default) reports on stderr, exits `1`, and the write proceeds; `closed` denies it. See [When falsestart itself cannot run](#when-falsestart-itself-cannot-run). Command line only — never read from `falsestart.config.*` or from the environment. Refused with `scan` and `--list-rules`.           |
| `--agent <name>`     | Which agent runtime is on the other end: `claude-code` (the default), `copilot`. Decides both the payload shape falsestart reads and how a deny is expressed. See [Which agent is on the other end](#which-agent-is-on-the-other-end). Command line only. Refused with `scan` and `--list-rules`. `copilot` support is **provisional**.                         |
| `--warn-unscoped`    | Report a judged write that no rule is scoped to, instead of passing it in silence. Non-blocking, off by default, refused with `--doctor`.                                                                                                                                                                                                                       |
| `--version`          | Print the version. Exits 0 without reading stdin.                                                                                                                                                                                                                                                                                                               |
| `-h`, `--help`       | Usage. Exits 0 without reading stdin.                                                                                                                                                                                                                                                                                                                           |

One invocation loads exactly one rule source, and the two ways of naming a second one differ. A
preset and any `--rules` are refused together, so nothing is ranked. Between the two `--rules`
forms, the package form wins whichever was written first — `--rules pkg:@acme/rules --rules ./local`
and the reverse both load the package — so "the last one wins" is not the rule. Layering two rule
sets means two hook entries.

### `falsestart scan [paths…]`

Judges files already on disk, for a git hook or CI. A different contract from the hook in both
directions — paths in, a report out, and exit codes a shell can read.

| Flag                | Meaning                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------- |
| `paths…`            | Files to judge. Supplied by the caller; falsestart never discovers them.                                |
| `-` / `-0`          | Read paths from stdin, newline- or NUL-delimited. Use `-0` with `git … -z`.                             |
| `--baseline <file>` | Findings already accepted. Absent file means an empty baseline.                                         |
| `--update-baseline` | Write every current finding to `--baseline` and exit without failing.                                   |
| `--exclude <glob>`  | Leave these paths alone. Repeatable, and ADDED to any `exclude` in the config rather than replacing it. |

`--preset`, `--rules` and `--config` work as they do for the hook. `--warn-unscoped` is refused: the
scan report always states how many files were in scope.

#### Scan exit codes

| Code | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| `0`  | No findings.                                                        |
| `1`  | Findings. The commit or push should stop.                           |
| `2`  | falsestart could not run — broken rules, unreadable path, bad flag. |

`1` and `2` are distinct on purpose. A gate that cannot tell "your code has violations" from "the
linter is broken" is one that teaches people to reach for `--no-verify`.

This also inverts the hook's policy deliberately. The hook fails **open by default** — a rule that
cannot run must not hold every write in the repo hostage. A scan is a gate and fails **closed**: one
that cannot run has to stop, or it passes everything while looking healthy.
[`--fail closed`](#when-falsestart-itself-cannot-run) makes the two agree; a scan has no such flag
because it has no other setting to choose between.

### Freezing the rule set

By default falsestart resolves its rule documents and its config from a git ref rather than from the
working tree. An uncommitted edit to a rule, a config file the repository never committed, a deleted
config, and a corrupted rule document all stop changing what is enforced.

Every judged tool call resolves the freeze into one of three states, per source — rules and config
are classified **independently**, because `--preset` puts rules in `node_modules` where freezing is
meaningless while the project's own config is perfectly freezable.

| State      | What it means                                                            | `--freeze auto`                   | `--freeze require` |
| ---------- | ------------------------------------------------------------------------ | --------------------------------- | ------------------ |
| `Frozen`   | The ref holds these bytes, and they are what runs.                       | judge with them                   | same               |
| `Unfrozen` | There is nothing to freeze — no committed version of these bytes exists. | read the working tree, and say so | refuse to judge    |
| `Broken`   | A freeze that git established as possible did not complete.              | refuse to judge                   | same               |

`Unfrozen` is a stated policy rather than a failure, and `--doctor` names which case applies: the
project is not a git repository, the repository has no commit yet, the rules directory is outside the
project repository, git does not track it (which includes `--preset` and `--rules pkg:`, both inside
`node_modules`), it is a submodule, or the ref holds it as a symlink.

"It is not a git repository" is established by looking for a `.git` **directory** between the project
and the filesystem root, not by git declining to answer. git failing is not evidence that there is no
repository, and treating it as such made one file outside the repository enough to disarm the guard.

The submodule case is reported by name only when `--rules` names the submodule's own root, which is
where the gitlink sits. With `--rules ./vendor/rules` inside a submodule at `vendor/`, the ref simply
does not track that path and the reason is the more general "is not tracked at HEAD". Same verdict,
less specific message.

`Broken` needs positive prior evidence — a work tree, a ref that resolves or demonstrably does not in
a repository that has refs, a tracked tree with at least one document — and it **never falls back to
the working tree**, because a freeze that falls back on a git failure is one an agent defeats by
breaking git. It is reached by: a committed rule tree or config that will not load, a corrupt object
store, `HEAD` not resolving in a repository that has refs, a ref named with `--freeze-ref` that does
not resolve, a rule document committed as a symlink or a gitlink, and a rules directory that is a
symlink on disk pointing somewhere other than the path the command line named.

What `Broken` costs depends on who is asking: the hook denies the write (exit `0` with a deny
document whose reason names git's own error and `--freeze off`), `scan` and `--list-rules` exit `2`,
and `--doctor` reports `healthy: false` and exits `1`.

Reading the ref costs four `git` invocations, fixed and independent of the rule count: `rev-parse`,
one `cat-file --batch` carrying the ref probe and every config candidate, `ls-tree`, and one
`cat-file --batch` carrying the rule blobs. That is about 4% of a judged write at both 23 and 168
rules. A tool call falsestart does not judge never spawns git at all.

#### When the anchor cannot be verified

git honours a `.git` that is an ordinary one-line file containing `gitdir: <path>`, which a write
tool produces without a shell — and replacing it substitutes the entire object database while the
repository's top-level path does not change. falsestart therefore resolves the repository by walking
outward from the project until it finds a `.git` that is a real **directory**, which a write tool
cannot replace. A planted `.git` anywhere below a real repository root is stepped over.

Two legitimate setups have no enclosing `.git` directory at all: a linked worktree placed outside its
main repository, and a repository created with `git init --separate-git-dir`. There, `--freeze auto`
freezes as usual and `--doctor` prints an `anchor UNVERIFIED` line naming the condition;
`--freeze require` refuses to judge instead. A submodule's working tree resolves outward to its
superproject and is reported as a submodule rather than as an unverified anchor.

### When falsestart itself cannot run

`--fail <policy>` decides what a failure of the **guard** costs, as opposed to a finding about the
code. `open` is the default and is the 0.2.0 behaviour: the failure is reported on stderr, the
process exits `1`, and the write proceeds. `closed` denies the write instead, for a repository where
an edit that cannot be verified must not land.

Under `--agent claude-code`, the default:

| Failure                                                                              | `--fail open` (default) | `--fail closed`                                          |
| ------------------------------------------------------------------------------------ | ----------------------- | -------------------------------------------------------- |
| The rule tree will not load — unreadable directory, malformed document, duplicate id | report, exit `1`        | **deny**                                                 |
| `--rules pkg:<name>` will not resolve                                                | report, exit `1`        | **deny**                                                 |
| The config will not load, parse or import                                            | report, exit `1`        | **deny**                                                 |
| An override names a rule the loaded set does not contain                             | report, exit `1`        | **deny**                                                 |
| A rule cannot run at match time                                                      | report, exit `1`        | **deny**                                                 |
| The hook payload is malformed, or stdin is not JSON                                  | report, exit `1`        | report, exit `1` — never the reason to deny, but read on |
| The command line was refused                                                         | report, exit `1`        | report, exit `1`                                         |
| A frozen source could not be read                                                    | **already denies**      | already denies                                           |
| The rule tree loads and yields **zero** rules                                        | silent, exit `0`        | silent, exit `0`                                         |

**`--fail open` does not re-open a freeze refusal.** A source the ref established as freezable and
could not be read denies in either policy — that denial is about which bytes are authoritative, not
about the guard erroring, and its reason names `--freeze off` rather than `--fail open`.

With both switches in play the way out is two steps, and each denial prints the next one. A frozen
rule tree that will not load denies naming `--freeze off`; re-running with `--freeze off` reads the
same broken document from the working tree, so under `--fail closed` it denies again — this time for
the guard, naming `--fail open`. The reader converges after the second denial rather than the first.
The order is not interchangeable: `--freeze off` alone answers which bytes run, and `--fail open`
alone leaves the ref's broken bytes in force.

**A malformed hook payload is never the REASON falsestart denies.** It is not a fact about your
repository: the agent runtime sent a shape falsestart did not expect, and there is nothing in the
project to fix. An agent told "denied" would have exactly one move — rewriting code that was never
judged. It would also make availability depend on another product's release cadence, since the fields
falsestart reads are that product's, and a rename there would turn every write in every opted-in
repository into a denial.

That is a claim about the reason, not about the outcome, and the difference is reachable. falsestart
answers the failures above in order and discovers a malformed payload last, so a run whose rule tree
will not load denies that payload for the RULE TREE — naming it, and never mentioning the payload.
The freeze has always behaved this way: a committed rule tree that will not load denies every judged
tool call, malformed ones included, with no `--fail` involved. Both denials are actionable, because
both name something the repository owns. Where the payload is the only thing wrong, falsestart reports
it and the write proceeds — in either policy.

**It is a policy about failures, not a claim of coverage.** A rule set that loads and matches nothing
is not a failure, and `--fail closed` says nothing about it. Read `--doctor`'s scope block and
[`--warn-unscoped`](./using-the-hook.md#when-a-write-was-not-checked-at-all) for that question.

**A judged write only.** A tool call falsestart does not judge — `Bash`, `Read`, anything outside the
table in [Judged tool calls](#judged-tool-calls) — is silent in either policy.

That silence is bought by answering every failure above **after** the payload has been read, and it
has one cost outside a hook. `falsestart --rules pkg:<missing>` run by hand in a terminal now waits
for a payload that is never coming, where it used to print the resolution error and exit `1`
immediately. A hook runner closes stdin, so the hook itself is unaffected; a person checking their
setup is not. **Use `falsestart --doctor` to check a setup by hand** — it reads no stdin and reports
the same failure, as a `rules COULD NOT RESOLVE` line, with exit `1`.

A denial says the guard failed before it says anything else, and never names a rule:

```
falsestart could not check this write, and --fail closed denies a write it could not check. Nothing about the code was judged, so do not change it to satisfy this. What failed:
could not load rules from ./rules
broken.yml: SchemaError(Expected string, got 7
  at ["id"])
re-run the hook with --fail open to allow writes falsestart cannot check. Repairing the problem above needs that too: while --fail closed is on and the guard is broken, every judged write is denied, including the one that would fix it.
```

That last sentence is the part to read twice. falsestart answers a load-time failure before it judges
anything, so while `--fail closed` is on and the rule tree is broken, **every** judged write is
denied — including the edit that would repair the rule document. `--freeze off` does not have this
shape; `--fail open` is the way through.

Under `--agent copilot` the same table holds with two substitutions: every `report, exit 1` becomes
**`report, exit 0`**, and every **deny** becomes exit `2`. The only exit `1` left is the misdeclared
`--agent` notice, which is not in this table because it is not a guard failure — see
[Which agent is on the other end](#which-agent-is-on-the-other-end) — which makes the malformed-payload
row _stronger_ rather than weaker: exit 0 cannot deny even in principle.

**`--fail closed` is the recommended policy under `--agent copilot`.** A fail-open report lands on
stderr at exit 0, and GitHub does not document whether stderr is read at exit 0 at all. A denial is
unmissable in either reading; a report may not be readable.

`scan` and `--list-rules` refuse this flag because they already fail closed on every path — see
[Scan exit codes](#scan-exit-codes).

### Which agent is on the other end

`--agent <name>` names the runtime falsestart is answering. `claude-code` is the default and is the
0.2.0 behaviour in every respect. `copilot` is GitHub Copilot CLI.

**Declared, not detected, and that is the whole decision.** A payload tells you the shape that came
in. It says nothing about how the runtime will read your _answer_ — and the answer is where a wrong
guess turns a deny into an allow. Sniffing would infer "deny with exit 2" from "the payload said
`toolName`", so any normalising shim, proxy, or future Copilot that also accepts `tool_name` would
make falsestart emit the Claude Code deny at exit 0 and the write would land. `--doctor` could not
answer its own question either: it reads no stdin, so a sniffed contract does not exist at diagnosis
time.

Registration is duplicated in any installation serving both runtimes anyway. Claude Code registers in
`.claude/settings.json` under `PreToolUse`; Copilot registers in `.github/hooks/*.json` (or
`~/.copilot/hooks/`) under `{"version":1,"hooks":{"preToolUse":[…]}}`. `--agent copilot` adds sixteen
characters to a file that has to exist regardless.

**Two envelope spellings, and your hook config picks which.** GitHub documents two renderings of one
payload, selected by the CASING of the event name in the hook configuration: a camelCase
`preToolUse` gives `toolName`/`toolArgs`, a PascalCase `PreToolUse` gives `tool_name`/`tool_input`,
"to match the VS Code Copilot extension format". falsestart reads both, and reading them is not
sniffing the agent: the agent, and with it the entire output contract, is declared. `toolArgs` also
arrives as a **JSON-encoded string** in real invocations, which falsestart decodes; the same string
under `--agent claude-code` is genuinely malformed and is reported as such rather than reinterpreted.

**Setting the flag wrong is caught, in both directions, but not equally loudly.** Forgetting it in
front of Copilot denies every tool call in the session — the runtime treats exit 1 as "hook errored"
— so it is noticed in seconds. Declaring `copilot` in front of Claude Code would otherwise be exit 0
and silence: unguarded indefinitely, looking healthy the whole time. So a payload naming a tool that
belongs to the OTHER contract's table is reported rather than deferred, on the channel the runtime
that really sent it reads:

```
falsestart: this payload names the tool `Write`, which belongs to the claude-code contract, but --agent copilot was given. Set --agent claude-code, or remove the flag.
```

That is a structural test — membership in a declared, closed tool table — and not a guess about what
a name looks like. It only reaches the mirror case in the spelling the two contracts share: a
camelCase Copilot payload under `--agent claude-code` is answered `hook payload carried no tool_name`
instead, which is the loud direction anyway.

**What a rule author loses under Copilot.** A deny is exit 2. falsestart additionally writes
Copilot's own deny document to stdout and the reason to stderr, because GitHub's hooks reference
(read August 2026) says a `preToolUse` hook's stdout JSON is merged into the deny at exit 2 and its
stderr is surfaced to the user. Issue #50's adopter reports the opposite — that the model sees a
fixed generic string and the rule's message survives only in Copilot's own logs. falsestart does not
depend on which is true: the write is blocked by the exit code alone, and the reason goes to every
channel the contract documents. **Write a rule `message` that is useful to a person reading a log**,
not only to a model reading a denial — under Copilot it may be the only reader it gets.

A `severity: warning` finding is weaker still. Copilot's `preToolUse` output has three keys and none
of them is non-deciding: `"allow"` would auto-approve a write the permission flow would have prompted
for, and `"ask"` would make advice block. So advice goes to stderr and decides nothing, which means
it reaches the user and the log and never the model.

#### Provisional

`--agent copilot` ships **provisional**, and these are the three facts it rests on that nobody has
verified against a running Copilot:

| Unverified                      | If it is wrong                                                                                                                                        | How to check                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `edit` takes `path`/`new_str`   | `edit` is not judged at write time. `falsestart scan` still catches it in CI.                                                                         | `falsestart --doctor --agent copilot` prints the names; diff them against one payload.       |
| `create` takes `path`/`content` | Same, for `create`. `file_text` is the competing candidate for the content field.                                                                     | As above. falsestart names the keys that DID arrive when it cannot find the ones it expects. |
| stderr is readable at exit `0`  | Every non-deny diagnostic is invisible: guard failures under `--fail open`, malformed payloads, the misdeclared-flag notice, and all advisory output. | Run a hook that exits 0 and writes to stderr, and look.                                      |

GitHub documents Copilot's tool NAMES and nowhere documents its tool ARGUMENTS, which is why the
first two are inferences rather than readings. `edit`'s `path` is corroborated by
[copilot-cli#3349](https://github.com/github/copilot-cli/issues/3349); `new_str` and `content` are
not. Please report a mismatch — each correction is one literal and one table row.

### `falsestart --list-rules`

Prints the rule set falsestart resolved, as JSON on stdout, and exits without reading stdin. It
exists so a repository can **assert** on that set — that the rules blocking writes are the same
rules its CI gate checks — rather than parsing falsestart's internals, which works until the
internals are reformatted.

Resolved, not raw: `--preset` and `--rules pkg:` are resolved first, then the scope overrides from
`falsestart.config.ts` are applied, so `files` and `ignores` are the globs that will actually decide
what gets judged. Resolution starts from the ref by default (see
[Freezing the rule set](#freezing-the-rule-set)), which is what makes a CI assertion compare the
rules that block writes with the rules that were committed rather than with whatever is on disk.

**Read this before you write the assertion:** the document describes RULES, and a config's top-level
`exclude` is not one. `exclude` applies to `scan` and moves whole paths out of the gate without
changing any rule, so a repository that adds `exclude: ['legacy/**']` narrows what CI checks while
this document diffs clean. It is left out because it is per-run rather than per-rule and the
write-time hook never consults it at all — and because, unlike the resolved rule set, it is already
readable straight out of the committed config file. Assert it there.

`exclude` is not the only one, and naming it alone would read as the complete warning. What a `scan`
answers for is also narrowed by the caller's own `.gitignore` — falsestart asks git itself, so a path
added there stops being judged — and by `--exclude` globs on the command line, which add to the
config's list rather than replacing it. (`node_modules` and `.git` are always excluded and are not
configurable either way.) Each narrows the gate without touching a rule, so none of them can appear
here, and `.gitignore` is the likeliest to drift because adding a path to it does not feel like a
policy change. Each is readable where it lives — the config file, the hook command line,
`git check-ignore` — and a `scan` reports how many paths it left alone in its summary line, which is
the cross-check that does not depend on remembering this list.

| Field      | Type             | Meaning                                                                                                                                                                                                                                          |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `files`    | globs, or `null` | Effective scope. `null` means the rule declares none, so every path is in it.                                                                                                                                                                    |
| `id`       | string           | Unique within the tree; duplicates are refused at load.                                                                                                                                                                                          |
| `ignores`  | globs, or `null` | Effective exclusions. `null` means the rule declares none.                                                                                                                                                                                       |
| `language` | string           | The grammar the rule declares. For a JavaScript-family file the extension decides which grammar is actually used, so this is what a `css`/`html` rule is parsed with, and the fallback when a pattern will not compile under the file's grammar. |
| `severity` | string           | Resolved: a document that omits it reads as `error` here.                                                                                                                                                                                        |

`null` and `[]` are different answers and both occur. An absent `files` matches every path;
`files: []` is a legal document that matches nothing at all. Collapsing them would report the exact
opposite of the truth for one of the two.

The matcher — `rule`, `constraints`, `utils` — and the prose — `message`, `note` — are deliberately
absent. An assertion is only worth writing if it fails when something meaningful changed: carrying
the matcher would make every pattern refactor a failure, and carrying the message would make every
wording fix one. Read the rule document for those.

One rule per line, sorted by `id`, ascending. Not by file path: path order leaks the tree's layout
into the output, so moving a rule between category directories would diff while changing nothing
about behaviour. Ids are unique within a tree, so the order is total. Key order inside an entry is
fixed by the codec that writes it. Glob arrays keep the order they were written in — this reports
what is configured, not a canonical form of it.

A tree that loads with no rules in it prints `[]` and exits `0`. That is an answer rather than a
failure, and unlike a count the document says so unambiguously. Whether the installation is healthy
is `--doctor`'s question.

#### `--list-rules` exit codes

| Code | Meaning                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | The rule set is on stdout.                                                                                             |
| `2`  | It could not be produced — unreadable rule tree, a config that would not load, a rules package that would not resolve. |

These are `scan`'s codes on purpose: this command answers a script, and "falsestart could not run"
should not be spelled two ways inside one binary.

A command line that is **refused** — an unrecognised flag, a flag with its value forgotten, a
refused combination — still exits `1`, the shared code, whatever flags it named. `scan` is the one
exception, and refuses with `2` as it always has: a subcommand at `argv[0]` cannot be a stray flag on
a hook command line, which is what the rest of this paragraph is about. That is deliberate:
a refusal happens before falsestart knows which mode was asked for, the default mode is the hook,
and exit `2` from a hook blocks the write and throws stdout away. An argument error must never be
able to do that.

```bash
falsestart --list-rules --preset clean-code | jq -r '.[].id'
```

There is no `--json` flag. The output is JSON because that is the only thing this command is for,
and a flag that is accepted and changes nothing is what falsestart refuses elsewhere. The same
projection is available without a subprocess as `describeRules`, and `RuleDescriptionSchema` decodes
the document back into typed entries.

### The hook event falsestart implements

falsestart is a **`PreToolUse`** guard and nothing else. It judges the text a tool call is about to
write, and both of its outcomes — deny and advise — exist because the write has not happened yet.

Both runtimes name the event in the payload: Claude Code on every payload, GitHub Copilot CLI on the
VS Code compatible spelling a PascalCase hook config selects. When that name is anything other than
`PreToolUse`, falsestart judges nothing and says so:

```
falsestart: this hook was invoked for `PostToolUse`, and falsestart only implements `PreToolUse` — nothing was judged. A decision emitted here would name the wrong event and be ignored. Register falsestart on PreToolUse, or run `falsestart scan` for after-the-write reporting.
```

Exit `1` with that line on stderr under Claude Code; exit `0` with it on stderr under Copilot, where
every non-zero exit but 2 denies and a registration mistake must not be able to block a tool call. It
never denies in either `--fail` policy, and it is answered before the rules source, the freeze and
the rule tree are touched, so it costs what a deferred call costs.

**`PostToolUse` is the case worth naming.** falsestart used to judge that payload as though it were a
`PreToolUse` one and emit a document naming `PreToolUse` and carrying `permissionDecision` — a field
`PostToolUse` does not define. [Claude Code's reference](https://code.claude.com/docs/en/hooks.md)
gives `PostToolUse` a top-level `decision`/`reason`, or `hookSpecificOutput` with `additionalContext`
/ `updatedToolOutput`, so the document was ignored: nothing errored, nothing warned, and the hook
showed as registered.

**It is not going to be implemented there**, and the reason is not effort. Neither runtime can block
once the tool has run — Claude Code's exit-2 row for `PostToolUse` reads "No | Shows stderr to Claude;
the tool already ran", and Copilot's `postToolUse` is fail-open on every non-zero exit — so `Deny`
and `Advise` collapse into one emission and the `severity` of every rule stops meaning anything.
[`falsestart scan`](#falsestart-scan-paths) already covers that ground: register it as your
`PostToolUse` command if you want after-the-write reporting.

**Two limits, stated.** A payload carrying no event name is judged exactly as it always was — absence
is not a claim, and Copilot's camelCase payload carries no event field at all, so a Copilot hook
registered as `postToolUse` cannot be detected and is judged as before. And a tool call falsestart
would have deferred anyway (`Bash`, `view`, `grep`) stays silent at every event: the refusal fires
where a judgement would otherwise have been emitted, not on every call in the session.

### Judged tool calls

falsestart inspects the content a tool call is about to write. A tool name in NEITHER table produces
no output and exit 0, indistinguishable from a clean write, so a future write tool would be unguarded
without any signal. Both tables are asserted against the code by a test rather than maintained here
by hand.

A tool name in the OTHER contract's table is not silent: it is reported as a misdeclared `--agent`
(see [Which agent is on the other end](#which-agent-is-on-the-other-end)). That notice is answered
before the rules source, the freeze and the rule tree are touched, so it costs what a deferred call
costs and it never denies — a misdeclared payload is not a judged write in either contract, so
`--fail closed` has no more to say about it than it does about a malformed one. Claude Code ships no
tool called `create` or `edit`, so this needs a payload from something else speaking that envelope.

`Bash` is deliberately absent from both, and so are Copilot's `bash`, `view`, `grep`, `glob`, `task`,
`powershell`, `web_fetch` and `ask_user`. falsestart judges the text a write tool carries, so a
heredoc or a shell redirect writes a file it never sees. That is a real hole, not an oversight:
judging shell commands would mean predicting what they do.

#### Claude Code (the default)

The envelope is `tool_name` and `tool_input`.

| `tool_name`    | path field      | content field |
| -------------- | --------------- | ------------- |
| `Write`        | `file_path`     | `content`     |
| `Edit`         | `file_path`     | `new_string`  |
| `NotebookEdit` | `notebook_path` | `new_source`  |

That is the complete set of Claude Code built-ins that carry file content — there is no `MultiEdit`.

#### GitHub Copilot CLI

Under `--agent copilot`. The envelope has two documented spellings and falsestart reads both:
`toolName`/`toolArgs` when the hook config names the event `preToolUse`, and `tool_name`/`tool_input`
when it names it `PreToolUse`. `toolArgs` may arrive as a JSON-encoded string rather than an object.
`cwd` is spelled `cwd` in both, so every repo-relative glob works unchanged.

| tool     | path field | content field |
| -------- | ---------- | ------------- |
| `create` | `path`     | `content`     |
| `edit`   | `path`     | `new_str`     |

**These argument names are inferred, not documented.** See [Provisional](#provisional). `edit`'s
`old_str` is deliberately unread: an edit is judged by the text it INTRODUCES.

### Exit codes

#### Claude Code (the default)

| Code                       | Meaning                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `0` + `hookSpecificOutput` | A decision. This is how a block is expressed.                      |
| `0` + `systemMessage`      | Advice. Shown to the author; decides nothing.                      |
| `0` + no output            | No decision; the normal permission flow applies.                   |
| `1`                        | falsestart could not do its job. Reported, and the write proceeds. |

`0` + `hookSpecificOutput` also carries a freeze refusal: a source the ref established as freezable
that could not be read denies rather than reporting, and its reason names `--freeze off`.

It also carries a [`--fail closed`](#when-falsestart-itself-cannot-run) refusal, whose reason opens
by saying the guard failed and never names a rule.

The first two are separate rows because they are separate documents, not one document carrying a
different verdict: advice has no `permissionDecision` field at all, and a reader that looks only for
one sees nothing to act on — which is exactly what advice means here.

Advice has two sources and the envelope does not distinguish them: a rule matching at a severity
softer than `error`, or `--warn-unscoped` reporting that no rule was scoped to the path at all — the
second carries no finding, because the absence is the whole report. Do not read a `systemMessage` as
proof that some rule fired.

Blocking is deliberately **not** exit 2: exit 2 does block, but the runtime discards stdout and
reads stderr as the reason, throwing away the structured decision.

#### GitHub Copilot CLI

| Code                          | Meaning                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `2` + top-level deny document | A decision. This is how a block is expressed, and the only way to express one. |
| `0` + stderr                  | Advice, or a problem falsestart is reporting. Decides nothing.                 |
| `0` + no output               | No decision; the normal permission flow applies.                               |

**There is no `1` row for a judged tool call, and that is forced rather than chosen.** Copilot denies
the tool call on every non-zero exit other than 2, as `Denied by preToolUse hook (hook errored)`. So
an exit 1 would not mean "reported, and the write proceeds" — it would block the write with a reason
nobody can act on, and would silently convert `--fail open` into fail-closed. Every outcome that
exits `1` under Claude Code therefore exits `0` here, including a refused command line.

**The one deliberate exception, and its hazard.** A payload naming a tool from the Claude Code
contract while `--agent copilot` is in force is answered with Claude Code's emitter — exit `1` and a
stderr line — because the evidence of who is really on the other end is stronger than the flag, and
the notice is worth nothing on a channel the runtime that is actually there does not read. If the
runtime really is Copilot, that exit 1 denies. **That is the hazard to know about**: a Copilot MCP
server or custom tool named `Write`, `Edit` or `NotebookEdit` would be denied as "hook errored", and
the remedy the message prints would be the wrong one. It fails closed, which is the safe direction
for a guard, but it is not silent and it is not `--fail open`. Report it if you hit it — the tool
table is the thing that would need widening.

`--doctor` is not on the hook path at all: it reads no stdin, is run by a person in a terminal, and
still exits `1` when the installation is unhealthy. Nor is `--list-rules`, which keeps its own codes:
`0` with the document, `2` when it could not be produced, `1` when the command line was refused.

The deny document's keys are **top-level** — `permissionDecision` and `permissionDecisionReason` —
not nested under `hookSpecificOutput`, which Copilot ignores
([copilot-cli#2013](https://github.com/github/copilot-cli/issues/2013)). The reason is written to
stderr as well.

**Residual, stated:** a defect that escapes falsestart's own error handling still exits 1 through the
Node runtime, which under Copilot denies rather than passes. That is the safe direction for a guard —
it fails closed — but it is not the `--fail open` contract, so it is named here rather than left
implicit. The two known reachable cases are handled: a refused command line exits 0, and a reader
that closes the pipe is forgiven.

## Rule document

| Field         | Required | Meaning                                                           |
| ------------- | -------- | ----------------------------------------------------------------- |
| `id`          | yes      | Unique within a rule tree. Duplicates are refused.                |
| `language`    | yes      | One of `css`, `html`, `javascript`, `tsx`, `typescript`.          |
| `rule`        | yes      | The ast-grep matcher.                                             |
| `message`     | no       | Shown when the rule fires. Falls back to `note`, then the id.     |
| `note`        | no       | Longer rationale.                                                 |
| `severity`    | no       | `error` (blocks), `warning`, `info`, `hint`. Defaults to `error`. |
| `files`       | no       | Globs the path must match. Absent means every path.               |
| `ignores`     | no       | Globs carving exclusions out of `files`.                          |
| `constraints` | no       | Conditions on captured metavariables.                             |
| `utils`       | no       | Named sub-rules referenced by `matches:`.                         |

Documents under a `_utils/` directory at the **top level** of the loaded tree are fragments, not
rules: they need only `id` and `rule`, never match alone, and lose a name collision to a rule's own
`utils`. Only the first path segment is recognised, so a `_utils/` nested inside a category
directory is loaded as an ordinary rule, fails validation for the fields it does not carry, and
fails the whole tree with it.

## Configuration

```ts
// falsestart.config.ts
import type { FalsestartConfig } from '@sledorze/falsestart'

export default {
  rules: { 'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] } },
} satisfies FalsestartConfig
```

A top-level `exclude` array is optional and applies to `scan` only; a malformed one is an error
rather than being ignored, since silently dropping it leaves a repository believing it excluded
something.

`files` is required in an override; `ignores` is optional and, when omitted, the rule keeps its own.
An override naming a rule that is not loaded is an error, not a no-op. Use a **type-only** import for
the config type in a `.ts` config — it is type-stripped and imported from a `data:` URL with no
filesystem location, so a **package or relative** value import cannot resolve; `node:` builtins need
no location and do, which is enough to compute a rule's scope at load time. `.mjs` configs are
imported from their real path and may import anything, including `makeConfigUnsafe` — **unless the
freeze is on**, which is the default. Under a freeze every format is imported from a `data:` URL
built from the committed bytes, so the restrictions above apply to `.js`/`.mjs` too and
`makeConfigUnsafe` cannot be imported from one. Config **discovery** is frozen as well: a config file
the repository has not committed is not picked up, and one deleted from the working tree still
applies.

**An override replaces a rule's `files`; it does not merge into them.** That is deliberate — a merge
could never remove anything — but it means an override written to add one exemption has to restate
the whole glob, and any extension left out of the restatement is silently no longer guarded. The
narrowing direction is the dangerous one, because nothing fails: there is simply no `.mts` file yet
for anyone to notice going unchecked.

`--doctor` reports it, naming the rule and the extensions dropped:

```
config   falsestart.config.ts — 1 override(s): no-try-catch
         no-try-catch stops covering .mts, .cts, .js, .jsx, .mjs, .cjs — the override replaces the rule's own files
```

Reported, not refused: narrowing is what overrides are for, and `files: ['src/domain/**/*.ts']` is
the documented example. Only the language dimension is compared, never directories, because that is
where narrowing is nearly always an accident of restating a glob rather than a decision. The same
comparison is available as `findNarrowedScopes` if you want to assert it in your own test suite —
falsestart does, having caught its own config doing exactly this.

## Shipped rules

| Rule                            | Set        | Catches                                                                                         |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `no-as-any`                     | clean-code | `as any` erases the type rather than establishing it. Narrow with a type…                       |
| `no-as-never`                   | clean-code | `as never` silences an exhaustiveness error without resolving it. Handle…                       |
| `no-double-cast`                | clean-code | Casting through `unknown` defeats every check the compiler would have ma…                       |
| `no-empty-catch`                | clean-code | An empty catch discards the error and the fact that anything went wrong…                        |
| `no-hardcoded-credential`       | clean-code | This string literal has the shape of a real credential. Read it from con…                       |
| `no-type-assertion`             | clean-code | A type assertion tells the compiler to stop checking rather than establi…                       |
| `no-effect-assertion`           | effect     | Asserting a value into an Effect type erases the error and requirement c…                       |
| `no-await`                      | effect     | await drops out of the Effect world: no typed error channel and no inter…                       |
| `no-json-global`                | effect     | JSON.parse returns any and throws on malformed input, and JSON.stringify is partial in ways it… |
| `no-manual-effect-run-in-tests` | effect     | Running an Effect by hand in a test supplies its own runtime, so requirements vanish from the … |
| `no-new-promise`                | effect     | A hand-rolled Promise has no typed error channel and cannot be interrupt…                       |
| `no-process-env`                | effect     | Reading process.env directly makes configuration an untracked, untyped g…                       |
| `no-process-exit`               | effect     | process.exit tears the process down without running finalizers, so scope…                       |
| `no-raw-coercion`               | effect     | Raw coercion cannot fail, so a wrong value becomes a plausible one ("und…                       |
| `no-raw-error`                  | effect     | A built-in Error carries no type: every catch site sees `unknown` and ha…                       |
| `no-raw-fetch`                  | effect     | fetch has no typed error channel, no interruption and no timeout or ret…                        |
| `no-test-lifecycle-hooks`       | effect     | Lifecycle hooks set up state out of band: the test reads as if its depen…                       |
| `no-then-catch`                 | effect     | Promise chaining has no typed error channel and no interruption. Use Eff…                       |
| `no-throwing-decode`            | effect     | Schema's *Sync decoders return a value or throw, so a decode failure lea…                       |
| `no-try-catch`                  | effect     | try/catch produces an untyped `unknown` error that the compiler cannot h…                       |
| `no-unsafe-api`                 | effect     | Effect marks a partial or throwing API with an Unsafe or OrThrow suffix…                        |
| `no-vi-mocking`                 | effect     | "Module mocking replaces a dependency behind its consumer's back, so the…                       |
| `prefer-smart-constructor`      | effect     | An object literal with a declared type asserts the shape is valid withou…                       |

Seventeen of the twenty-three rules are scoped to `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` — every TypeScript
and JavaScript extension, with `*.test.*`, `*.spec.*` and `*.bench.*` variants exempt (the three
test-only rules invert that). They match runtime constructs — `try`, `await`, `process.env`,
`fetch`, `new Promise`, `JSON.parse` — which JavaScript has just as much as TypeScript does, and
each is tested against real JavaScript rather than assumed to work there.

Six stay TypeScript-only: `no-as-any`, `no-as-never`, `no-double-cast`, `no-effect-assertion`,
`no-type-assertion` and `prefer-smart-constructor`. Not because they cannot fire on a `.js` file — every rule declares
`language: tsx`, the parser is picked by that rather than by the extension, and all five do fire on
TypeScript syntax at a `.js` path. It is that **valid JavaScript cannot contain what they match**:
there is no `as` expression and no `const $NAME: $TYPE = {…}` annotation to find. Scoping them to
`.js` would claim coverage that a JavaScript file can never trip, and would silence
[`--warn-unscoped`](./using-the-hook.md) for a `clean-code`-only JavaScript repo — telling it it is
guarded when nothing there can fire. A test asserts both directions.

One gap this leaves, named rather than implied: JavaScript's own way of asserting a type is a JSDoc
cast (`/** @type {any} */ (value)`), and no shipped rule catches it.

All 23 rules are `error` severity, so every rule blocks. Rules in `clean-code` assume nothing beyond
TypeScript; those in `effect` assume an Effect codebase. `no-vi-mocking`, `no-test-lifecycle-hooks` and
`no-manual-effect-run-in-tests` apply **only** to test files — the inverse of every other rule.

`no-effect-assertion` is the one rule with **no test-file exemption at all**, and that is deliberate
rather than an omission. The blanket exemption every other assertion rule carries exists for fixture
casts a mock genuinely needs — `as never` to satisfy a signature it will never honour — but it also
waves through `as Effect.Effect<string>`, which claims a stream cannot fail when it can. A test
helper making that claim is exactly as wrong as a source file making it, and less likely to be read.
Scope it away per-repo in `falsestart.config.ts` if you disagree; the point is that the default is
not silence.

`Schema.Class`, `ErrorClass`, `TaggedClass` and `TaggedErrorClass` constructors do validate and
throw — `new Widget({ id: 42 })` raises `Expected string, got 42`. There is deliberately **no rule**
for them: banning `new Widget({ id, size })` would contradict `prefer-smart-constructor`, which
recommends exactly that. The construct is not the problem, the provenance of its input is, and a
syntactic matcher cannot tell a decoded value from a raw payload.

## Library exports

| Export                      | Kind        | Area     |
| --------------------------- | ----------- | -------- |
| `ConfigError`               | error class | config   |
| `DEFAULT_CONFIG_CANDIDATES` | constant    | config   |
| `AGENTS`                    | constant    | hook     |
| `AGENT_CONTRACTS`           | constant    | hook     |
| `FAILURE_POLICIES`          | constant    | hook     |
| `MatchError`                | error class | checking |
| `RuleDescriptionSchema`     | constant    | checking |
| `RuleLoadError`             | error class | checking |
| `RuleParseError`            | error class | checking |
| `SEVERITIES`                | constant    | checking |
| `SHIPPED_RULE_IDS`          | constant    | checking |
| `SUPPORTED_LANGUAGES`       | constant    | checking |
| `appliesTo`                 | function    | checking |
| `extensionGlobGroup`        | function    | checking |
| `grammarFor`                | function    | checking |
| `matchesAny`                | function    | checking |
| `applyScopeOverrides`       | function    | config   |
| `assessRule`                | function    | testing  |
| `checkFile`                 | function    | checking |
| `WRITE_TOOLS`               | constant    | hook     |
| `decide`                    | function    | hook     |
| `describeRules`             | function    | checking |
| `diagnose`                  | function    | hook     |
| `findDefaultConfigs`        | function    | config   |
| `findNarrowedScopes`        | function    | config   |
| `findUntestedRules`         | function    | testing  |
| `fallbacks`                 | function    | checking |
| `findViolations`            | function    | checking |
| `findViolationsIn`          | function    | checking |
| `parseSource`               | function    | checking |
| `judgesPayload`             | function    | hook     |
| `loadConfigFile`            | function    | config   |
| `loadDefaultConfig`         | function    | config   |
| `loadRules`                 | function    | checking |
| `makeConfig`                | function    | config   |
| `makeConfigUnsafe`          | function    | config   |
| `parseConfig`               | function    | config   |
| `parseRule`                 | function    | checking |
| `respond`                   | function    | hook     |
| `ruleListText`              | function    | checking |
| `scan`                      | function    | scanning |
| `render`                    | function    | scanning |
| `partitionPaths`            | function    | scanning |
| `readBaselineText`          | function    | scanning |
| `baselineText`              | function    | scanning |
| `parseIgnoredPaths`         | function    | scanning |
| `writeBaseline`             | function    | scanning |
| `readBaseline`              | function    | scanning |
| `fingerprint`               | function    | scanning |
| `samplePath`                | function    | checking |
| `toScopingPath`             | function    | checking |
| `validateConfig`            | function    | config   |
| `FREEZE_MODES`              | constant    | freezing |
| `MAX_ANCHOR_WALK`           | constant    | freezing |
| `classifyConfig`            | function    | freezing |
| `classifyRules`             | function    | freezing |
| `containedPath`             | function    | freezing |
| `divergence`                | function    | freezing |
| `freeze`                    | function    | freezing |
| `isAbsent`                  | function    | freezing |
| `parseBatchObjects`         | function    | freezing |
| `parseTreeListing`          | function    | freezing |
| `resolveAnchor`             | function    | freezing |
| `resolveRulesPath`          | function    | freezing |
| `isRuleDocument`            | function    | checking |
| `readRuleDocuments`         | function    | checking |

The extension lists `TYPESCRIPT_EXTENSIONS`, `JAVASCRIPT_EXTENSIONS` and `SOURCE_EXTENSIONS` are
exported too, with `extensionGlobGroup` to build the `{ts,tsx,…}` alternation from one of them. A
rules package faces the same restatement problem falsestart does — four globs per rule, and a
missing entry is silent — so the list it must agree with is importable rather than copied.

Types are exported alongside these: `Rule`, `Finding`, `Violation`, `Decision`, `DecideOptions`,
`Diagnosis`, `DiagnoseOptions`, `Config`, `FalsestartConfig`, `ScopeOverride`, `NarrowedScope`,
`AgentId`, `AgentContract`, `Envelope`, `FailurePolicy`, `HookResponse`, `RespondOptions`, `ScanOptions`, `ScanReport`, `ScannedFile`, `ScanOutcome`, `Exclusion`, `ExclusionReason`,
`Partitioned`, `PartitionOptions`, `ParsedSource`, `GrammarFallback`,
`ScanError`, `ScanExit`, `DEFAULT_EXCLUSIONS` and `BaselineUnreadable` are exported alongside them.
`Language`, `Severity`, `RuleConstraint`, `FileScope`, `FileUnderCheck`, `ShippedRuleId`,
`RuleExpectation`, `CaseResult`, `Identified`, `RuleDescription`, `Anchor`, `AnchorResolution`,
`ClassifyConfigOptions`, `ClassifyRulesOptions`, `ConfigSource`, `Divergence`, `FreezeEvidence`,
`FreezeInput`, `FreezeMode`, `FreezeOutcome`, `Frozen`, `GitAnswer`, `RulesPath`, `RulesPathOptions`,
`TreeEntry` and `Absent`.

`Options` and `Preset` are **not** exported: `src/index.ts` re-exports the `checking`, `config`,
`freezing`, `hook`, `scanning` and `testing` entry points, and argument parsing is the CLI's own
business.

`effect` is a required peer dependency; `@effect/platform-node` is optional, needed only for the
helpers that touch the filesystem.
