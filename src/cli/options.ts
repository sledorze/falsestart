/**
 * Reading the command line.
 *
 * Separate from `cli.ts` so it can be tested directly. Argument handling is exactly the sort of
 * code that looks obviously correct and is not, and it decides WHICH rules run — a mistake here
 * substitutes one rule set for another while everything continues to look healthy.
 *
 * Nothing is accepted silently. An unrecognised flag or a `--rules` with no directory is refused
 * rather than degraded to the default, because a misconfiguration that still runs is a guard whose
 * author believes it is enforcing something it is not.
 */

/** Where rules live when the caller does not say. */
export const DEFAULT_RULES_DIRECTORY = '.falsestart/rules'

/**
 * Absent means "look for the default names next to the rules". Optional, unlike the rule tree: a
 * repo with nothing to re-scope needs no config file at all.
 */
export const NO_EXPLICIT_CONFIG = undefined

/**
 * The rule sets falsestart ships, addressable without knowing where npm put them.
 *
 * Without this the only way to use the packaged rules is to write
 * `--rules node_modules/@sledorze/falsestart/rules` by hand — a path that appears in no
 * documentation, breaks under pnpm's layout, and is nobody's idea of getting started.
 */
export const PRESETS = ['all', 'clean-code', 'effect'] as const

/**
 * Marks a `--rules` value as a package rather than a directory.
 *
 * A prefix rather than a guess: `--rules rules` has always meant the `rules/` directory here, and
 * quietly reinterpreting a bare name as a package would change what an existing invocation loads.
 * Rule sets are the thing this tool enforces — resolving a different one than the caller named is
 * the worst failure available to it.
 */
export const PACKAGE_PREFIX = 'pkg:'

export type Preset = (typeof PRESETS)[number]

export type Options =
  | { readonly _tag: 'Help'; readonly text: string }
  | { readonly _tag: 'Invalid'; readonly problem: string }
  | { readonly _tag: 'Version' }
  | {
      /** Same resolution as `Run`, but reports what it resolved instead of judging a payload. */
      readonly _tag: 'Doctor'
      readonly configPath: string | undefined
      readonly preset: Preset | undefined
      readonly rulesPackage: string | undefined
      readonly rulesDirectory: string
    }
  | {
      /**
       * Same resolution as `Run`, reported as a document rather than used to judge one. Reads no
       * stdin, for the same reason `--doctor` does not: it is a question about the installation.
       */
      readonly _tag: 'ListRules'
      readonly configPath: string | undefined
      readonly preset: Preset | undefined
      readonly rulesPackage: string | undefined
      readonly rulesDirectory: string
    }
  | {
      /**
       * Judge files already on disk. A different contract in and out: paths in, a report out, and
       * exit codes a shell can read rather than the hook protocol's.
       */
      readonly _tag: 'Scan'
      readonly baselinePath: string | undefined
      readonly configPath: string | undefined
      /** `Argv` when paths were given as arguments; the delimiter when they arrive on stdin. */
      readonly exclude: readonly string[]
      readonly pathSource: 'Argv' | 'Newline' | 'Nul'
      readonly paths: readonly string[]
      readonly preset: Preset | undefined
      readonly rulesPackage: string | undefined
      readonly rulesDirectory: string
      readonly writeBaseline: boolean
    }
  | {
      readonly _tag: 'Run'
      readonly configPath: string | undefined
      /** Set when `--preset` was used; the caller resolves it against the installed package. */
      readonly preset: Preset | undefined
      /** Set when `--rules pkg:<name>` was used; the caller resolves it against the project. */
      readonly rulesPackage: string | undefined
      readonly rulesDirectory: string
      /** Report judged writes that land where no rule is scoped. See `DecideOptions`. */
      readonly warnUnscoped: boolean
    }

