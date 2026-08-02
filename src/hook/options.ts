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

export type Options =
  | { readonly _tag: 'Help'; readonly text: string }
  | { readonly _tag: 'Invalid'; readonly problem: string }
  | { readonly _tag: 'Run'; readonly configPath: string | undefined; readonly rulesDirectory: string }

const USAGE = `falsestart — block risky code patterns as they are written

Reads a Claude Code PreToolUse hook payload on stdin and answers with a decision.

Usage:
  falsestart [--rules <dir>]

Options:
  --rules <dir>   Directory of ast-grep rule documents, searched recursively.
                  Defaults to ${DEFAULT_RULES_DIRECTORY}.
  --config <file> Per-repo scope overrides (.ts, .mts, .js, .mjs or .json).
                  Optional; without it falsestart looks for
                  falsestart.config.{ts,mts,js,mjs,json} and proceeds with no
                  overrides if none is present.
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

export const parseArguments = (args: readonly string[]): Options => {
  if (args.includes('--help') || args.includes('-h')) {
    return { _tag: 'Help', text: USAGE }
  }

  let rulesDirectory = DEFAULT_RULES_DIRECTORY
  let configPath: string | undefined = NO_EXPLICIT_CONFIG

  // `entries()` rather than an index loop: it yields a defined element, so there is no
  // possibly-undefined fallback branch that no input can ever reach.
  let consumedValue = false

  for (const [index, argument] of args.entries()) {
    if (consumedValue) {
      consumedValue = false
      continue
    }

    if (argument !== '--rules' && argument !== '--config') {
      return { _tag: 'Invalid', problem: `unrecognised argument: ${argument}` }
    }

    const value = args[index + 1]
    if (value === undefined) {
      return { _tag: 'Invalid', problem: `${argument} needs a ${argument === '--rules' ? 'directory' : 'file'}` }
    }

    if (argument === '--rules') {
      rulesDirectory = value
    } else {
      configPath = value
    }
    consumedValue = true
  }

  return { _tag: 'Run', configPath, rulesDirectory }
}
