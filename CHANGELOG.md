# @sledorze/falsestart

## 0.3.0

### Minor Changes

- c21b026: `--fail closed`: deny a write falsestart could not check

  `--fail closed` makes a failure of falsestart **itself** deny the write instead of reporting it on
  stderr and letting the write through. `falsestart --preset all --fail closed` in your hook command
  is the whole setup.

  **No judged write changes verdict unless you ask.** The default is `--fail open`, which is today's
  behaviour byte for byte.

  What `--fail closed` covers: a rule tree or a `--rules pkg:` rules package that will not load, a
  config that will not load, an override naming a rule the loaded set does not contain, and a rule that
  cannot run at match time. What it never denies FOR: a **malformed hook payload**, because it is the
  agent runtime's shape rather than your repository's and there is nothing in your project to fix; and
  a **refused command line**, because `--fail` is on the very line the parser just declined to
  understand. Never the reason, not never the outcome — a run whose rule tree will not load denies
  whatever payload arrives, malformed ones included, naming the rule tree and not the payload, exactly
  as the freeze already does. It applies to a **judged write** only — a tool call falsestart does not judge is silent
  in either policy — and it is a policy about failures, not a claim that any rule covers what you
  write. For that, read `--doctor`'s scope block and `--warn-unscoped`.

  **`--fail open` is not an off switch for the freeze.** A source the ref established as freezable and
  could not be read still denies, and its reason still names `--freeze off`.

  Know the repair trap before turning it on: falsestart answers a load-time failure before it judges
  anything, so while `--fail closed` is on and the rule tree is broken, every judged write is denied —
  including the edit that would fix the rule document. The denial says so and names `--fail open` as
  the way through.

  **Three behaviour changes ship regardless of the flag**, all on the `--rules pkg:` path, and all
  named here because a changelog reader is the only person who will see them:

  1. With `--rules pkg:` naming a package that will not resolve, a tool call falsestart does **not
     judge** (`Bash`, `Read`, and anything outside `Write`/`Edit`/`NotebookEdit`) is now **silent**
     instead of exit 1 with a stderr notice — the same as every other rules-source failure. A judged
     write is unaffected.
  2. `falsestart --doctor --rules pkg:<missing>` now prints a report ending in a
     `COULD NOT RESOLVE` line and exits 1, where it previously printed one stderr line and no report
     at all.
  3. `falsestart --rules pkg:<missing>` run **by hand in a terminal** now waits for a hook payload
     instead of printing the resolution error and exiting 1. That is the price of 1: the answer has to
     come after the payload has been read, or a `Bash` call cannot be silent. A hook runner closes
     stdin, so a real hook is unaffected — but if you check your setup by running the command yourself,
     use `falsestart --doctor` instead, which reads no stdin and reports the same failure.

  `scan` and `--list-rules` **refuse** the flag: both already exit 2 when they cannot run, so `closed`
  would be a no-op and `open` would weaken a shipped guarantee. No existing command line contains
  `--fail`, so nothing that parsed yesterday is refused today.

  `--doctor` prints a `policy` line **only when `--fail` was given**, before anything is resolved — so
  it is still there when nothing resolved, and `--doctor`'s output is unchanged for anyone who does not
  use the flag.

  New exports: `FAILURE_POLICIES`, type `FailurePolicy`. New **optional** fields
  `RespondOptions.failure`, `RespondOptions.unresolvedRules`, `DiagnoseOptions.failure` and
  `DiagnoseOptions.unresolvedRules` — all optional, so no consumer's `tsc` turns red.

- ad5b588: Read rule documents and the config from a git ref instead of the working tree.

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

  **The freeze's `git` invocations ignore global and system configuration.** They run with
  `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointed at `/dev/null` and with `GIT_DIR`,
  `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
  `GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_CEILING_DIRECTORIES` and `GIT_NAMESPACE` cleared, because
  git consults all of them before it looks at any path and any of them could decide which repository is
  authoritative. A global `include`, a custom `core.*` or a `[user]` block does not apply to these four
  invocations; repo-local `.git/config` still does. This also means `git` failing for a reason other
  than "there is no repository" now denies rather than reading the working tree.

  **Nested repositories are resolved from the outside in.** The outermost enclosing repository speaks
  first, and one nested below it is trusted only where the authority already established has nothing at
  that path — an independent checkout, which is what a dotfiles repository in `$HOME` makes of every
  project inside it — or accounts for it as one of its own linked worktrees, which then freezes against
  its own branch. Where that cannot be established, the freeze refuses in every mode. If you keep an
  untracked clone at a path your repository also tracks, that is the shape which now refuses; pass
  `--freeze off` for it.

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

