# Using the hook

falsestart runs as a Claude Code `PreToolUse` hook. It reads the tool call on stdin and answers
with a decision, so a rule violation is caught as the code is written rather than at CI.

## Register it

`.claude/settings.json` is strict JSON — no comments, no trailing commas. An unparseable settings
file discards every hook and permission rule in it, so a `jsonc` sample copied verbatim disables far
more than falsestart:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/@sledorze/falsestart/dist/cli.js\" --preset clean-code"
          }
        ]
      }
    ]
  }
}
```

Two details that are easy to get wrong and fail silently:

- **Invoke by path, not as a bare `falsestart`.** `node_modules/.bin` is not on `PATH` for a hook
  command, so a bare name exits 127. Claude Code treats that as a non-blocking error, the write
  proceeds, and `/hooks` still shows the hook registered. `npx falsestart …` works too.
- **Include `NotebookEdit` in the matcher** if you want notebooks judged. falsestart handles it —
  scoping a rule to `**/*.ipynb` works — but the matcher decides what ever reaches falsestart.
  `Bash` is deliberately absent: falsestart judges the text a write tool carries, so a heredoc
  redirect is outside what it can see.

### Running your own Bash guard alongside it

Guarding shell commands is a job for a second hook, and two `PreToolUse` entries is the intended
arrangement rather than a workaround. A `matcher` decides which entries a tool call reaches, so
falsestart's entry and a shell guard's entry select disjoint sets of calls:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/@sledorze/falsestart/dist/cli.js\" --preset clean-code"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/scripts/guard-shell.js\""
          }
        ]
      }
    ]
  }
}
```

Invoke both by path, for the reason above.

Overlapping matchers cost nothing either. On a payload whose `tool_name` is not `Write`, `Edit` or
`NotebookEdit`, falsestart writes nothing to stdout, nothing to stderr, and exits 0 — and it does so
**before the rule tree is read**, so a rule file with a typo in it cannot turn an unrelated `Bash`
call into an error notice.

On falsestart's side the two never interact: it reads one payload on stdin, answers on stdout, and
exits. On the hook path it writes no file, holds no lock and caches nothing, so its answer depends
on its stdin, its rule tree and its config and on nothing else. What Claude Code does with two
entries' answers is the runtime's business, and this page does not describe it.

### Editing a rule while the freeze is on

By default falsestart reads its rule documents and its config from `HEAD` rather than from your
working tree, so the guard cannot be disarmed by the session it is guarding. The cost is one
surprise: **you edit a rule, and nothing changes.**

falsestart says so at the moment it happens. A judged write of a rule document inside the rules
directory comes back with a `systemMessage`:

```
falsestart:
rules are read from HEAD, so this document does not take effect until it is committed.
`falsestart --doctor` lists what is not in effect; `--freeze off` reads the working tree.
```

That note covers the case where you are editing the rule. It does not cover the other direction —
widening a rule and expecting a new block somewhere else stays silent, because a signal that fires on
most writes is one people stop reading. Two things answer it:

```bash
falsestart --doctor --rules ./rules        # lists every working-tree change that is not in effect
falsestart --freeze off --rules ./rules    # this run reads the working tree
```

While you iterate, put `--freeze off` on the hook command line, or commit as you go. See
[Freezing the rule set](./reference.md) for what each mode does and what happens when the freeze
cannot be established.

### Check it is actually guarding something

Every misconfiguration falsestart has degrades to the same place — exit 1, a line on stderr the agent
runtime swallows, and the write proceeding. A registered hook that enforces nothing looks exactly
like one that found nothing to complain about. `--doctor` is the difference:

```bash
node node_modules/@sledorze/falsestart/dist/cli.js --doctor --preset clean-code
```

```
falsestart <the installed version>
changes  …/CHANGELOG.md — what this version changed, including any rule that is new

rules    …/rules/clean-code — 6 loaded (6 block, 0 advise)
config   no config file in /repo — 0 override(s)
tools    Edit, NotebookEdit, Write — any other tool call is ignored
scope
           6 rule(s) apply to src/a.ts
           6 rule(s) apply to src/nested/deep/a.ts
           6 rule(s) apply to src/a.mts
           0 rule(s) apply to src/a.test.ts
           2 rule(s) apply to src/a.js

check    the sample `const widget = payload as any` at src/nested/example.ts was blocked
```

The first line is the version that actually answered, and it is worth reading rather than skipping:
a hook wired at a path still holding an older copy reports on that copy's rules, and every line
below it will look plausible while describing a package you did not think you were running. Check
it against the version your lockfile resolved. It is elided above on purpose — a real version
printed here would be a number that goes stale at the next release, which is the failure this
paragraph is about.

The `changes` line is the second half of that question: not which version you have, but what it does
to you. A MINOR bump can add an `error`-severity rule to a preset, which makes a repo that passed
yesterday fail today — `0.2.0` did it twice — and a version number on its own cannot tell you that.
It names the changelog inside the package you are actually running, so the answer comes from the same
copy every other line in the report describes. The line is absent if that file is not there, which is
the case for every version published before it existed — `0.1.0` and `0.2.0` shipped no changelog at
all, so on those the only way to see what an upgrade added was to pack both versions and diff them.

The `rules` line counts the tree twice: how many documents loaded, and how many of those declare a
severity that could deny — only `error` does, and everything softer is shown to the author and
decides nothing (see **Rules that advise instead of blocking** below). It is a tally of severities
and nothing more: a rule scoped to a path your repo does not have still counts as `block` and can
never fire, which is what the scope block underneath is for. Both numbers print even when one is
zero, which is the case above and with every shipped preset.

It reads no stdin and exits 1 if any step did not resolve, naming the cause — a rules directory that
is not there, a config that cannot be read, or an override for a rule the current preset does not
load. That last one is easy to hit: narrowing `--preset all` to `--preset clean-code` while keeping a
config that names an Effect rule turns the whole guard off.

**Read the scope block, not just the last line.** A nested path is probed on purpose: `src/**.ts` and
`src/**/*.ts` look alike and behave completely differently, and a rule set with that typo guards
top-level files while leaving every nested source file — nearly the whole codebase — untouched. When no
rule reaches any probed path it says so and still exits **0** — "misses five `src/` paths" is not
"misses everything", and a rule set scoped to `lib/**` or a monorepo's `packages/*/src/**` blocks
perfectly well while probing zero here. Read the block; do not gate CI on the exit code alone.

### When a write was not checked at all

`--doctor` answers the question for a fixed set of sample paths. `--warn-unscoped` answers it for
the paths your repo actually writes: with it on, a judged write that no rule is scoped to reports
itself instead of passing in silence.

```
{"systemMessage":"falsestart:\nno rule is scoped to src/probe.js, so this write was not checked"}
```

It decides nothing — the write proceeds — and it can never pre-empt a block, because a rule that
could block is a rule that applies. Reach for it when a write you expected to be stopped was not:
the two silences it separates ("no rule looked at this" and "every rule looked and approved") are
identical from the outside, and the first is the one that means the guard is inert.

It is off by default because the honest signal is noisy. Measured against the shipped presets:

| Written file      | `clean-code` | `effect` | `all`  |
| ----------------- | ------------ | -------- | ------ |
| TypeScript source | silent       | silent   | silent |
| JavaScript source | silent       | silent   | silent |
| Markdown or JSON  | warns        | warns    | warns  |
| TypeScript test   | warns        | silent   | silent |
| JavaScript test   | warns        | silent   | silent |

Every documentation and config write warns under all three, which is most writes in most repos —
and a warning you see on most writes is one you stop reading.

Test files are the row where the presets disagree, and they disagree usefully. All six `clean-code`
rules ignore tests, so under it a test file genuinely has nothing that can fire — and it says so.
`effect` carries three rules that exist specifically to judge tests. A row that reads "warns" is not
a defect to silence; it is the preset telling you what it does not cover.

The JavaScript row changed when `no-empty-catch` and `no-hardcoded-credential` were added: they are
the first `clean-code` rules that reach JavaScript, so that preset stopped being inert there. It is
worth noticing that the signal moved on its own — this table is measured, not maintained by hand.

### Denying what could not be checked

The section above is about "no rule looked at this". This one is about the other half: a rule tried
and could not. By default that is reported on stderr, the process exits `1`, and the write proceeds —
so a typo in a rule document cannot hold the whole repository hostage. If your repository would
rather have the opposite, add `--fail closed` to the hook command:

```json
{ "type": "command", "command": "npx falsestart --preset all --fail closed" }
```

What changes: a rule tree or a `pkg:` rules package that will not load, a config that will not load
or whose override names a rule that is not loaded, and a rule that cannot run at match time all deny
the write instead of reporting it. What does not: a malformed hook payload and a refused command line
stay non-blocking, a tool call falsestart does not judge stays silent, and a freeze refusal denies
either way — `--fail open` is not an off switch for `--freeze`. The full table is in
[When falsestart itself cannot run](./reference.md#when-falsestart-itself-cannot-run).

**Know the repair trap before you turn it on.** falsestart answers a load-time failure before it
judges anything, so while `--fail closed` is on and the rule tree is broken, every judged write is
denied — including the edit that would fix the rule document. The denial says so, and the way through
is to re-run the hook with `--fail open`. `--freeze off` does not help here; it chooses which bytes
are authoritative, not what a broken guard costs.

`falsestart --doctor --fail closed` proves it is on, in a line printed before anything is resolved so
it is still there when nothing resolved:

```
policy   --fail closed — a write falsestart cannot check is DENIED. A malformed hook payload still proceeds.
```

Rules can come from three places:

| Source                  | How                                                     |
| ----------------------- | ------------------------------------------------------- |
| Shipped with falsestart | `--preset all` (or `clean-code`, `effect`)              |
| Your own repo           | `--rules ./rules` — any directory, searched recursively |
| Another package         | `--rules pkg:@acme/falsestart-rules`                    |

`--preset` and `--rules` are mutually exclusive; giving both is refused rather than ranked.

A package specifier may name a subdirectory — `pkg:@acme/falsestart-rules/strict` — to take part of
a rule set. The package is expected to keep its rules in a `rules/` directory, as falsestart does,
and is resolved from **your project**, so it is found wherever your package manager put it rather
than at a guessed `node_modules` path that pnpm's layout does not have.

The `pkg:` prefix is required rather than inferred. `--rules rules` has always meant the `rules/`
directory, and quietly reinterpreting a bare name as a package would change which rule set an
existing setup loads — the worst failure available to a tool whose job is enforcing a rule set.

A package that will not resolve is reported and does not block, like every other misconfiguration:
a missing dependency must not stop every write in the repo — unless `--fail closed` is set, which
denies a **judged write** on it. A tool call falsestart does not judge stays silent either way.

## Catching what bypasses the hook

The hook judges a tool call, so it sees `Edit`, `Write` and `NotebookEdit` and nothing else. A
`Bash` heredoc, a `>` redirect, `git checkout`, `git merge`, `git revert`, a person in an editor,
another agent, and every file that predates the hook being installed all reach disk unexamined.

`falsestart scan` is the second enforcement point, for a git hook or CI:

```yaml
# lefthook.yml
pre-push:
  commands:
    falsestart:
      run: node node_modules/@sledorze/falsestart/dist/cli.js scan --preset all {push_files}
```

```sh
# .husky/pre-commit — -z and -0 together, because git C-quotes non-ASCII paths
git diff --cached --name-only --diff-filter=ACM -z |
  node node_modules/@sledorze/falsestart/dist/cli.js scan --preset all -0
```

Use `-z`/`-0` rather than plain newlines. `git diff --name-only` C-quotes any path outside ASCII, so
a filename with an accent in it arrives wrapped in literal double quotes with its bytes escaped —
`"src/caf\303\251.ts"` — and opens as ENOENT. A file silently skipped by the gate meant to check it.

**Dependencies are never judged.** `node_modules` and `.git` are always excluded, and anything your
`.gitignore` covers is excluded too — asked of `git check-ignore` rather than reimplemented. A
finding in somebody else's library is one nobody can act on, and that noise is what gets a gate
switched off. Anything else belongs in the config, once, rather than in every hook command line:

```ts
// falsestart.config.ts
export default { exclude: ['legacy/**', 'generated/**'], rules: {} } satisfies FalsestartConfig
```

`--exclude <glob>` adds to that for a single run; it does not replace it.

`dist/`, `build/` and `vendor/` are deliberately not excluded by default: plenty of projects author
real source in directories with those names. Every exclusion is counted in the summary line, so
nothing is dropped in silence.

**Paths come from you, never from falsestart.** Your hook runner already computes the list and does
it better: lefthook has `{staged_files}` and `{push_files}`, husky users have `git diff`. Doing it
here would mean depending on git being installed, on being in a work tree, and on a ref existing.

One thing to know about `{push_files}`: on the **first** push of a branch there is no upstream, so
it expands to the whole tree. Adoption day is a full-repo scan, which is what `--baseline` is for.

### It is stricter than the hook, on purpose

An `Edit` payload carries only the text it would introduce, so the hook judges what a change **adds**.
A scan parses whole files, so it reports everything already there. Measured over 424 files of real
hand-written TypeScript, **64% already carry at least one finding** under the shipped rules. Passing
only changed files bounds each commit; it does not change the odds that a file you touched already
violates.

So a one-line edit to a legacy file is allowed by the hook and blocked by the scan on lines you
never wrote. Accept what is already there once:

```sh
falsestart scan --preset all --baseline .falsestart-baseline.json --update-baseline $(git ls-files)
```

After that the baseline absorbs those findings and only new ones fail. It holds fingerprints rather
than line numbers, so a finding that moves when something is inserted above it is still the same
finding, and reformatting does not churn the file.

It records **one entry per occurrence** and absorbs exactly that many. Accepting two identical
`as any` lines in a file does not accept a third — otherwise copy-pasting more of an
already-accepted pattern would be invisible to the gate forever.

A `--baseline` file that does not exist yet means "nothing accepted", so you can wire the flag in
before creating it. A file that exists but cannot be read — a typo'd path, a directory, malformed
JSON — is an error and exits 2. Treating that as an empty baseline would make a broken baseline
indistinguishable from a real and growing set of new violations.

### Read the summary line

Every run that got far enough to judge anything ends with `scanned N file(s), M in scope, K
finding(s)`; a run that could not start says why instead and exits 2. `M` is the one to read. A bare
"no findings" is printed by a genuinely clean run, by a run whose paths matched no rule, by a run
given no paths at all, and by `scan` accidentally wired as the `PreToolUse` command — where exit 0
with non-JSON on stdout reads to the agent runtime as "allow", silently permitting every write. When
`M` is `0` the run says so outright.

### Pin the rule set, so the two gates cannot drift

The hook and `scan` are two invocations, in two config files, with two chances to disagree about
which rules are loaded. `--list-rules` makes the answer assertable:

```bash
falsestart --list-rules --preset all > rules.json
```

The freeze is the other half of this: with `--freeze auto` (the default) both the hook and `scan`
resolve their rules and config from the same committed ref, so the two gates cannot disagree because
one of them read an uncommitted edit.

Commit that file and diff it in CI, or assert on it from a test. It is the resolved set — presets
and `pkg:` specifiers already resolved, your `falsestart.config.ts` overrides already applied — so
it changes when a rule is added, renamed, dropped, re-scoped or has its severity changed, and does
not change when a matcher is refactored. One rule per line, sorted by id, so two runs diff cleanly
however the rule tree is laid out on disk.

It reports rules, and a config's top-level `exclude` is not one: `exclude` takes whole paths out of
`scan` without touching a rule, so pin it by reading the config file, not by diffing this document.
The same goes for `--exclude` globs on the command line and for your `.gitignore`, which falsestart
asks git about directly — all three narrow what the gate answers for while this document stays
identical. `scan`'s summary line is where you see how many paths were left alone.

Exit `0` means the document is on stdout; exit `2` means the rule set could not be produced at all.
Do not read an empty diff as proof the command ran; read the exit code.

From a test, without a subprocess, `describeRules` returns the same entries from rules you loaded
yourself, and `RuleDescriptionSchema` decodes a document you read back.

## Publishing your own rules

A rules package is a directory of ast-grep documents under `rules/` and nothing more:

```
@acme/falsestart-rules/
  package.json
  rules/
    strict/no-console.yml
```

The `matcher` is an optimisation, not a safety boundary — falsestart ignores tool calls it has no
opinion about, and does not even load the rule tree for them.

## What it does

| Situation                                 | Behaviour                                                      |
| ----------------------------------------- | -------------------------------------------------------------- |
| Write/Edit matching an `error` rule       | Blocked, with the rule's message                               |
| Write/Edit matching a softer rule         | Allowed; advice that blocks is indistinguishable from an error |
| Path outside the rule's `files`/`ignores` | Rule never runs                                                |
| Path outside **every** rule's scope       | Silent, unless `--warn-unscoped` — then reported, not blocked  |
| Any other tool                            | Ignored                                                        |
| Rule tree will not load                   | Visible error, write proceeds                                  |
| A rule cannot run                         | Visible error, write proceeds                                  |

The last two are deliberate. A guard that refuses to run should say so loudly, but a typo in a
rule file should not hold a repository hostage.

### Rules that advise instead of blocking

`severity` defaults to `error`, and `error` is the only severity that denies a write. A rule
declaring `warning`, `info` or `hint` produces a finding that is shown to the author and decides
nothing: the write lands, and the normal permission flow applies to it.

```yaml
# rules/hygiene/no-console.yml
id: no-console
language: tsx
severity: warning
message: 'console.log survives into production, where nobody reads it.'
rule:
  pattern: console.log($$$)
files:
  - '**/*.{ts,tsx}'
