/**
 * Turning what the flags asked for into the directory rules are actually loaded from.
 *
 * This is the single most consequential decision the CLI makes — it chooses WHICH RULE SET runs —
 * and it lived as two module-private functions inside `cli.ts`, which is excluded from both the
 * coverage ratchet and mutation testing. The repo's whole quality apparatus applied to every file
 * except the one deciding what gets enforced. Nothing tested `--preset` end to end (the string does
 * not appear in the e2e suite at all), and `pkg:` was tested only as far as the argument parser.
 *
 * Splitting it out is what makes it reachable by a test. The anchor stays a PARAMETER rather than
 * being read from `import.meta.url` in here: the executable is bundled to `dist/cli.js` while the
 * library build also emits `dist/cli/resolve.js`, so a self-anchored `../rules` would mean two
 * different directories depending on which artifact loaded it. The shell knows where it lives; this
 * module does not have to guess.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Preset } from './options.ts'

/**
 * Where a preset's rules live, given the packaged `rules/` root.
 *
 * `all` is the root itself, since the loader searches recursively; a named preset is the
 * subdirectory of the same name.
 */
export const presetDirectory = (preset: Preset, packagedRulesRoot: string): string =>
  preset === 'all' ? packagedRulesRoot : join(packagedRulesRoot, preset)

/**
 * Resolves `--rules pkg:<name>` to the rules directory inside an installed package.
 *
 * Resolution runs from the PROJECT, not from falsestart's own location, so the package is found
 * wherever the consumer's package manager put it. This is why `node_modules/<name>/rules` is not
 * simply joined by hand: under pnpm's default layout that path does not exist, and the real one
 * lives in a content-addressed store whose name nobody can guess.
 *
 * A specifier may name a subdirectory (`@acme/rules/strict`) to take part of a rule set, mirroring
 * what `--preset` does for the rules shipped here. Scoped names keep two segments, so
 * `@acme/rules/strict` is the package `@acme/rules` and the subdirectory `strict`.
 *
 * Throws when the package cannot be resolved. The caller reports that as a misconfiguration and
 * lets the write proceed — a missing dependency must not stop every write in the repo.
 */
export const packageRulesDirectory = (specifier: string, projectDirectory: string): string => {
  const scoped = specifier.startsWith('@')
  const segments = specifier.split('/')
  const packageName = segments.slice(0, scoped ? 2 : 1).join('/')
  const subdirectory = segments.slice(scoped ? 2 : 1).join('/')

  // Anchored on a file that need not exist: `createRequire` only uses the path to decide where
  // resolution starts, and `projectDirectory` is a directory rather than a module.
  const resolve = createRequire(join(projectDirectory, 'noop.js'))
  const manifest = resolve.resolve(`${packageName}/package.json`)

  return join(dirname(manifest), 'rules', subdirectory)
}
