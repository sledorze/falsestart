/**
 * Rewriting falsestart's rules as documents the upstream ast-grep CLI will execute.
 *
 * The two engines disagree about what `language` means, and everything here follows from that.
 * falsestart chooses files by a rule's `files` globs and parses each with the rule's declared
 * language. ast-grep chooses files by the language's own extension mapping, then narrows with
 * `files`. So the shipped rules — all `language: tsx`, scoped across every source extension —
 * match everything under falsestart and NOTHING under ast-grep: measured, zero findings over a
 * 424-file corpus.
 *
 * Reproducing falsestart's answer means emitting one copy of a rule per language family it can
 * actually reach. The extension intersection then costs nothing: ast-grep only ever shows a
 * `language: typescript` document a `.ts`, `.mts` or `.cts` file, so the narrowing that would
 * otherwise need glob surgery happens for free.
 */
import type { Rule } from '../checking/index.ts'
import { appliesTo, samplePath } from '../checking/index.ts'

/**
 * Which extensions each ast-grep language is fed, and therefore which of falsestart's rules can
 * reach a file at all.
 *
 * Ordered so the emitted documents are deterministic — a rule set that reorders between runs makes
 * two reports impossible to diff.
 */
const FAMILIES: readonly (readonly [string, readonly string[]])[] = [
  ['typescript', ['ts', 'mts', 'cts']],
  ['tsx', ['tsx']],
  ['javascript', ['js', 'jsx', 'mjs', 'cjs']],
]

/**
 * Separates a copy's id from the family it was emitted for.
 *
 * ast-grep refuses a rule tree with duplicate ids, so three copies of `no-as-any` cannot all be
 * called `no-as-any`. The reader must still see the rule they can act on, so the suffix is
 * mechanical and reversible rather than descriptive.
 */
const FAMILY_SEPARATOR = '__'

export interface HydratedRule {
  readonly document: Readonly<Record<string, unknown>> & { readonly id: string; readonly language: string }
}

export interface HydrateOptions {
  /** Scan-level exclusions, unioned into each rule's own `ignores`. */
  readonly exclude?: readonly string[] | undefined
}

/** The rule a hydrated copy came from, so a finding names something the reader recognises. */
export const originalRuleId = (hydratedId: string): string => {
  // An id with no separator is returned unchanged, so this is safe to call on a finding from either
  // engine without the caller having to know which produced it.
  const separator = hydratedId.indexOf(FAMILY_SEPARATOR)

  return separator === -1 ? hydratedId : hydratedId.slice(0, separator)
}

/**
 * Whether this rule can reach any file of this family.
 *
 * Probed rather than parsed out of the glob: `files` is an arbitrary list of globs, and reading
 * extensions back out of one is the sort of approximate glob analysis that goes wrong quietly.
 * Asking `appliesTo` the same question the engine will ask keeps the two answers identical by
 * construction.
 */
const reaches = (rule: Rule, extensions: readonly string[]): boolean =>
  extensions.some((extension) => (rule.files ?? ['**/*']).some((glob) => appliesTo(rule, samplePath(glob, extension))))

export const hydrate = (rules: readonly Rule[], options: HydrateOptions): readonly HydratedRule[] => {
  const { exclude } = options

  return rules.flatMap((rule) =>
    FAMILIES.filter(([, extensions]) => reaches(rule, extensions)).map(([language]) => {
      // A union, because that is what ignoring means within one rule: a path is out if ANY glob
      // names it. Replacing would resurrect the rule's own exemptions; intersecting would make the
      // rule wider than it was authored, which is how one starts firing on its own test files.
      const ignores = [...(rule.ignores ?? []), ...(exclude ?? [])]

      return {
        document: {
          ...(rule.constraints === undefined ? {} : { constraints: rule.constraints }),
          ...(rule.files === undefined ? {} : { files: rule.files }),
          id: `${rule.id}${FAMILY_SEPARATOR}${language}`,
          ...(ignores.length === 0 ? {} : { ignores }),
          language,
          ...(rule.message === undefined ? {} : { message: rule.message }),
          rule: rule.rule,
          ...(rule.severity === undefined ? {} : { severity: rule.severity }),
          ...(rule.utils === undefined ? {} : { utils: rule.utils }),
        },
      }
    }),
  )
}