- 9cd8fb6: Parse each file with the grammar its extension implies, not the one its rule happens to declare.

  A rule's `language` in falsestart means "parse it as this", not "only these files" — that is what
  lets a single rule cover `.ts`, `.mts` and `.js`. Every shipped rule says `language: tsx`, so every
  TypeScript file was being parsed with the **TSX** grammar. The two genuinely differ: TSX reads
  `<string>` as the start of a JSX element where TypeScript reads it as a cast, and after one of
  those, TSX cannot see the rest of the file.

  Measured over 424 real `.ts` files, that hid three findings from the TypeScript grammar, including
  a real `try`/`catch` in a file where a template literal made the TSX parser lose its place. Small,
  and a missed violation regardless, which is the one kind of wrong this tool cannot afford.

  `.ts`, `.mts` and `.cts` are now parsed as TypeScript, `.tsx` as TSX, and the `.js` family as
  JavaScript. A rule for a language outside that family — `css`, `html` — keeps its own grammar,
  because a `.css` extension says nothing about which JavaScript parser to use.

  **Two things may change for you.** A repo may see findings it did not before: falsestart's own
  corpus run went from 3,947 to 3,949. And a rule whose pattern is TypeScript-specific, pointed at a
  `.js` file, now **fails loudly** rather than quietly matching nothing — `$X as any` is not a valid
  pattern under the JavaScript grammar. That is the better failure: a rule that cannot run on the
  files it is aimed at should say so.

  Found by hydrating the rules for the upstream ast-grep CLI and comparing the two engines over a
  real corpus. Neither was a superset of the other, and chasing the disagreement found this.

- b83506e: `--list-rules`: print the resolved rule set as JSON, so a repo can assert on it

  `falsestart --list-rules` writes the rule set it actually loaded to stdout as JSON, one rule per
  line, and exits without reading stdin. Resolved, not raw: `--preset` and `--rules pkg:` are resolved
  first and your `falsestart.config.ts` scope overrides are applied, so the globs in the output are
  the ones that will really decide what gets judged rather than the ones the rule shipped with.

  Each entry carries exactly `files`, `id`, `ignores`, `language` and `severity`. The matcher and the
  rule's prose are deliberately absent, so a pattern refactor or a wording fix cannot break an
  assertion written against the document. `files: null` means the rule declares no scope and matches
  every path, which is the opposite of `files: []`. Entries are sorted by id, so two runs diff cleanly
  however the rule tree happens to be laid out on disk. A config's top-level `exclude` is NOT in the
  document: it applies to `scan` rather than to any rule, so pin it by reading your config file. Nor
  are `--exclude` or your `.gitignore`, which narrow what a scan answers for the same way.

  It answers a script rather than the hook protocol, so once it is running it uses `scan`'s exit
  codes: 0 with the document on stdout, 2 when the rule set could not be produced. A refused command
  line still exits 1, the shared code — exit 2 from a `PreToolUse` hook blocks the write, and an
  argument error must never be able to do that. A refused `falsestart scan` keeps exiting 2, as
  before: it is a subcommand at argv[0] and cannot be a stray flag on a hook command line.

  Also exported for use from your own tests: `describeRules(rules)` returns the same entries,
  `ruleListText(rules)` returns the same bytes, and `RuleDescriptionSchema` decodes a document you
  read back.

  This cannot turn a passing repo red. No existing exit code changes, and the only existing invocations
  that change at all are `falsestart scan --doctor` and `scan --version`, whose refusal message now
  names `--list-rules` alongside the other two. `--list-rules` is refused alongside `scan`, `--doctor`, `--version` and
  `--warn-unscoped` rather than quietly ignored, and there is no `--json` flag — the output is JSON
  because that is the only thing this command is for.

- 0410a04: New `effect` rule: `no-effect-assertion` — and it is the first rule that judges your test files.

  **This can turn a previously-passing repo red, including one that changed nothing.** It is `error`
  severity and lives in `effect`, so `--preset effect` and `--preset all` gain it automatically. Unlike
  every other assertion rule it has **no test-file exemption**, so a repo whose sources are clean can
  still go red on a helper in `*.test.ts`.

  It catches asserting a value INTO an Effect type — `x as Effect.Effect<A>`, and the same for
  `Stream`, `Layer`, `Sink`, `Channel`, `Fiber`, `Deferred` and `STM`. Those type parameters are the
  error and requirement channels; asserting into them tells the compiler to stop tracking what can fail
  and what must be provided, and the failure resurfaces at runtime with nothing in the signature that
  predicted it. The usual shape is a pipeline whose inferred error channel is not `never`, cast until
  it compiles:

  ```ts
  const stdout = handle.stdout.pipe(decodeText, mkString) as Effect.Effect<string>
  ```

  That says "this cannot fail" about a stream that can.

  **Why no test exemption, when every other assertion rule has one.** That exemption is real and stays:
  a mock needs `as never` to satisfy a signature it will never honour, and this rule leaves that
  completely alone — asserted as a case, not assumed. But the exemption is a whole-file blanket, and it
  was also waving through coercions that erase an error channel. This was found by falsestart failing
  to do its job on its own repo: three of these reached `main` in test files while the hook was wired,
  running, and correctly allowing them. Piping identical content at two paths through the built binary
  returned `deny` for `src/packaging.ts` and silence for `src/packaging.test.ts`. A helper claiming an
  infallible stream is exactly as wrong as a source file claiming one, and less likely to be read.

  It matches the TYPE being asserted to, never a variable's name and never the expression, so a value
  called `effect` is not the subject. `as const`, `as unknown` and an ordinary `const run:
Effect.Effect<string> = …` annotation are untouched — the annotation is the remedy the message names,
  so it could never be the offence.

  TypeScript-only, like the other five assertion rules: valid JavaScript has no `as` expression to find.

  To keep the old behaviour, scope it away in `falsestart.config.ts`:

  ```ts
  export default {
    rules: { 'no-effect-assertion': { files: ['src/**/*.{ts,tsx,mts,cts}'], ignores: ['**/*.test.*'] } },
  } satisfies FalsestartConfig
  ```