```

```bash
echo '{"tool_name":"Write","cwd":"'"$PWD"'","tool_input":{"file_path":"'"$PWD"'/src/widget.ts","content":"console.log(widget)"}}' \
  | node node_modules/@sledorze/falsestart/dist/cli.js --rules ./rules
```

That prints one line and exits 0:

```
{"systemMessage":"falsestart:\nno-console (1:1): console.log survives into production, where nobody reads it."}
```

Advice and a denial are **different JSON documents**, not one document with a different verdict. A
denial is `{"hookSpecificOutput":{…,"permissionDecision":"deny","permissionDecisionReason":…}}`;
advice is a `systemMessage` with no `permissionDecision` in it at all. Both exit 0. It is the same
envelope the `--warn-unscoped` sample under **When a write was not checked at all** shows, which is
not a coincidence: that flag reports through this path rather than having one of its own.

Each advised finding is rendered `<rule-id> (<line>:<column>): <message>` — the same line a denial's
reason carries, so the format is worth learning once.

Nothing about the invocation selects a severity: it is a field of the rule document, so one rule has
exactly one severity everywhere it is loaded. A rule that must block in a curated tree and advise in
a wider one therefore exists **twice**, as two documents with different ids or as one document in
two trees reached by two hook entries. Two documents sharing an id in one tree are refused outright,
so inside a single tree the two-ids form is the one that works. The cost of that is worth stating
plainly: against a policy table one tool reads two ways, this is a duplicate kept in step by hand,
and nothing checks that it still is.

`--doctor` reports the split, so "does this thing have advisory rules" is answered by the
installation rather than by this page. With any shipped preset the second number is `0` — all 23
shipped rules are `error` — and that is a fact about the corpus, not about the tool.

## Choosing rules

The shipped corpus lives in [`rules/`](../rules) and is split by what it assumes:

- `rules/clean-code/` — generic hygiene, no framework assumptions. Four rules key on TypeScript
  syntax; `no-empty-catch` and `no-hardcoded-credential` reach JavaScript as well.
- `rules/effect/` — assumes an Effect codebase. `no-await` in particular forbids a construct most
  TypeScript projects use freely, so adopt this directory only if that is what you want.

Point `--rules` at a directory holding only the subset you want. Which rules are _active_ is decided
by which rule documents are present, so the answer to "what is enforced here" is a directory
listing.

### Laying out a large rule tree

Subdirectories are organisational only. The tree is searched recursively and every rule found is
loaded whatever its depth, so a category per directory costs nothing and buys a listing someone can
read. Ids are unique across the **whole tree** rather than per subdirectory, and a duplicate refuses
the entire load rather than being resolved by load order. Every rule that matches a write is
reported in one answer, so the finding you see is not merely the first to fire.

The one part of the layout that is not free-form is where shared matchers live: a `_utils/`
directory is recognised only at the top of the tree `--rules` names. **Shared matchers** below has
the rule and what a misplaced one does.

`--rules` names one rule source per invocation and cannot be combined with `--preset`, so layering
two trees means two hook entries, one per tree. That is not purely a limitation: each entry carries
its own rules, its own config and therefore its own severity policy, which is what makes the "blocks
here, advises there" arrangement above expressible at all.

There is a cost to know before splitting a tree that way. A `_utils/` at the root is not in scope when
an entry points at one subdirectory of it, and a rule referencing a matcher it cannot see fails to
run — reported, non-blocking, exit 1:

```
falsestart: rule no-any-assertion could not run: Error: `rule` is not configured correctly.
 |->Rule contains invalid matches reference.
 |->Rule `anyKeyword` is not defined.
