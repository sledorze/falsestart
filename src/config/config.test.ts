import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import {
  applyScopeOverrides,
  findNarrowedScopes,
  findUnappliedOverrides,
  makeConfig,
  makeConfigUnsafe,
  parseConfig,
} from './config.ts'
import type { Rule } from '../checking/rule.ts'

const ruleOf = (id: string, files?: readonly string[], ignores?: readonly string[]): Rule => ({
  id,
  language: 'tsx',
  rule: { pattern: '$X as any' },
  ...(files === undefined ? {} : { files }),
  ...(ignores === undefined ? {} : { ignores }),
})

const parsed = (source: string) => parseConfig(source, 'falsestart.config.json')

describe('repo configuration', () => {
  effect('reads a per-rule scope override', () =>
    Effect.gen(function* () {
      const config = yield* parsed('{"rules":{"no-as-any":{"files":["src/domain/**/*.ts"]}}}')

      expect(config.rules['no-as-any']?.files).toEqual(['src/domain/**/*.ts'])
    }),
  )

  effect('accepts a config with no overrides at all', () =>
    Effect.gen(function* () {
      expect((yield* parsed('{}')).rules).toEqual({})
    }),
  )

  effect('rejects a config that is not an object', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(parsed('[]'))).reasons.join(', ')).toContain('object')
    }),
  )

  effect('rejects malformed JSON', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(parsed('{oops'))).reasons.join(', ')).toContain('JSON')
    }),
  )

  effect('refuses an override that omits files', () =>
    Effect.gen(function* () {
      // `files` is mandatory: an override exists to state where a rule applies in THIS repo, and
      // omitting it leaves that inherited from an author who never saw the layout.
      const error = yield* Effect.flip(parsed('{"rules":{"a":{"ignores":["**/gen/**"]}}}'))

      expect(error.reasons.join(', ')).toContain('files is required')
    }),
  )

  effect('reads an override naming both scope keys', () =>
    Effect.gen(function* () {
      const config = yield* parsed('{"rules":{"a":{"files":["src/**"],"ignores":["**/gen/**"]}}}')

      expect(config.rules['a']).toEqual({ files: ['src/**'], ignores: ['**/gen/**'] })
    }),
  )

  effect('rejects a rules value that is not an object', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(parsed('{"rules":[]}'))).reasons.join(', ')).toContain('rules must be an object')
    }),
  )

  effect('rejects an override that is not an object', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(parsed('{"rules":{"a":"src/**"}}'))).reasons.join(', ')).toContain('must be an object')
    }),
  )

  effect('rejects a non-string ignore glob', () =>
    Effect.gen(function* () {
      expect(
        (yield* Effect.flip(parsed('{"rules":{"a":{"files":["x"],"ignores":[7]}}}'))).reasons.join(', '),
      ).toContain('ignores')
    }),
  )

  effect('reports every malformed override together', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parsed('{"rules":{"a":{},"b":{"files":[1]}}}'))

      expect(error.reasons).toHaveLength(2)
    }),
  )

  effect('rejects a non-string glob', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(parsed('{"rules":{"a":{"files":[7]}}}'))).reasons.join(', ')).toContain('files')
    }),
  )

  effect('rejects an empty override', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(parsed('{"rules":{"a":{}}}'))).reasons.join(', ')).toContain('files')
    }),
  )
})

describe('smart constructor', () => {
  effect('builds a config from a valid value', () =>
    Effect.gen(function* () {
      const config = yield* makeConfig({ rules: { 'no-as-any': { files: ['src/**/*.ts'] } } })

      expect(config.rules['no-as-any']?.files).toEqual(['src/**/*.ts'])
    }),
  )

  effect('refuses a value that is not a config, rather than asserting it is one', () =>
    Effect.gen(function* () {
      // The point of a constructor over a typed literal: input it was never given a guarantee
      // about still gets checked.
      const error = yield* Effect.flip(makeConfig({ rules: { 'no-as-any': { files: 'src/**' } } }))

      expect(error.reasons.join(', ')).toContain('files is required')
    }),
  )

  it('builds unsafely for a config module, where a throw is the clearest failure', () => {
    const config = makeConfigUnsafe({ rules: { 'no-as-any': { files: ['src/**/*.ts'] } } })

    expect(config.rules['no-as-any']?.files).toEqual(['src/**/*.ts'])
  })

  it('throws rather than returning something that is not a config', () => {
    expect(() => makeConfigUnsafe({ rules: { 'no-as-any': {} } })).toThrow(/files is required/)
  })
})

