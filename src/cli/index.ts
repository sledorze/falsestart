/**
 * Entry point for the command line: what the invocation asked for.
 *
 * Argument parsing is a process concern, not a hook concern — it was filed under `hook/` and had
 * nothing to do with the PreToolUse protocol. `cli.ts` at the root wires this to stdin and stdout;
 * this area decides what the flags meant.
 */
export type { Options, Preset } from './options.ts'
export { DEFAULT_RULES_DIRECTORY, PACKAGE_PREFIX, parseArguments, PRESETS } from './options.ts'
export { packageRulesDirectory, presetDirectory } from './resolve.ts'
export { isBrokenPipe } from './stdio.ts'
