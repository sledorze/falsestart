# Reference

Every flag, export and shipped rule. For why any of it is shaped this way see
[Why falsestart is built this way](./architecture.md); to set it up see
[Using the hook](./using-the-hook.md).

## Command line

| Flag                 | Meaning                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--preset <name>`    | Use rules shipped with falsestart: `all`, `clean-code`, `effect`. Mutually exclusive with `--rules`.                                      |
| `--rules <dir>`      | A directory of rule documents, searched recursively. Defaults to `.falsestart/rules`.                                                     |
| `--rules pkg:<name>` | Rules from an installed package, e.g. `pkg:@acme/falsestart-rules`, optionally with a subdirectory.                                       |
| `--config <file>`    | Scope overrides. Defaults to `falsestart.config.{ts,mts,js,mjs,json}` in the process's working directory, without searching upward.       |
| `--doctor`           | Report what falsestart resolved and prove the pipeline end to end. Reads no stdin; exits 1 if anything did not resolve.                   |
| `--warn-unscoped`    | Report a judged write that no rule is scoped to, instead of passing it in silence. Non-blocking, off by default, refused with `--doctor`. |
| `--version`          | Print the version. Exits 0 without reading stdin.                                                                                         |
| `-h`, `--help`       | Usage. Exits 0 without reading stdin.                                                                                                     |

### `falsestart scan [paths…]`

Judges files already on disk, for a git hook or CI. A different contract from the hook in both
directions — paths in, a report out, and exit codes a shell can read.

| Flag                | Meaning                                                                     |
| ------------------- | --------------------------------------------------------------------------- |
| `paths…`            | Files to judge. Supplied by the caller; falsestart never discovers them.    |
| `-` / `-0`          | Read paths from stdin, newline- or NUL-delimited. Use `-0` with `git … -z`. |
| `--baseline <file>` | Findings already accepted. Absent file means an empty baseline.             |
| `--update-baseline` | Write every current finding to `--baseline` and exit without failing.       |

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

This also inverts the hook's policy deliberately. The hook fails **open** — a rule that cannot run
must not hold every write in the repo hostage. A scan is a gate and fails **closed**: one that
cannot run has to stop, or it passes everything while looking healthy.

### Judged tool calls

falsestart inspects the content a tool call is about to write. Three tool names carry that, and
anything else is allowed in silence:

| `tool_name`    | path field      | content field |
| -------------- | --------------- | ------------- |
| `Write`        | `file_path`     | `content`     |
| `Edit`         | `file_path`     | `new_string`  |
| `NotebookEdit` | `notebook_path` | `new_source`  |

That is the complete set of Claude Code built-ins that carry file content — there is no `MultiEdit`.
A tool name outside this table produces no output and exit 0, indistinguishable from a clean write,
so a future write tool would be unguarded without any signal. The list is asserted against the code
by a test rather than maintained here by hand.

`Bash` is deliberately absent. falsestart judges the text a write tool carries, so a heredoc or a
shell redirect writes a file it never sees. That is a real hole, not an oversight: judging shell
commands would mean predicting what they do.

### Exit codes

| Code                 | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `0` + JSON on stdout | A decision. This is how a block is expressed.                      |
| `0` + no output      | No decision; the normal permission flow applies.                   |
| `1`                  | falsestart could not do its job. Reported, and the write proceeds. |

Blocking is deliberately **not** exit 2: exit 2 does block, but the runtime discards stdout and
reads stderr as the reason, throwing away the structured decision.

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

Documents under a `_utils/` directory in the rule tree are fragments, not rules: they need only
`id` and `rule`, never match alone, and lose a name collision to a rule's own `utils`.

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
An override naming a rule that is not loaded is an error, not a no-op. Use a **type-only** import in
a `.ts` config — it is type-stripped and imported without a filesystem location, so a value import
cannot resolve. `.mjs` configs may import anything, including `makeConfigUnsafe`.

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

Seventeen of the twenty-two rules are scoped to `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` — every TypeScript
and JavaScript extension, with `*.test.*`, `*.spec.*` and `*.bench.*` variants exempt (the three
test-only rules invert that). They match runtime constructs — `try`, `await`, `process.env`,
`fetch`, `new Promise`, `JSON.parse` — which JavaScript has just as much as TypeScript does, and
each is tested against real JavaScript rather than assumed to work there.

Five stay TypeScript-only: `no-as-any`, `no-as-never`, `no-double-cast`, `no-type-assertion` and
`prefer-smart-constructor`. Not because they cannot fire on a `.js` file — every rule declares
`language: tsx`, the parser is picked by that rather than by the extension, and all five do fire on
TypeScript syntax at a `.js` path. It is that **valid JavaScript cannot contain what they match**:
there is no `as` expression and no `const $NAME: $TYPE = {…}` annotation to find. Scoping them to
`.js` would claim coverage that a JavaScript file can never trip, and would silence
[`--warn-unscoped`](./using-the-hook.md) for a `clean-code`-only JavaScript repo — telling it it is
guarded when nothing there can fire. A test asserts both directions.

One gap this leaves, named rather than implied: JavaScript's own way of asserting a type is a JSDoc
cast (`/** @type {any} */ (value)`), and no shipped rule catches it.

All 22 rules are `error` severity, so every rule blocks. Rules in `clean-code` assume nothing beyond
TypeScript; those in `effect` assume an Effect codebase. `no-vi-mocking`, `no-test-lifecycle-hooks` and
`no-manual-effect-run-in-tests` apply **only** to test files — the inverse of every other rule.

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
| `MatchError`                | error class | checking |
| `RuleLoadError`             | error class | checking |
| `RuleParseError`            | error class | checking |
| `SEVERITIES`                | constant    | checking |
| `SHIPPED_RULE_IDS`          | constant    | checking |
| `SUPPORTED_LANGUAGES`       | constant    | checking |
| `appliesTo`                 | function    | checking |
| `extensionGlobGroup`        | function    | checking |
| `applyScopeOverrides`       | function    | config   |
| `assessRule`                | function    | testing  |
| `checkFile`                 | function    | checking |
| `WRITE_TOOLS`               | constant    | hook     |
| `decide`                    | function    | hook     |
| `diagnose`                  | function    | hook     |
| `findDefaultConfigs`        | function    | config   |
| `findNarrowedScopes`        | function    | config   |
| `findUntestedRules`         | function    | testing  |
| `findViolations`            | function    | checking |
| `judgesPayload`             | function    | hook     |
| `loadConfigFile`            | function    | config   |
| `loadDefaultConfig`         | function    | config   |
| `loadRules`                 | function    | checking |
| `makeConfig`                | function    | config   |
| `makeConfigUnsafe`          | function    | config   |
| `parseConfig`               | function    | config   |
| `parseRule`                 | function    | checking |
| `respond`                   | function    | hook     |
| `scan`                      | function    | scanning |
| `render`                    | function    | scanning |
| `partitionPaths`            | function    | scanning |
| `fingerprint`               | function    | scanning |
| `samplePath`                | function    | checking |
| `toScopingPath`             | function    | checking |
| `validateConfig`            | function    | config   |

The extension lists `TYPESCRIPT_EXTENSIONS`, `JAVASCRIPT_EXTENSIONS` and `SOURCE_EXTENSIONS` are
exported too, with `extensionGlobGroup` to build the `{ts,tsx,…}` alternation from one of them. A
rules package faces the same restatement problem falsestart does — four globs per rule, and a
missing entry is silent — so the list it must agree with is importable rather than copied.

Types are exported alongside these: `Rule`, `Finding`, `Violation`, `Decision`, `DecideOptions`,
`Diagnosis`, `DiagnoseOptions`, `Config`, `FalsestartConfig`, `ScopeOverride`, `NarrowedScope`,
`HookResponse`, `RespondOptions`, `ScanOptions`, `ScanReport`, `ScannedFile`, `ScanOutcome`, `Exclusion`, `ExclusionReason`,
`Partitioned`, `PartitionOptions`,
`Language`, `Severity`, `RuleConstraint`, `FileScope`, `FileUnderCheck`, `ShippedRuleId`,
`RuleExpectation`, `CaseResult`, `Identified`.

`Options` and `Preset` are **not** exported: `src/index.ts` re-exports the `checking`, `config`,
`hook` and `testing` entry points, and argument parsing is the CLI's own business.

`effect` is a required peer dependency; `@effect/platform-node` is optional, needed only for the
helpers that touch the filesystem.