const USAGE = `falsestart — block risky code patterns as they are written

Reads a Claude Code PreToolUse hook payload on stdin and answers with a decision.

Usage:
  falsestart [--rules <dir>]

Options:
  --rules <dir>   Directory of ast-grep rule documents, searched recursively.
                  Defaults to ${DEFAULT_RULES_DIRECTORY}.
  --preset <name> Use rules shipped with falsestart: all, clean-code, effect.
                  Mutually exclusive with --rules.
  --rules pkg:<n> Use rules from an installed package, e.g.
                  --rules pkg:@acme/falsestart-rules, or a subdirectory of
                  its rules with pkg:@acme/falsestart-rules/strict. The
                  package is expected to keep them in a rules/ directory,
                  as this one does.
  --config <file> Per-repo scope overrides (.ts, .mts, .js, .mjs or .json).
                  Optional; without it falsestart looks for
                  falsestart.config.{ts,mts,js,mjs,json} and proceeds with no
                  overrides if none is present.
  --doctor        Report what falsestart resolved — rules, config, per-path
                  rule counts — then send a real violation through the
                  decision path. Reads no stdin. Exits 1 when a step did not
                  resolve or the sample could not be judged. Use this to
                  check a hook is actually guarding something.
  --list-rules    Print the resolved rule set as JSON on stdout and exit —
                  after --preset/pkg: resolution and after config scope
                  overrides, so the globs are the ones that will really
                  decide what gets judged. One rule per line, sorted by id.
                  Reads no stdin. The output is JSON and only JSON; there is
                  no --json flag. Refused with scan, --doctor, --version and
                  --warn-unscoped. It does NOT report the config's top-level
                  \`exclude\`, which applies to scan rather than to a rule.
  --warn-unscoped Report a judged write that lands on a path no rule is
                  scoped to, instead of passing it in silence. Non-blocking.
                  Off by default: with the shipped rules it fires on every
                  .md, .json, .yml and .js write, and a warning you see on
                  most writes is one you stop reading. Turn it on when a
                  write you expected to be blocked was not. Refused with
                  --doctor, which reads no payload to report on and whose
                  scope block already gives a rule count per probed path.
  --version       Print the version.
  -h, --help      Show this message.

Config format (falsestart.config.ts):
  import type { FalsestartConfig } from '@sledorze/falsestart'

  export default {
    rules: { 'no-as-any': { files: ['src/domain/**/*.ts'] } },
  } satisfies FalsestartConfig

  files is required; ignores is optional and, when omitted, the rule
  keeps its own.

Exit codes:
  0  Decision made (JSON on stdout to block) or nothing to say.
  1  falsestart could not do its job, or the command line was refused.
     Reported, and the write proceeds.

  --list-rules answers a script rather than the hook protocol, so once it is
  running it uses \`scan\`'s codes:
  0  The rule set is on stdout.
  2  It could not be produced — unreadable rule tree, a config that would not
     load, a rules package that would not resolve.

  A REFUSED hook command line still exits 1, not 2, whatever flags it named:
  exit 2 from a PreToolUse hook blocks the write, and an argument error must
  never be able to do that. \`scan\` is the exception and earns it — a
  subcommand at argv[0] cannot be a stray flag on a hook command line — so a
  refused \`scan\` exits 2, as it always has.`

const SCAN_USAGE = `falsestart scan — judge files that are already on disk

For a git hook or CI, where the write-time hook cannot reach: a Bash heredoc,
a shell redirect, git checkout/merge/revert, an editor, another agent, and
every file that predates the hook being installed.

Usage:
  falsestart scan [options] <path>...
  <producer> | falsestart scan [options] -0

Paths come from you. Your hook runner already computes the list:
  lefthook:  run: falsestart scan --preset all {push_files}
  husky:     git diff --cached --name-only --diff-filter=ACM -z |
               falsestart scan --preset all -0

Options:
  <path>...            Files to judge.
  -0                   Read NUL-delimited paths from stdin. Pair with git -z:
                       git quotes non-ASCII paths, and a quoted path opens as
                       ENOENT and is silently skipped by the gate.
  -                    Read newline-delimited paths from stdin.
  --baseline <file>    Findings already accepted. A missing file means none are;
                       an unreadable one is an error, not an empty baseline.
  --exclude <glob>     Leave these paths alone. Repeatable. node_modules and
                       .git are always excluded; dist/ and build/ are NOT,
                       because plenty of repos author real source there.
  --update-baseline    Write every current finding to --baseline and exit 0
                       without failing. A maintenance step, not a gate.
  --preset <name>      all, clean-code, effect.
  --rules <dir>        Your own rule directory, or pkg:<name>.
  --config <file>      Per-repo scope overrides.

Exit codes:
  0  No findings.
  1  Findings. The commit or push should stop.
  2  falsestart could not run — broken rules, unreadable path, bad flag.

  1 and 2 are distinct on purpose: a gate that cannot tell "your code has
  violations" from "the linter is broken" is one people learn to bypass.

Every run ends with: scanned N file(s), M in scope, K finding(s)
Read M. A run that examined nothing otherwise looks exactly like a clean one.

Judging whole files makes this STRICTER than the hook, which only sees the
text a change introduces. Use --update-baseline once to accept what is
already there.`