```

A shared matcher and a split tree therefore pull against each other; copying the fragment into each
tree is the way out, with the drift that implies. What the tree costs per tool call is measured in
[Why falsestart is built this way](./architecture.md).

## Re-scoping a rule to your layout

A rule ships with `files`/`ignores` chosen by an author who does not know your directory structure.
A config re-scopes it without touching the rule. Write it in TypeScript and the compiler checks it:

**An override replaces the rule's globs; it does not merge into them.** So writing one to add a
single exemption means restating the rule's whole `files` glob, and an extension you leave out is
silently no longer guarded — nothing fails, because there is no file with that extension yet for
anyone to notice going unchecked. falsestart's own config did this for two releases. `--doctor`
now names the rule and the extensions dropped; read that line whenever you add an override.

```ts
// falsestart.config.ts
import type { FalsestartConfig } from '@sledorze/falsestart'

export default {
  rules: {
    'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] },
    'no-await': { files: ['src/**/*.ts'], ignores: ['src/legacy/**'] },
  },
} satisfies FalsestartConfig
```

Use a **type-only** import for the config type. A `.ts` config has its types stripped and is
imported from a `data:` URL with no filesystem location, so it cannot resolve a **package or
relative** value import; `import type` is erased and works. `node:` builtins need no location and do
resolve, which is enough to compute a rule's scope — shell out, build a list of paths, emit globs —
without leaving the typed format.

A `.mjs` config is imported from its real path and may import anything, including the smart
constructor:

```js
// falsestart.config.mjs
import { makeConfigUnsafe } from '@sledorze/falsestart'