describe('applying scope overrides', () => {
  const rules = [ruleOf('no-as-any', ['**/*.ts'], ['**/*.test.ts']), ruleOf('no-await', ['**/*.ts'])]

  effect('replaces the files globs of the named rule only', () =>
    Effect.gen(function* () {
      const [first, second] = yield* applyScopeOverrides(rules, {
        rules: { 'no-as-any': { files: ['src/domain/**/*.ts'] } },
      })

      expect(first?.files).toEqual(['src/domain/**/*.ts'])
      expect(second?.files).toEqual(['**/*.ts'])
    }),
  )

  effect('leaves a key the override does not name untouched', () =>
    Effect.gen(function* () {
      // Naming only `files` must not silently discard the author's test-file exemption.
      const [first] = yield* applyScopeOverrides(rules, { rules: { 'no-as-any': { files: ['src/**/*.ts'] } } })

      expect(first?.ignores).toEqual(['**/*.test.ts'])
    }),
  )

  effect('replaces ignores when the override names them', () =>
    Effect.gen(function* () {
      const [first] = yield* applyScopeOverrides(rules, {
        rules: { 'no-as-any': { files: ['src/**/*.ts'], ignores: ['**/legacy/**'] } },
      })

      expect(first?.ignores).toEqual(['**/legacy/**'])
      expect(first?.files).toEqual(['src/**/*.ts'])
    }),
  )

  effect('does not refuse an override for a rule that is not loaded', () =>
    Effect.gen(function* () {
      // This asserted the opposite until the cost of the refusal was measured. It is raised on the
      // JUDGING path, where the guard fails open — so refusing meant exit 1 with the write
      // proceeding unchecked, and under `--fail closed` a denial of every write in the repository.
      // A typo in a scope override became a guard that does not run.
      const scoped = yield* applyScopeOverrides(rules, { rules: { 'no-as-anyy': { files: ['x'] } } })

      expect(scoped).toEqual(rules)
    }),
  )

  it('names every unapplied rule id at once, so none of them is silent', () => {
    const unapplied = findUnappliedOverrides(rules, { rules: { ghost: { files: ['x'] }, phantom: { files: ['y'] } } })

    expect(unapplied).toEqual(['ghost', 'phantom'])
  })

  effect('returns the rules unchanged when there are no overrides', () =>
    Effect.gen(function* () {
      expect(yield* applyScopeOverrides(rules, { rules: {} })).toEqual(rules)
    }),
  )
})

// An override REPLACES `files` rather than merging into them, so an extension left out of the
// restatement is silently unguarded and nothing fails — there is simply no file with that
// extension in the repo yet to go unchecked. These are the cases the comparison has to get right.
describe('repository-wide exclusions', () => {
  effect('reads an exclude list', () =>
    Effect.gen(function* () {
      // A fact about the REPOSITORY, not about one invocation. Left to the command line alone, the
      // same list has to be repeated in lefthook.yml, in a husky script and in CI, and the copies
      // drift — which this codebase has already had to fix twice elsewhere.
      const config = yield* parsed('{"exclude":["legacy/**","gen/**"],"rules":{}}')

      expect(config.exclude).toEqual(['legacy/**', 'gen/**'])
    }),
  )

  effect('reads an exclude list even with no rules block at all', () =>
    Effect.gen(function* () {
      expect((yield* parsed('{"exclude":["legacy/**"]}')).exclude).toEqual(['legacy/**'])
    }),
  )

  effect('leaves exclude absent when the config does not mention it', () =>
    Effect.gen(function* () {
      expect((yield* parsed('{"rules":{}}')).exclude).toBeUndefined()
    }),
  )

  effect('refuses an exclude that is not a list of globs, rather than ignoring it', () =>
    Effect.gen(function* () {
      // Silently dropping it would leave a repository believing it had excluded something.
      const error = yield* Effect.flip(parsed('{"exclude":"legacy/**","rules":{}}'))

      expect(error.reasons.join(', ')).toContain('exclude must be an array')
    }),
  )

  effect('refuses a list containing something that is not a glob', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(parsed('{"exclude":["ok/**",7],"rules":{}}'))).reasons).toHaveLength(1)
    }),
  )
})