- c2f66ed: `--preset` and `--rules` now combine: one invocation can load a shipped rule set and your own.

  `falsestart --preset clean-code --rules ./.falsestart/rules` was refused before, so "the shipped
  rules plus mine" meant two hook entries with a duplicated matcher. That is not just verbose — both
  entries auto-discover the same `falsestart.config.*`, and an override naming a rule the OTHER entry
  loaded is a hard error, so a repo re-scoping rules from both sets could not have a working config at
  all. Under `--fail closed` that error denies every write in the repository.

  A rule id defined by both sources is **REFUSED**, naming both directories, rather than resolved by
  precedence. Whichever rule lost would carry a `files` glob nobody is enforcing, and "the later source
  wins" would make `--preset all --rules ./r` and the reverse enforce different things. **This can turn
  a previously-passing repo red** in one narrow case: a repo that already vendored a copy of a shipped
  rule under its own id, and now names both sources in one invocation, gets a refusal instead of a
  silent shadowing. Rename the local rule or drop it.

  `--doctor` prints one `rules` row per source rather than one total, because a single number cannot
  answer "did my own rules load, or only the preset?".

  Two things deliberately did not change. Between the two `--rules` forms the package form still wins
  whichever was written first, rather than becoming a third source — the directory in
  `--rules pkg:@acme/rules --rules ./local` was named only to be overridden. And `--preset all` alone
  still loads exactly the preset: the `.falsestart/rules` default applies only when nothing else names
  a source, so a union never quietly adds a directory the caller did not ask for.

  Only the `--rules` source can be frozen: a preset resolves inside `node_modules`, which the
  project's repository does not track. Under the default `--freeze auto` that is unchanged — the
  working tree is read for it, as it always was.

  Under `--freeze require` a preset is **refused**, whether or not a `--rules` directory is named
  alongside it, and that is a deliberate part of this change rather than a side effect. `require`
  means "judge nothing the ref cannot account for". Freezing only the caller's own directory would
  have reported `frozen`, exited 0, and judged with an unverified preset the report never named.
  A preset was already refused under `require` when it was the only source, so no working setup
  changes; what changes is that combining it with `--rules` does not buy an exemption.

  `loadRuleSources`, `mergeRuleSets` and the `RuleGroup`/`RuleSource` types are exported, and
  `RespondOptions`/`DiagnoseOptions` gain an optional `shippedDirectories`. Optional, so a library
  call written before this still compiles unchanged.

- c21b026: `--agent copilot`: read GitHub Copilot CLI's payload, and answer where it looks

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
  `claude-code`. Every parse path and every emit path without the flag is what it was, and no payload
  naming a Claude Code tool changes verdict. Four things do change unconditionally — three of them
  report texts, one of them a verdict on a payload Claude Code does not send:

  - `--doctor` prints an `agent` line on every run. Stated because the previous release's changeset
    made the opposite promise about `--doctor`; the reason is that the person asking "why did my deny
    not block" is by definition the one who never passed `--agent`.
  - `--doctor`'s `tools` line now names each tool's field names —
    `Write (file_path/content)` rather than `Write`.
  - A payload carrying a write tool without the fields to judge now names the keys it DID carry:
    `Write carried no content/file_path to judge (tool_input carried: content)`. Under Copilot that
    clause is what makes a wrong field-name inference diagnosable rather than mysterious; it is
    unconditional because the diagnostic is worth the same on both contracts.
  - **A payload naming `create` or `edit` in the `tool_name`/`tool_input` envelope is no longer
    deferred in silence** under the default agent. It is reported as a misdeclared `--agent`, at exit
    0 with a line on stderr. It never denies, and the notice is produced before the rules source, the
    freeze or the rule tree are touched, so it costs what a deferred call costs. Claude Code ships no
    tool by either name, so this needs a payload from something else speaking that envelope; if you
    have one, that is the point of the notice.
  - **A payload carrying the OTHER contract's envelope now says so.** Without the flag,
    `{"toolName":"edit",…}` used to answer `hook payload carried no tool_name`; it now adds
    `(it carried toolName, which belongs to the copilot contract — did you mean --agent copilot?)`.
    A payload speaking no envelope either contract knows keeps the message it always had.

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

  **One trade, stated.** A refused hook command line naming any `--agent` VALUE other than
  `claude-code` exits **0** rather than 1, including a misspelled or missing value: under Copilot exit
  1 denies, so refusing `--agent copilto --bogus` at exit 1 would be a repository-wide outage rather
  than a message. `falsestart --agent copilot --bogus; echo $?` therefore prints 0. The message is
  still on stderr, and `--doctor` is the answer, as it already is for `--list-rules`.

  Both spellings count: `--agent copilot` and `--agent=copilot` refuse alike, even though the parser
  accepts only the first — refusing the `=` form at exit 1 would have made the likeliest typo in the
  whole flag deny every tool call in the repository.

  **What the Copilot contract does NOT govern.** `--doctor` and `--list-rules` are not the hook path:
  they read no stdin, emit no hook decision, and keep their own codes, so `--doctor` still exits 1 when
  the installation is unhealthy and a refused `--list-rules` still exits 1 rather than handing a
  redirecting script a zero and an empty file.

  **One deliberate exit 1 on the hook path, and its hazard.** The misdeclared-`--agent` notice is
  emitted with the OTHER runtime's emitter, so under `--agent copilot` a Claude Code payload exits 1.
  If the runtime really is Copilot, that denies. A Copilot MCP server or custom tool named `Write`,
  `Edit` or `NotebookEdit` would therefore be denied as "hook errored" with the wrong remedy printed.
  It fails closed rather than open, and it is loud rather than silent, but report it if you hit it —
  the tool table is what would need widening.

  New exports `AGENTS` and `AGENT_CONTRACTS`, and types `AgentId`, `AgentContract`, `Envelope`. New
  optional `RespondOptions.agent`, `DiagnoseOptions.agent`, `DecideOptions.agent`, and an optional
  second parameter on `judgesPayload` — all optional, so no consumer's `tsc` turns red. `scan` and
  `--list-rules` **refuse** `--agent` in either value; no command line that parsed yesterday contains
  it.

