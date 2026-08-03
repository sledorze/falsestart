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
      readonly _tag: 'Run'
      readonly configPath: string | undefined
      /** Set when `--preset` was used; the caller resolves it against the installed package. */
      readonly preset: Preset | undefined
      /** Set when `--rules pkg:<name>` was used; the caller resolves it against the project. */
      readonly rulesPackage: string | undefined
      readonly rulesDirectory: string
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
  1  falsestart could not do its job. Reported, and the write proceeds.`

// `PRESETS.includes(value)` needs the tuple widened to `readonly string[]`, and widening by
// assertion is exactly what `no-type-assertion` objects to. A comparison needs no widening.
const isPreset = (value: string): value is Preset => PRESETS.some((preset) => preset === value)

export const parseArguments = (args: readonly string[]): Options => {
  if (args.includes('--help') || args.includes('-h')) {
    return { _tag: 'Help', text: USAGE }
  }

  let rulesDirectory = DEFAULT_RULES_DIRECTORY
  let configPath: string | undefined = NO_EXPLICIT_CONFIG
  let preset: Preset | undefined
  let rulesPackage: string | undefined
  let sawRules = false
  let doctor = false
  let version = false

  // `entries()` rather than an index loop: it yields a defined element, so there is no
  // possibly-undefined fallback branch that no input can ever reach.
  let consumedValue = false

  for (const [index, argument] of args.entries()) {
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

    if (argument === '--version') {
      version = true
      continue
    }

    if (argument !== '--rules' && argument !== '--config' && argument !== '--preset') {
      return { _tag: 'Invalid', problem: `unrecognised argument: ${argument}` }
    }

    const value = args[index + 1]
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

  if (version) {
    return { _tag: 'Version' }
  }

  return doctor
    ? { _tag: 'Doctor', configPath, preset, rulesDirectory, rulesPackage }
    : { _tag: 'Run', configPath, preset, rulesDirectory, rulesPackage }
}