export default makeConfigUnsafe({
  rules: { 'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] } },
})
```

`makeConfigUnsafe` validates and throws at import, so a malformed config fails at the config file
rather than somewhere downstream. `makeConfig` is the same check returning an `Effect`, for
building a config in code. Prefer `.mjs` over `.js`: a `.js` config in a package without
`"type": "module"` makes Node reparse it and warn.

JSON works too, with the same shape and no type checking.

`files` is **required**. An override exists to say where a rule applies in _this_ repo, and one
that adjusts only `ignores` leaves that answer inherited from someone who never saw your layout.

`ignores` is optional, and omitting it keeps the rule's own — narrowing where a rule looks must not
quietly discard the test-file exemption its author wrote.

Without `--config`, falsestart looks for `falsestart.config.{ts,mts,js,mjs,json}` in the directory
the process was started in — the project root, in a normal hook setup — and does not search upward.
Not beside the rules directory: with `--preset` the rules live inside `node_modules`, and a config
there would belong to falsestart rather than to you. None present means no overrides. **Two** present is an error rather than a precedence
rule: silently picking one of two configs is the kind of quiet wrong answer this tool exists to
prevent. A config named explicitly with `--config` must exist.

An override naming a rule that is not loaded is an error rather than a no-op, because a typo'd id
would otherwise be a scope change that silently never happens. `ShippedRuleId` is exported if you
want that caught at compile time instead.

This is the supported answer when a rule fires somewhere it should not. Editing the rule documents
under `node_modules` is not: the next install undoes it.

## Writing a rule

A rule is an [ast-grep](https://ast-grep.github.io) rule document. `id`, `language`, and `rule` are
required; `message`, `severity`, `files`, `ignores`, `constraints`, and `utils` are optional.

```yaml
id: no-as-any
language: tsx
severity: error
message: '`as any` erases the type rather than establishing it.'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,tsx}'
ignores:
  - '**/*.test.{ts,tsx}'