- 30d7543: New `falsestart scan [paths…]` command, so violations are caught at pre-commit, pre-push or in CI —
  not only at write time.

  The hook judges a _tool call_. It sees `Edit`, `Write` and `NotebookEdit` and nothing else, so a
  `Bash` heredoc, a `>` redirect, `git checkout`, `git merge`, `git revert`, a person in an editor,
  another agent, and every file that predates the hook being installed all reach disk unexamined.
  `scan` is the second enforcement point that closes it.

  ```yaml
  # lefthook.yml
  pre-push:
    commands:
      falsestart:
        run: node node_modules/@sledorze/falsestart/dist/cli.js scan --preset all {push_files}
  ```

  ```sh
  # .husky/pre-commit
  git diff --cached --name-only --diff-filter=ACM -z |
    node node_modules/@sledorze/falsestart/dist/cli.js scan --preset all -0
  ```

  Use `-z`/`-0` rather than newlines: `git diff --name-only` C-quotes any non-ASCII path, which then
  opens as ENOENT and is silently skipped by the gate meant to check it.

  **Dependencies are never judged.** `node_modules` and `.git` are always excluded, and anything
  `.gitignore` covers is excluded too — asked of `git check-ignore` rather than reimplemented, and
  best-effort so a scan still works without git. Anything else belongs in `falsestart.config.ts` as a top-level `exclude` array — the repository's
  standing policy, stated once instead of repeated in `lefthook.yml`, a husky script and CI, where
  the copies drift. `--exclude <glob>` adds to it for a single run rather than replacing it. `dist/`,
  `build/` and `vendor/` are deliberately not default exclusions, because projects author real source
  in directories with those names. Every exclusion is counted in the summary.

  **Paths come from the caller, never discovered.** Your hook runner already computes the list and
  does it better. One thing worth knowing: `{push_files}` is the whole tree on a branch's _first_
  push, because there is no upstream to diff against.

  **Exit codes are `scan`'s own contract:** `0` clean, `1` findings, `2` could not run. The hook's are
  unchanged. `1` and `2` are distinct because a gate that cannot tell "your code has violations" from
  "the linter is broken" teaches people to reach for `--no-verify`. It also inverts the hook's policy
  on purpose: the hook fails **open**, since a broken rule must not hold every write in the repo
  hostage, while a scan is a gate and fails **closed**, since one that cannot run passes everything
  while looking healthy.

  **It is stricter than the hook.** An `Edit` carries only the text it would introduce, so the hook
  judges what a change adds; a scan parses whole files. Measured over 424 files of real hand-written
  TypeScript, 64% already carry at least one finding. So `--baseline <file>` and `--update-baseline`
  ship with it — accept what is already there once, and only new findings fail afterwards. The
  baseline holds fingerprints rather than line numbers, so a finding that moves is still the same
  finding and reformatting does not churn the file.

  Every run ends with `scanned N file(s), M in scope, K finding(s)`. `M` matters: a bare "no findings"
  is printed by a genuinely clean run, by one whose paths matched no rule, by one given no paths, and
  by `scan` mis-wired as the `PreToolUse` command — where exit 0 with non-JSON on stdout reads as
  "allow" and silently permits every write. When `M` is `0` the report says so outright.

  Also fixes a latent bug this surfaced: `Exit` carried an exit code that nothing read, so every
  non-zero exit was `1` regardless. Invisible while every exit was 1; it would have made the code
  above decorative.

- f06d97e: Ship `CHANGELOG.md` inside the published package, and name it in `--doctor`.

  It was not in the `files` array, so it was not in the tarball. Someone upgrading `0.1.0` → `0.2.0`
  had to `npm pack` both versions and `diff -rq` the `rules/` trees by hand to find out what had
  changed. That is a bad trade for any dependency and a worse one for this one: `0.2.0` added
  `no-empty-catch` and `no-hardcoded-credential`, both `error` severity, both in `clean-code` — so a
  MINOR bump made `--preset clean-code` and `--preset all` strictly stricter, and a repo that passed
  yesterday failed today with nothing in the package to say why. The release notes said all of that
  already; they were simply not shipped.

  `--doctor` now prints a `changes` line under the version, pointing at the changelog in the
  installation it is reporting on:

  ```
  falsestart <the installed version>
  changes  …/CHANGELOG.md — what this version changed, including any rule that is new
  ```

  That is where it belongs rather than only in the tarball, because `--doctor` is what people already
  run to verify an upgrade. The path is anchored on the running module, so it is the changelog for the
  copy every other line in the report describes — not a guess at `node_modules/@sledorze/falsestart`,
  which is not where every package manager puts it.

  The line is printed only when a readable FILE is really there — `stat`, not `exists`, so a directory
  of that name is not mistaken for release notes — and an installation of `0.1.0` or `0.2.0` still
  reports exactly as it did.

  `DiagnoseOptions` gains `changelogPath`, and it is **optional**. That is the whole reason the claim
  below holds: `DiagnoseOptions` is part of the published library surface, so a required field would
  have been a compile error in every existing caller of `diagnose` — a minor bump turning a consumer's
  `tsc` red, which is precisely the surprise this change exists to spare people. Omitting it is a
  supported call that reports no `changes` line.

  No behaviour changes for any judged write, and no previously-passing repo can go red because of this.