describe('narrowed scope', () => {
  const shipped = ruleOf('no-thing', ['**/*.{ts,tsx,mts,cts,js}'])

  it('names the extensions an override drops', () => {
    const scoped = ruleOf('no-thing', ['**/*.{ts,tsx}'])

    expect(findNarrowedScopes([shipped], [scoped])).toEqual([
      { lostExtensions: ['mts', 'cts', 'js'], ruleId: 'no-thing' },
    ])
  })

  it('says nothing when the override keeps every extension', () => {
    // Narrowing by DIRECTORY is the documented use of this feature and must stay silent, or the
    // report becomes noise on exactly the configs that are using overrides correctly.
    const scoped = ruleOf('no-thing', ['src/domain/**/*.{ts,tsx,mts,cts,js}'])

    expect(findNarrowedScopes([shipped], [scoped])).toEqual([])
  })

  it('says nothing when the override covers more than the rule shipped with', () => {
    const scoped = ruleOf('no-thing', ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'])

    expect(findNarrowedScopes([shipped], [scoped])).toEqual([])
  })

  it('probes a test-only rule where it actually applies', () => {
    // Probing `src/a.ts` against a rule scoped to `*.test.*` reports every extension as lost, for
    // reasons that have nothing to do with the override — the three test-only shipped rules would
    // each produce a spurious eight-extension complaint.
    const testOnly = ruleOf('no-thing', ['**/*.test.{ts,tsx,mts,cts,js}'])
    const keptWhole = ruleOf('no-thing', ['**/*.test.{ts,tsx,mts,cts,js}'])
    const trimmed = ruleOf('no-thing', ['**/*.test.{ts,tsx}'])

    expect(findNarrowedScopes([testOnly], [keptWhole])).toEqual([])
    expect(findNarrowedScopes([testOnly], [trimmed])).toEqual([
      { lostExtensions: ['mts', 'cts', 'js'], ruleId: 'no-thing' },
    ])
  })

  it('treats a rule with no files as covering everything, so any override narrows it', () => {
    const unscoped = ruleOf('no-thing')
    const scoped = ruleOf('no-thing', ['**/*.ts'])

    expect(findNarrowedScopes([unscoped], [scoped])).toEqual([
      { lostExtensions: ['tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'], ruleId: 'no-thing' },
    ])
  })

  it('handles a glob with no directory part', () => {
    const rootOnly = ruleOf('no-thing', ['*.{ts,tsx,mts}'])
    const trimmed = ruleOf('no-thing', ['*.ts'])

    expect(findNarrowedScopes([rootOnly], [trimmed])).toEqual([{ lostExtensions: ['tsx', 'mts'], ruleId: 'no-thing' }])
  })

  it('handles a shipped glob that ends in a directory wildcard rather than a filename', () => {
    const everywhere = ruleOf('no-thing', ['src/**'])
    const trimmed = ruleOf('no-thing', ['src/**/*.{ts,tsx}'])

    expect(findNarrowedScopes([everywhere], [trimmed])).toEqual([
      { lostExtensions: ['mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'], ruleId: 'no-thing' },
    ])
  })

  it('handles an OVERRIDE glob that ends in a directory wildcard', () => {
    // `src/**` names no file of its own, so the probe has to invent one rather than rewrite the
    // last segment — rewriting would turn `**` into `file.mts` and quietly move the directory,
    // making the comparison answer a question about a path neither glob was ever asked about.
    // An override that restricts the directory and nothing else has dropped no language.
    const shippedWide = ruleOf('no-thing', ['**/*.{ts,tsx,mts}'])
    const directoryOnly = ruleOf('no-thing', ['src/**'])

    expect(findNarrowedScopes([shippedWide], [directoryOnly])).toEqual([])
  })

  it('reports nothing when the override sets no files at all, since that admits everything', () => {
    const scoped = ruleOf('no-thing')

    expect(findNarrowedScopes([shipped], [scoped])).toEqual([])
  })

  it('ignores a rule the scoped set does not contain', () => {
    // The two arrays are independent inputs, not guaranteed to be the same rule set — a caller
    // comparing a preset against a differently-loaded tree would otherwise get a report about
    // rules that are simply not there.
    expect(findNarrowedScopes([shipped], [])).toEqual([])
  })
})

describe('an override for a rule this invocation did not load', () => {
  effect('applies the ones it can and leaves the rest alone', () =>
    Effect.gen(function* () {
      // Refused outright before, and the refusal was worse than the problem it named. Two hook
      // entries — a preset in one, a repo tree in the other — auto-discover the SAME config, so the
      // entry that did not load a rule saw an override for it and bailed. At judge time that is
      // exit 1 with the write proceeding UNCHECKED, and under `--fail closed` it denies every write
      // in the repository. A scope override that does not apply became a guard that does not run.
      const config = yield* parsed('{"rules":{"no-as-any":{"files":["src/**"]},"elsewhere":{"files":["lib/**"]}}}')

      const scoped = yield* applyScopeOverrides([ruleOf('no-as-any')], config)

      expect(scoped.map((rule) => rule.files)).toEqual([['src/**']])
    }),
  )

  effect('names the ones it could not apply, so they are not silent either', () =>
    Effect.gen(function* () {
      const config = yield* parsed('{"rules":{"no-as-any":{"files":["src/**"]},"typo-here":{"files":["lib/**"]}}}')

      expect(findUnappliedOverrides([ruleOf('no-as-any')], config)).toEqual(['typo-here'])
    }),
  )

  effect('reports nothing when every override found its rule', () =>
    Effect.gen(function* () {
      const config = yield* parsed('{"rules":{"no-as-any":{"files":["src/**"]}}}')

      expect(findUnappliedOverrides([ruleOf('no-as-any')], config)).toEqual([])
    }),
  )
})

describe('a negated glob in a scope override', () => {
  effect('is refused, for the reason a rule document refuses it', () =>
    Effect.gen(function* () {
      // An override carries the same `files`/`ignores` shape and reaches the same matcher, so the
      // same OR semantics apply: `'!**/*.test.ts'` admits everything that is not a test file.
      const error = yield* Effect.flip(parsed('{"rules":{"no-as-any":{"files":["src/**","!**/*.test.ts"]}}}'))

      expect(error.reasons.join('\n')).toContain('ignores')
    }),
  )

  effect('leaves a literal ! elsewhere in the glob alone', () =>
    Effect.gen(function* () {
      const config = yield* parsed('{"rules":{"no-as-any":{"files":["weird!dir/**"]}}}')

      expect(config.rules['no-as-any']?.files).toEqual(['weird!dir/**'])
    }),
  )
})

describe('an empty glob in a scope override', () => {
  effect('is refused, for the reason a rule document refuses it', () =>
    Effect.gen(function* () {
      // An override reaches the same matcher, and an empty pattern throws there — a defect that
      // escapes every boundary and kills the run with nothing on either stream.
      const error = yield* Effect.flip(parsed('{"rules":{"no-as-any":{"files":["src/**",""]}}}'))

      expect(error.reasons.join('\n')).toContain('empty glob')
    }),
  )

  effect('refuses a blank one in ignores too', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parsed('{"rules":{"no-as-any":{"files":["src/**"],"ignores":["  "]}}}'))

      expect(error.reasons.join('\n')).toContain('empty glob')
    }),
  )
})
