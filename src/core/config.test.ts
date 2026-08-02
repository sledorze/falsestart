import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'
import { applyScopeOverrides, defineConfig, parseConfig } from './config.ts'
import type { Rule } from './rule.ts'

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

describe('authoring helper', () => {
  effect('defineConfig returns the config it is given, typed', () =>
    Effect.gen(function* () {
      const config = defineConfig({ rules: { 'no-as-any': { files: ['src/**/*.ts'] } } })

      expect(yield* applyScopeOverrides([ruleOf('no-as-any')], config)).toHaveLength(1)
    }),
  )
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

  effect('refuses an override for a rule that is not loaded', () =>
    Effect.gen(function* () {
      // A typo'd rule id would otherwise be a scope change that silently never happens.
      const error = yield* Effect.flip(applyScopeOverrides(rules, { rules: { 'no-as-anyy': { files: ['x'] } } }))

      expect(error.reasons.join(', ')).toContain('no-as-anyy')
    }),
  )

  effect('reports every unknown rule id at once', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        applyScopeOverrides(rules, { rules: { ghost: { files: ['x'] }, phantom: { files: ['y'] } } }),
      )

      expect(error.reasons).toHaveLength(2)
    }),
  )

  effect('returns the rules unchanged when there are no overrides', () =>
    Effect.gen(function* () {
      expect(yield* applyScopeOverrides(rules, { rules: {} })).toEqual(rules)
    }),
  )
})