- 7f99ffb: Make four things falsestart already does findable, and report one of them.

  `--doctor` now says how many of the loaded rules declare a severity that can block:
  `rules    ./rules — 23 loaded (23 block, 0 advise)`. Both counts print even when one is zero,
  because the reader who needs to know advisory rules exist is precisely the one whose rule set has
  none. The `N loaded` text is unchanged. Its `check` line no longer explains an all-advisory rule set
  as though nothing had forbidden the sample: a rule that matched and advised now says so.

  A rule's `severity` defaults to `error` and only `error` denies a write: a rule declaring `warning`,
  `info` or `hint` is shown to the author as `{"systemMessage": …}` with no `permissionDecision`, and
  the write proceeds. The how-to now shows that output, and states the cost — severity is a field of
  the rule document, so a rule that must block in one tree and advise in another exists twice.

  Running your own `Bash` guard beside falsestart is the intended arrangement, not a workaround: two
  `PreToolUse` entries, and on a tool call falsestart does not judge it emits nothing on either stream
  and exits 0 before its rule tree is read. There is a copyable `settings.json` for it.

  Large rule trees: subdirectories load recursively, ids must be unique across the whole tree, and a
  `_utils/` directory of shared matchers is recognised only at the top level of the tree `--rules`
  names — one nested inside a category is loaded as a rule and fails the whole tree. One invocation
  loads one rule source: `--rules` cannot be combined with `--preset` at all, and where both `--rules`
  forms are given the `pkg:` one wins whatever the order. Layering trees means one hook entry per tree.
  The architecture doc now carries a measured cost model, stamped with the machine and version it was
  measured on.

  Rules that need repository-wide knowledge are a non-goal, stated outright: a rule is evaluated
  against one file's syntax tree, so "flag this unless it is declared somewhere else in the repo" is
  not expressible. A config file is executed, so a rule's scope can be computed at load time; its
  match cannot.

  Corrected in passing: the docs said a `.ts` config cannot resolve a value import. It cannot resolve
  a package or relative one — `node:` builtins do work, which is what makes computing a scope by
  shelling out possible in the typed config format.

### Patch Changes

- 93b35e4: Document how to check that two agent registrations have not drifted apart

  A repository serving both Claude Code and GitHub Copilot CLI registers falsestart twice, in
  `.claude/settings.json` and in `.github/hooks/*.json`. falsestart reads neither: it is invoked BY
  the wiring and never inspects it. `--doctor` cannot close that gap either — it answers "did what I
  registered resolve, and does it block", and reads no repository config at all.

  **Check both runtimes enforce the same thing** in `docs/using-the-hook.md` is a ~100-line script a
  repository owns, built out of the already-exported `AGENTS` and `WRITE_TOOLS` and out of
  `--list-rules`, with the real output of every case it reports. It catches a Copilot registration
  that forgot `--agent copilot` — worse than a missing one, because that denies every tool call in
  the session; a declared runtime whose config holds someone else's guard and not falsestart; a
  Claude Code matcher that never reaches a write tool; an unparseable config, which discards every
  hook in the file and so throws rather than degrading to "no hooks found"; and the drift a presence
  check reports green on — both files registered, `--preset clean-code` in one and `--preset all` in
  the other.

  Absence of a runtime's config stays not-a-finding: a repository with no `.github/hooks/` has said
  nothing about Copilot, and reporting there would be inferring intent. The five answers the check
  gets wrong are tabulated in the doc rather than left to be discovered — two silences, and three
  findings it raises against a repository that is wired correctly, one of which this same page
  recommends the arrangement for.

  No behaviour change, and no new flag — this is prose, and the material it uses was already public.
  `docs/` ships in the package, so it reaches an installed copy only through a release.

- eaebe34: `--freeze` now classifies every rule source independently, and by where its path actually sits.

  `--preset` and `--rules` combine as of the previous release, and the freeze only ever classified one
  of the two. Combined, the preset stopped being classified at all: `--doctor` printed `frozen`, exited
  0, and judged with an unverified rule set the report never mentioned.

  The first attempt at closing that refused under `--freeze require` whenever a preset was named. That
  was a **content-free check wearing a policy hat** — it asked "was a preset named?" rather than "is
  this path outside the repository?" — and it was wrong in both directions. A repository that vendors
  its falsestart install commits those rule documents, and falsestart's own repository is one: it was
  told `rules/clean-code` was "outside the project repository", with six of those documents in
  `git ls-files`. Meanwhile a preset named ALONE was still frozen, so the same directory in the same
  repository was refused with `--rules` and frozen without it.

  Every source now goes through the same `classifyRules` the caller's own directory goes through:

  - a preset in `node_modules` is untracked — the working tree under `auto`, refused under `require`,
    which is what it has always been;
  - a **vendored** preset the repository commits is genuinely frozen and read from the ref, which is
    strictly more than it got before;
  - `--doctor` prints one `shipped` row per preset saying which of the two it is.

  It also fixes a separate silent wrong answer the refusal introduced: it returned before the ref probe
  ran and handed the config classifier no evidence at all. Under `require` with a preset, a **committed
  config was reported as absent and its overrides silently dropped**, an explicit `--config` was
  reported as not committed, and a `--freeze-ref` that does not resolve was reported as `frozen`. Those
  verdicts now come from the probe like every other.

  `FreezeOutcome` gains an optional `shipped`, and `shippedRuleSources` is exported.