// `PRESETS.includes(value)` needs the tuple widened to `readonly string[]`, and widening by
// assertion is exactly what `no-type-assertion` objects to. A comparison needs no widening.
const isPreset = (value: string): value is Preset => PRESETS.some((preset) => preset === value)

export const parseArguments = (args: readonly string[]): Options => {
  if (args.includes('--help') || args.includes('-h')) {
    // `scan` has its own flags and its own exit codes, and printing the hook's usage for it
    // documented neither. A reader asking a command for its usage and being handed a different
    // command's is worse than terse help.
    return { _tag: 'Help', text: args[0] === 'scan' ? SCAN_USAGE : USAGE }
  }

  // `args[0]` and nowhere else. "Positionals are allowed once `scan` is seen" would admit
  // `falsestart my-rules scan`, and this module's whole argument is that a misconfiguration which
  // still runs is worse than one that refuses.
  const scanning = args[0] === 'scan'
  const rest = scanning ? args.slice(1) : args

  let rulesDirectory = DEFAULT_RULES_DIRECTORY
  let configPath: string | undefined = NO_EXPLICIT_CONFIG
  let preset: Preset | undefined
  let rulesPackage: string | undefined
  let sawRules = false
  let doctor = false
  let listRules = false
  let version = false
  let warnUnscoped = false

  let baselinePath: string | undefined
  const exclude: string[] = []
  let writeBaseline = false
  let pathSource: 'Argv' | 'Newline' | 'Nul' = 'Argv'
  const paths: string[] = []

  // `entries()` rather than an index loop: it yields a defined element, so there is no
  // possibly-undefined fallback branch that no input can ever reach.
  let consumedValue = false

  for (const [index, argument] of rest.entries()) {
    if (consumedValue) {
      consumedValue = false
      continue
    }

    // Valueless flags, handled before a value is read. `--version` is NOT short-circuited ahead of
    // the loop: doing that made `--rules --version` print a version for a command whose value was
    // forgotten, and `--bogus --version` exit 0 on an unrecognised flag.
    if (argument === '--doctor') {
      doctor = true
      continue
    }

    // Read before the `if (scanning)` block below, so `scan --list-rules` reaches the precise
    // refusal further down instead of the generic `unrecognised argument`.
    if (argument === '--list-rules') {
      listRules = true
      continue
    }

    if (argument === '--version') {
      version = true
      continue
    }

    if (argument === '--warn-unscoped') {
      warnUnscoped = true
      continue
    }

    if (scanning) {
      // Paths on stdin, delimited. `-0` is what the documented recipe uses, because
      // `git diff --name-only` C-quotes any non-ASCII path — `src/café.ts` arrives as the literal
      // bytes `"src/caf\303\251.ts"` and opens as ENOENT. `-z` on the git side and `-0` here is
      // the only pairing that survives a filename someone actually has.
      if (argument === '-0' || argument === '-') {
        pathSource = argument === '-0' ? 'Nul' : 'Newline'
        continue
      }

      if (argument === '--update-baseline') {
        writeBaseline = true
        continue
      }

      // A bare word is a path to judge. Only in scan, and only after `scan` was `args[0]`.
      if (!argument.startsWith('-')) {
        paths.push(argument)
        continue
      }
    }

    if (
      argument !== '--rules' &&
      argument !== '--config' &&
      argument !== '--preset' &&
      argument !== '--baseline' &&
      argument !== '--exclude'
    ) {
      return { _tag: 'Invalid', problem: `unrecognised argument: ${argument}` }
    }

    const value = rest[index + 1]
    // A flag-shaped value means the real value was forgotten. Swallowing it silently ran the
    // judging path with the default rule set AND consumed the next flag, so `--rules --doctor`
    // waited on a payload that was never coming — a hang with no output at all. Single dash counts:
    // `-h` is a documented flag, and `--rules -x` hung exactly the same way.
    if (value === undefined || value.startsWith('-')) {
      return { _tag: 'Invalid', problem: `${argument} needs a value` }
    }

    if (argument === '--rules') {
      sawRules = true
      if (value.startsWith(PACKAGE_PREFIX)) {
        const specifier = value.slice(PACKAGE_PREFIX.length)
        if (specifier.length === 0) {
          return { _tag: 'Invalid', problem: `${PACKAGE_PREFIX} needs a package name` }
        }
        rulesPackage = specifier
      } else {
        rulesDirectory = value
      }
    } else if (argument === '--config') {
      configPath = value
    } else if (argument === '--baseline') {
      baselinePath = value
    } else if (argument === '--exclude') {
      exclude.push(value)
    } else if (isPreset(value)) {
      preset = value
    } else {
      return { _tag: 'Invalid', problem: `unknown preset: ${value} (expected ${PRESETS.join(', ')})` }
    }
    consumedValue = true
  }

  // Refused rather than ranked: silently preferring one when both are given would run a different
  // rule set than the caller named, which is the failure this tool exists to prevent.
  if (preset !== undefined && sawRules) {
    return { _tag: 'Invalid', problem: '--preset and --rules cannot be combined' }
  }

  // Refused for the same reason, one step milder. `--warn-unscoped` reports on the path a real
  // payload carries, and `--doctor` reads no payload — so accepting both meant taking a flag and
  // doing nothing with it, which this file's own opening paragraph forbids. The information is not
  // missing from `--doctor`: its scope block already prints a rule count per probed path, and `0`
  // there is the same fact this flag reports at write time.
  // Every flag that means nothing in the mode it was given is refused rather than ignored. A flag
  // accepted and dropped is the failure this file's opening paragraph exists to prevent, and one of
  // them shipped once already.
  if (!scanning && (baselinePath !== undefined || writeBaseline || exclude.length > 0 || paths.length > 0)) {
    return {
      _tag: 'Invalid',
      problem: '--baseline, --update-baseline, --exclude and file paths require the `scan` command',
    }
  }

  if (scanning && (doctor || listRules || version)) {
    return { _tag: 'Invalid', problem: '`scan` cannot be combined with --doctor, --list-rules or --version' }
  }

  if (scanning && warnUnscoped) {
    // Every path a caller hands over is passed whether or not a rule covers it — a commit includes
    // `.md` and lockfiles — so per-file "nothing is scoped here" would fire on most of them. The
    // aggregate is the number that matters and the report always prints it.
    return {
      _tag: 'Invalid',
      problem: '--warn-unscoped has no effect with `scan`; its report always states how many files were in scope',
    }
  }

  if (writeBaseline && baselinePath === undefined) {
    return { _tag: 'Invalid', problem: '--update-baseline needs --baseline <file> to write to' }
  }

  if (doctor && warnUnscoped) {
    return {
      _tag: 'Invalid',
      problem: '--warn-unscoped has no effect with --doctor; its scope block already reports per-path rule counts',
    }
  }

  // Two report modes in one process: whichever won, the other flag would have been taken and
  // dropped. `--doctor --version` predates this and is deliberately left alone — changing an
  // existing flag's behaviour is a separate change.
  if (listRules && (doctor || version)) {
    return { _tag: 'Invalid', problem: '--list-rules cannot be combined with --doctor or --version' }
  }

  // Refused for the reason `--doctor` refuses it: there is no payload to report an unscoped write
  // for. The information is not missing — the listing states every rule's effective files and
  // ignores, which is the same fact in a stronger form.
  if (listRules && warnUnscoped) {
    return {
      _tag: 'Invalid',
      problem: "--warn-unscoped has no effect with --list-rules; the listing states every rule's files and ignores",
    }
  }

  if (version) {
    return { _tag: 'Version' }
  }

  if (scanning) {
    return {
      _tag: 'Scan',
      baselinePath,
      configPath,
      exclude,
      pathSource,
      paths,
      preset,
      rulesDirectory,
      rulesPackage,
      writeBaseline,
    }
  }

  if (listRules) {
    return { _tag: 'ListRules', configPath, preset, rulesDirectory, rulesPackage }
  }

  return doctor
    ? { _tag: 'Doctor', configPath, preset, rulesDirectory, rulesPackage }
    : { _tag: 'Run', configPath, preset, rulesDirectory, rulesPackage, warnUnscoped }
}