```

Scope every rule with `files`. A rule with no `files` runs against every path, including ones
where its language makes no sense.

Globs are matched against the path **relative to the project root** the hook reports (`cwd`), so
`src/**/*.ts` works as written. A file outside that root keeps its absolute path, and a rule can
still reach it with a leading `**/`.

Notebooks are scoped by the notebook's own path, not by the cell's language. A rule scoped to
`**/*.ts` will not see TypeScript typed into a `.ipynb` cell — add `**/*.ipynb` to its `files` if
you want it to.

## Shared matchers

A matcher needed by several rules goes in a `_utils/` directory at the **top level of the tree
`--rules` names** — not inside a category — where every rule in the tree can reference it by name:

```yaml
# rules/_utils/any-keyword.yml
id: anyKeyword
rule:
  kind: predefined_type
  regex: '^any$'
```

```yaml
# rules/type-safety/no-any-assertion.yml
rule:
  kind: as_expression
  has:
    matches: anyKeyword
```

Documents under `_utils/` are fragments, not rules: they need only `id` and `rule`, and they never
match on their own. A rule's own `utils:` block wins a name collision — the shared set is a
default, not an override.

"Top level" is exact: the directory is recognised by the **first** path segment. A `_utils/` nested
inside a category is not a fragment directory at all — its documents are loaded as rules, fail
validation for the fields a fragment does not carry, and, loading being all-or-nothing, take the
whole tree with them:

```
falsestart: could not load rules from ./rules
type-safety/_utils/any-keyword.yml: SchemaError(Missing key
  at ["language"])
```

The message names the wrong problem — nobody forgot `language`; the fragment is somewhere fragments
are not looked for — so it is worth recognising by its shape.

Give every rule worked examples of both kinds — code it must catch and code it must leave alone.
`assessRule` runs them, and the second kind is the one that matters: a rule with only positive
examples looks correct right up until it fires on something nobody meant to forbid.