- 7204c22: Parse on worker threads, so a scan of many files actually uses more than one core.

  `parseSource` used the synchronous `parse`, which pins every parse to the main thread. That made
  `scan`'s own concurrency setting a fiction: eight fibers, all queued to parse in series. It now uses
  `parseAsync`, which the binding runs on a worker thread.

  Measured over 60 files: 244 ms serialised against 113 ms with the parses in flight. End to end over
  424 files, 2,838 ms to 1,976 ms.

  There is no cost for the single-file case the hook always has — 60 sequential parses measured 250 ms
  asynchronous against 244 ms synchronous, so the dispatch is lost in the noise.

- 18fc4b5: Parse each file once per language instead of once per rule. Roughly 6× faster, with identical
  findings.

  `checkFile` called `findViolations(rule, source)` for every applicable rule, and each of those
  parsed the source again. With the twenty-two shipped rules, every file was parsed twenty-two times
  into twenty-two identical trees.

  Profiled on a 762 KB TypeScript file:

  |                                   |         |
  | --------------------------------- | ------- |
  | parse once                        | 94 ms   |
  | parse 22× (what it did)           | 2046 ms |
  | one match against the parsed tree | 3 ms    |
  | all 22 matches against one tree   | 60 ms   |

  Ninety-seven per cent of the work was re-reading the same source into the same tree. Rules are now
  grouped by the language their matcher is written against, each group parses once, and every rule in
  it runs against the shared tree.

  Measured end to end, same corpus and same rules:

  |           | before    | after    |
  | --------- | --------- | -------- |
  | 424 files | 18,028 ms | 2,733 ms |
  | 20 files  | 1,531 ms  | 290 ms   |

  The findings are byte-identical — 3949 before and after — and the whole existing suite passes
  unchanged, which is what makes this a refactor rather than a behaviour change.

  This matters most on the path that is not benchmarked: the hook runs before **every** tool call an
  agent makes, and that cost is paid in a loop someone is watching. `matcher.ts` gains `parseSource`
  and `findViolationsIn` for callers that want to amortise a parse themselves; `findViolations` is
  unchanged and now composes the two.

- c21b026: Registered at another hook event, falsestart says so instead of emitting a document that is ignored

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

- eaebe34: A hook payload that carries no `cwd` no longer silently disables every repo-relative rule.

  A rule's `files` glob is authored project-relative (`packages/*/src/**/*.ts`) while a hook reports an
  absolute path, so something has to say which prefix to strip. The payload's `cwd` says it — and when
  the payload carried none, the absolute path was matched raw, so every repo-relative glob admitted
  nothing. That failure is total and completely silent: the rule loads, validates, reports on nothing,
  and an unguarded file is indistinguishable from a clean one, in an installation `--doctor` calls
  healthy. It now falls back to the directory falsestart is running in, which is where it resolved your
  rules, your config and the freeze.

  **This can turn a previously-passing repo red**, and that is the point: a rule that starts firing was
  always meant to and never could. It reaches anything driving the hook that does not send `cwd` —
  Claude Code always does, the Copilot envelope is provisional, and a hand-rolled integration may not.

  The payload's `cwd` still **wins** when it names one. That is deliberate and was measured: preferring
  the process directory instead stopped `cd packages/app && falsestart --rules ../../rules` blocking at
  all, turning a deny into exit 0 with nothing on either stream. Both are legitimate anchors and only
  the rule's author knows which their globs were written against, so nothing is silently re-pointed.

  `--doctor` now names the anchor above the scope block — both halves of it, since it reads no payload
  and can only report the fallback:

  ```
  scope
           paths below are matched relative to /repo
           a judged write uses the payload's cwd when it carries one, and this directory when it does not
  ```

  If those two differ, the rule counts below them are not the counts a judged write will get. That
  disagreement is the remaining sharp edge in this area and the report now makes it visible instead of
  leaving it to be discovered.

  `DecideOptions.projectDirectory` is the new optional field, so a library caller written against 0.2.0
  is unchanged.

- e317c8c: `toScopingPath` now normalises `./` prefixes, doubled separators and interior `./` segments, so
  every spelling of a path scopes identically.

  A glob is matched against the literal path string, so `./src/a.ts` matched **nothing** — not even
  `**/*.ts`. Zero findings on a file that should be blocked is indistinguishable from a clean file, so
  the failure was total and completely silent.

  It was latent, because the only caller receives Claude Code's `file_path`, which is always absolute
  and already clean. Any caller that forwards paths hits it immediately — lefthook's `root:` setting,
  the documented way to scope a hook to one package of a monorepo, emits exactly `./src/a.ts`, and so
  does `find . | xargs`. Anyone calling the exported `toScopingPath` from their own tooling was
  affected today.

  `..` is deliberately still not resolved: doing so would require anchoring the path to a real
  directory, and a scoping decision must not depend on the filesystem, or a rule starts behaving
  differently in CI than it does locally.

## 0.2.0

### Minor Changes

