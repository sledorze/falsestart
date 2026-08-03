# Reference

Every flag, export and shipped rule. For why any of it is shaped this way see
[Why falsestart is built this way](./architecture.md); to set it up see
[Using the hook](./using-the-hook.md).

## Command line

| Flag                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--preset <name>`    | Use rules shipped with falsestart: `all`, `clean-code`, `effect`. Mutually exclusive with `--rules`.                                |
| `--rules <dir>`      | A directory of rule documents, searched recursively. Defaults to `.falsestart/rules`.                                               |
| `--rules pkg:<name>` | Rules from an installed package, e.g. `pkg:@acme/falsestart-rules`, optionally with a subdirectory.                                 |
| `--config <file>`    | Scope overrides. Defaults to `falsestart.config.{ts,mts,js,mjs,json}` in the process's working directory, without searching upward. |
| `--doctor`           | Report what falsestart resolved and prove the pipeline end to end. Reads no stdin; exits 1 if anything did not resolve.             |
| `--version`          | Print the version. Exits 0 without reading stdin.                                                                                   |
| `-h`, `--help`       | Usage. Exits 0 without reading stdin.                                                                                               |

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

`files` is required in an override; `ignores` is optional and, when omitted, the rule keeps its own.
An override naming a rule that is not loaded is an error, not a no-op. Use a **type-only** import in
a `.ts` config — it is type-stripped and imported without a filesystem location, so a value import
cannot resolve. `.mjs` configs may import anything, including `makeConfigUnsafe`.

## Shipped rules

| Rule                            | Set        | Catches                                                                                         |
| ------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `no-as-any`                     | clean-code | `as any` erases the type rather than establishing it. Narrow with a type…                       |
| `no-as-never`                   | clean-code | `as never` silences an exhaustiveness error without resolving it. Handle…                       |
| `no-double-cast`                | clean-code | Casting through `unknown` defeats every check the compiler would have ma…                       |
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

Every shipped rule is scoped to `**/*.{ts,tsx,mts,cts}` — all four TypeScript extensions, with
`*.test.*`, `*.spec.*` and `*.bench.*` variants exempt (the three test-only rules invert that).

`.js`, `.jsx`, `.mjs` and `.cjs` are **not** matched, deliberately. The four assertion rules match
syntax that does not exist in JavaScript, and a `.js` file in a TypeScript repo is usually a build
script or generated output. A repo that wants them adds a `files` override for the rules it cares
about; that is one line, and easier to reach for than to undo being silently guarded. A test asserts
both halves of this.

All 20 rules are `error` severity, so every rule blocks. Rules in `clean-code` assume nothing beyond
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
| `applyScopeOverrides`       | function    | config   |
| `assessRule`                | function    | testing  |
| `checkFile`                 | function    | checking |
| `WRITE_TOOLS`               | constant    | hook     |
| `decide`                    | function    | hook     |
| `diagnose`                  | function    | hook     |
| `findDefaultConfigs`        | function    | config   |
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
| `toScopingPath`             | function    | checking |
| `validateConfig`            | function    | config   |

Types are exported alongside these: `Rule`, `Finding`, `Violation`, `Decision`, `Diagnosis`,
`DiagnoseOptions`, `Config`, `FalsestartConfig`, `ScopeOverride`, `HookResponse`, `RespondOptions`,
`Language`, `Severity`, `RuleConstraint`, `FileScope`, `FileUnderCheck`, `ShippedRuleId`,
`RuleExpectation`, `CaseResult`, `Identified`.

`Options` and `Preset` are **not** exported: `src/index.ts` re-exports the `checking`, `config`,
`hook` and `testing` entry points, and argument parsing is the CLI's own business.

`effect` is a required peer dependency; `@effect/platform-node` is optional, needed only for the
helpers that touch the filesystem.