- d97f714: `--doctor` now names any rule whose config override covers fewer file extensions than the rule
  ships with, and the same comparison is exported as `findNarrowedScopes`.

  A scope override replaces a rule's `files` rather than merging into them. That is the right
  behaviour — a merge could never remove anything — but it means an override written to add a single
  file exemption has to restate the rule's entire glob, and any extension missing from that
  restatement is silently no longer guarded. Nothing fails, because there is typically no file with
  that extension in the repo yet for anyone to notice going unchecked.

  falsestart's own config had been doing this since the release that added `.mts`/`.cts` coverage:
  two overlooked extensions on `no-type-assertion`, six on `no-json-global`, full test suite green,
  `--doctor` reporting a healthy installation the whole time. The new report is what finally named
  it.

  ```
  config   falsestart.config.ts — 1 override(s): no-try-catch
           no-try-catch stops covering .mts, .cts, .js, .jsx, .mjs, .cjs — the override replaces the rule's own files
  ```

  Reported, never refused, and the exit code is unchanged: narrowing is what overrides are for, and
  only you know whether a particular narrowing was meant. Only the language dimension is compared,
  never directories, because that is where narrowing is almost always an accident of restating a glob
  rather than a decision someone made.

  `findNarrowedScopes(shipped, scoped)` returns the same data if you would rather assert it in your
  own test suite than read it in a report.

- 81a983a: Two new `clean-code` rules: `no-empty-catch` and `no-hardcoded-credential`.

  **This can turn a previously-passing repo red.** Both are `error` severity and both are in
  `clean-code`, so `--preset clean-code` and `--preset all` gain them automatically. They are also the
  first `clean-code` rules that reach JavaScript, so a JavaScript repo using that preset goes from
  being guarded by nothing to being guarded by two rules.

  `no-empty-catch` matches a catch block with nothing in it at all. A block containing a comment is
  deliberately **not** matched: the difference between swallowing an error and deciding to ignore one
  is whether anyone wrote down why, and the comment is that record. It doubles as the escape hatch, so
  the rule needs no configuration to stay out of the way. Under `--preset all` an empty catch also
  trips `no-try-catch`, which forbids try/catch outright — two different objections, kept separate
  because this one exists for repos where try/catch is entirely legitimate.

  `no-hardcoded-credential` matches the **format** of a credential, never the name of the variable
  holding it: AWS access key ids, GitHub tokens, Slack tokens, Stripe live secret keys, and PEM
  private key headers. That distinction is the design. A name-based rule — anything assigned to
  `password`, `apiKey`, `token` — fires on `const field = 'password'`, on form labels, on fixtures and
  on documentation about authentication, and the noise gets it turned off. An issuer-assigned format
  is a structural fact about the value.

  The trade is worth stating plainly: it catches credentials that announce themselves and misses ones
  that do not. A bare `const password = 'hunter2'` is invisible to it, because nothing distinguishes
  that string from any other. It is a floor, not a boundary — pair it with a scanner over history,
  which is a different job from guarding a single write. `sk_test_` keys are ignored; only `sk_live_`
  is a secret.

  Both exempt test files, like every other shipped rule. A fixture full of realistic-looking keys is
  normal, and a rule that blocks writing one is a rule people disable.

- 5ae2a50: Fifteen of the twenty shipped rules now cover JavaScript as well as TypeScript.

  **This can turn a previously-passing repo red, and that is the point of the change.** Any repo
  using `--preset effect` or `--preset all` that writes `.js`, `.jsx`, `.mjs` or `.cjs` files was
  being told nothing about them. Those files are now judged, so writes that always broke a rule will
  start being blocked — not because the rules changed, but because they finally reach the files. A
  JavaScript repo that installed falsestart got a guard that was registered, healthy and completely
  inert; that is what this fixes.

  The widened rules match runtime constructs that exist identically in both languages: `no-await`,
  `no-json-global`, `no-manual-effect-run-in-tests`, `no-new-promise`, `no-process-env`,
  `no-process-exit`, `no-raw-coercion`, `no-raw-error`, `no-raw-fetch`, `no-test-lifecycle-hooks`,
  `no-then-catch`, `no-throwing-decode`, `no-try-catch`, `no-unsafe-api` and `no-vi-mocking`. Each is
  tested against real JavaScript rather than assumed to work there.

  Five rules stay TypeScript-only — `no-as-any`, `no-as-never`, `no-double-cast`,
  `no-type-assertion`, `prefer-smart-constructor` — because valid JavaScript cannot contain an `as`
  expression or a `const x: T = {…}` annotation for them to find. Worth knowing if you were relying
  on the opposite: they are not incapable of firing on a `.js` file, since the parser follows a
  rule's `language: tsx` rather than the file's extension. Scoping them there would claim coverage a
  JavaScript file can never trip.

  To keep the old behaviour, re-scope the rules you want narrowed in `falsestart.config.ts`:

  ```ts
  export default {
    rules: { 'no-try-catch': { files: ['src/**/*.{ts,tsx,mts,cts}'] } },
  } satisfies FalsestartConfig
  ```

  JavaScript's own type assertion, a JSDoc cast like `/** @type {any} */ (value)`, is still caught by
  no shipped rule.

- 461bcea: Add `--warn-unscoped`, which reports a judged write that no rule is scoped to instead of passing it
  in silence.

  Without it, "no rule looked at this file" and "every rule looked and found nothing" are the same
  observable outcome: nothing. A repo can wire the hook up correctly, see it registered and healthy,
  and have it check none of the files being written — the shipped rules match only
  `**/*.{ts,tsx,mts,cts}`, so a JavaScript repo gets a guard that is installed and inert. That is how
  this was found: a probe file carrying a hardcoded credential was written to a `.js` path, went
  through untouched, and was reported as "falsestart does not block".

  The flag is non-blocking and cannot pre-empt a denial — a rule that could block is by definition a
  rule that applies. It does not change any existing decision, so no previously-passing repo can
  start failing because of it.

  It is refused with `--doctor` rather than accepted and ignored: `--doctor` reads no payload to
  report on, and its scope block already prints a rule count per probed path, where a `0` is the same
  fact this flag reports at write time.

  It is off by default because the signal is noisy, and that is worth knowing before turning it on.
  Measured against the shipped presets, it fires on every `.md`, `.json`, `.yml` and `.js` write
  under all three, and on test files under `clean-code` only — whose four rules all ignore them,
  while `effect` carries three rules that exist to judge them.

### Patch Changes

- 87c9da0: Correct the install instructions, which predated the first release and told you to install
  something else.

  The README said the package was `private: true` and to install a `0.0.1` tarball packed from a
  checkout. Both stopped being true when `0.1.0` was published. Someone followed the published
  instructions, ended up with a pre-implementation copy in `node_modules`, and reported that
  falsestart blocked nothing — the tool and their hook wiring were both fine. The command is now
  `pnpm add -D @sledorze/falsestart`.

  This is a documentation change that needs a release to have any effect: `README.md` and `docs/` are
  inside the published `files` array, so until this ships, npm keeps serving the instructions that
  caused the problem.

  Two smaller corrections in the same area. The claim that installing falsestart also installs
  `effect` was true for npm and false for pnpm, which is the package manager the README's own command
  uses — and the cause was misattributed to `effect` being a peer, when pnpm's isolated
  `node_modules` omits ordinary dependencies such as `picomatch` just the same. And the `--doctor`
  sample output showed `falsestart 0.0.1`, so the one line that would have exposed a stale install
  was itself printed as though the stale version were expected; it is now elided rather than pinned
  to a number that goes stale at every release.

## 0.1.0

### Minor Changes

- aa0b31b: First release.

  falsestart runs as a Claude Code `PreToolUse` hook and blocks risky code patterns at the moment an
  agent writes them, before the file lands. Rules are [ast-grep](https://ast-grep.github.io)
  documents, so the same file stays readable by the upstream CLI.

  **Twenty rules, in two presets.** `clean-code` is four TypeScript rules and assumes nothing else:
  `no-as-any`, `no-as-never`, `no-double-cast`, `no-type-assertion`. `effect` is sixteen that assume
  an Effect codebase — they forbid `await`, `try/catch`, `new Promise`, `.then`, `JSON.parse`,
  `fetch`, `process.env`, `process.exit`, raw `Error`, raw coercion, Effect's `Unsafe`/`OrThrow`
  escape hatches and its throwing `Sync` decoders, plus three that apply only to test files. Pick
  deliberately: on an ordinary async function `--preset all` produces seven blocks, which is correct
  in an Effect repo and wrong everywhere else. Every rule is `error` severity and scoped to
  `**/*.{ts,tsx,mts,cts}`.

  **Rules from anywhere.** `--preset <name>` for the shipped set, `--rules <dir>` for your own,
  `--rules pkg:@acme/falsestart-rules` for another package's.

  **Per-repo scoping without editing rules.** `falsestart.config.{ts,mts,js,mjs,json}` re-scopes any
  loaded rule's `files`/`ignores`. A TypeScript config is type-checked against the exported
  `FalsestartConfig`, so a mistyped rule id is a compile error in your editor. An override naming a
  rule that is not loaded is an error rather than a no-op.

  **`--doctor`.** Every misconfiguration a hook can have degrades to the same place — exit 1, a line
  on stderr the runtime swallows, and the write proceeding — so a hook that enforces nothing looks
  exactly like one with nothing to say. `--doctor` reports what was resolved, how many rules reach
  each of five probe paths, and sends a real violation through the real decision path. Read the scope
  block: a nested probe path is what exposes a `src/**.ts` glob that guards top-level files only.

  **Also exported as a library**, for building your own checks: `checkFile`, `loadRules`, `parseRule`,
  `appliesTo`, `decide`, `respond`, `diagnose`, config helpers and the rule-authoring test helpers.

  ### Known limits, stated rather than discovered
  - **`Bash` is not judged.** falsestart inspects the text a write tool carries, so a heredoc or shell
    redirect writes a file it never sees. A guard rail, not a sandbox.
  - **Matching is syntactic.** `import { Chunk as C }` then `C.headUnsafe(c)` is not matched; a local
    object named `Chunk` is. Rules record spellings, not APIs.
  - **`.js`, `.jsx`, `.mjs`, `.cjs` are excluded by design.** The assertion rules match syntax that
    does not exist in JavaScript, and `.js` in a TypeScript repo is usually generated or build code.
  - **A `.ts` config is type-stripped and imported without a filesystem location**, so it may use
    type-only imports but not value imports. Use `.mjs` if you want the `makeConfigUnsafe` smart
    constructor.
  - **`no-unsafe-api` covers the root `effect` import only.** Twenty-one risky APIs live in
    `effect/unstable/*` subpaths and are not matched; widening would pull in `Headers` and `Worker`,
    which are ordinary identifiers.
