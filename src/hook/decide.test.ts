import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import type { Rule } from '../checking/rule.ts'
import { parseRule } from '../checking/rule.ts'
import { decide, judgesPayload } from './decide.ts'

const rulesOf = (...sources: readonly string[]) => Effect.all(sources.map((source) => parseRule(source, 'test.yml')))

const noAsAny = `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
`

const writePayload = (content: string, path = '/repo/src/widget.ts') => ({
  tool_input: { content, file_path: path },
  tool_name: 'Write',
})

describe('hook decision', () => {
  effect('denies a Write whose content violates a rule', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
      expect(decision._tag === 'Deny' && decision.reason).toContain('as any erases the type')
    }),
  )

  effect('names the rule and the line in the denial', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const ok = 1\nconst x = y as any'))

      const reason = decision._tag === 'Deny' ? decision.reason : ''
      expect(reason).toContain('no-as-any')
      expect(reason).toContain('2')
    }),
  )

  effect('defers a Write whose content is clean', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as Widget'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('judges an Edit by the text it would introduce', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: {
          file_path: '/repo/src/widget.ts',
          new_string: 'const x = value as any',
          old_string: 'const x = value',
        },
        tool_name: 'Edit',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('has no opinion about tools that do not write source', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { command: 'const x = value as any' },
        tool_name: 'Bash',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('respects the rule file scope, so an out-of-scope path is not blocked', () =>
    Effect.gen(function* () {
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - '**/*.tsx'\n`)

      const decision = yield* decide(scoped, writePayload('const x = value as any', '/repo/src/widget.ts'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('lists every violation rather than only the first', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const a = x as any\nconst b = y as any'))

      const reason = decision._tag === 'Deny' ? decision.reason : ''
      expect(reason.match(/no-as-any/g)).toHaveLength(2)
    }),
  )

  effect('advises rather than blocks on a finding below error severity', () =>
    Effect.gen(function* () {
      const advisory = yield* rulesOf(`${noAsAny}severity: warning\n`)

      const decision = yield* decide(advisory, writePayload('const x = value as any'))

      // Not Deny — it must not stop the write. Not Defer either: dropping it would make a
      // `warning` rule do nothing at all.
      expect(decision._tag).toBe('Advise')
      expect(decision._tag === 'Advise' && decision.note).toContain('as any erases the type')
    }),
  )

  effect('prefers blocking over advising when both kinds are found', () =>
    Effect.gen(function* () {
      const mixed = yield* rulesOf(noAsAny, `${noAsAny.replace('no-as-any', 'soft-rule')}severity: warning\n`)

      const decision = yield* decide(mixed, writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('reports rather than blocks when the payload makes no sense', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), 'not a payload at all')

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a payload that names no tool', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), { tool_input: { content: 'x' } })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a write tool whose input is not an object', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), { tool_input: 'nonsense', tool_name: 'Write' })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a Write that carries no path to judge', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { content: 'const x = value as any' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports, and does not block, when a rule itself cannot run', () =>
    Effect.gen(function* () {
      const broken: Rule = { id: 'broken', language: 'tsx', rule: { nonsense: true } }

      const decision = yield* decide([broken], writePayload('const x = 1'))

      expect(decision._tag).toBe('Report')
      expect(decision._tag === 'Report' && decision.problem).toContain('broken')
    }),
  )
})

describe('project-relative scoping', () => {
  effect('applies a repo-relative rule glob to the absolute path a hook reports', () =>
    Effect.gen(function* () {
      // Regression: rules are authored as `src/**/*.ts`, hooks report `/repo/src/a.ts`, and
      // matching one against the other used to silently never fire.
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - 'src/**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        cwd: '/repo',
        tool_input: { content: 'const x = value as any', file_path: '/repo/src/widget.ts' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('still keeps a repo-relative rule off a path it does not cover', () =>
    Effect.gen(function* () {
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - 'src/**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        cwd: '/repo',
        tool_input: { content: 'const x = value as any', file_path: '/repo/vendor/widget.ts' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('falls back to the absolute path when the payload carries no cwd', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
    }),
  )
})

// A judged write that no rule is scoped to is indistinguishable, from the outside, from a write
// every rule examined and approved. Both are silence. A repo that wires up the hook and writes
// only `.js` gets a guard that is installed, registered, healthy, and inert — which is how this
// came in: a probe carrying a hardcoded credential and a swallowed catch went through untouched,
// and the report was "falsestart does not block", not "falsestart does not cover .js".
//
// Opt-in, because the honest version of this signal is noisy. Measured against the shipped
// presets: it fires on every `.md`, `.json`, `.yml` and `.js` write under all three, and on test
// files under `clean-code` only — `all` and `effect` carry three rules that judge test files, so
// those stay quiet. Default-on would train the reader to ignore it, which is worse than saying
// nothing, because an ignored warning still looks like coverage.
describe('unscoped writes', () => {
  const scopedToTypeScript = `${noAsAny}files:\n  - '**/*.ts'\n`

  const inRepo = (path: string, content = 'const x = value as any') => ({
    cwd: '/repo',
    tool_input: { content, file_path: path },
    tool_name: 'Write',
  })

  effect('advises when asked and no rule is scoped to the path', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(scopedToTypeScript), inRepo('/repo/src/widget.js'), {
        warnUnscoped: true,
      })

      expect(decision._tag).toBe('Advise')
      // The path is the whole point: "something was unguarded" without saying what is not
      // actionable, and the reader cannot tell which of their globs is wrong.
      expect(decision._tag === 'Advise' && decision.note).toContain('src/widget.js')
    }),
  )

  effect('stays silent about the same write when not asked', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(scopedToTypeScript), inRepo('/repo/src/widget.js'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  // The negative that matters. "No rule applies" and "every rule applied and found nothing" are
  // the two silences this is meant to tell apart; conflating them would make the warning fire on
  // every clean write in the repo, which is every write.
  effect('says nothing when a rule does apply and finds nothing', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(scopedToTypeScript),
        inRepo('/repo/src/widget.ts', 'const x = value as Widget'),
        { warnUnscoped: true },
      )

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('does not warn about a tool it was never going to judge', () =>
    Effect.gen(function* () {
      const decision = yield* decide(
        yield* rulesOf(scopedToTypeScript),
        { tool_input: {}, tool_name: 'Bash' },
        {
          warnUnscoped: true,
        },
      )

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('never turns a denial into advice', () =>
    Effect.gen(function* () {
      // Advising is a non-blocking outcome. If the warning ever pre-empted a real finding it would
      // convert a block into a pass — the tool failing at the one thing it exists to do.
      const decision = yield* decide(yield* rulesOf(scopedToTypeScript), inRepo('/repo/src/widget.ts'), {
        warnUnscoped: true,
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('reports an empty rule set on every judged write, which is the honest answer', () =>
    Effect.gen(function* () {
      // Loading zero rules is the most complete version of "guarding nothing", and the one most
      // likely to be believed healthy — `--doctor` says `0 loaded`, but nobody runs it twice.
      const decision = yield* decide([], inRepo('/repo/src/widget.ts'), { warnUnscoped: true })

      expect(decision._tag).toBe('Advise')
    }),
  )
})

describe('notebook writes', () => {
  effect('judges a NotebookEdit by the source it would introduce', () =>
    Effect.gen(function* () {
      // NotebookEdit writes real source and was previously an unjudged bypass.
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: {
          cell_type: 'code',
          new_source: 'const x = value as any',
          notebook_path: '/repo/analysis.ipynb',
        },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('scopes a notebook by its own path field', () =>
    Effect.gen(function* () {
      // The path lives in `notebook_path`, not `file_path`; reading the wrong key would leave the
      // rule unscoped rather than out of scope.
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - '**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        tool_input: { new_source: 'const x = value as any', notebook_path: '/repo/analysis.ipynb' },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('reports a NotebookEdit missing its path', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { new_source: 'const x = value as any' },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Report')
    }),
  )

  // `judgesPayload` had no direct test — it was only ever exercised through `respond`, which always
  // hands it a well-formed object. Mutation testing found every conjunct of its record guard
  // survivable: nothing fed it `null`, an array, or a non-object, so `typeof value === 'object'`,
  // `value !== null` and `!Array.isArray(value)` could each be deleted with the suite still green.
  // Line coverage was 100% throughout.
  describe('payload triage', () => {
    it('treats a malformed payload as a candidate rather than skipping it', () => {
      // True means "this is mine to judge", and `decide` then reports the problem. Skipping here
      // would silently swallow exactly the case worth reporting, per the function's own docstring.
      expect(judgesPayload(null)).toBeTruthy()
      expect(judgesPayload([{ tool_name: 'Write' }])).toBeTruthy()
      expect(judgesPayload('Write')).toBeTruthy()
      expect(judgesPayload(undefined)).toBeTruthy()
    })

    it('claims a record whose tool_name is absent or not a string, for the same reason', () => {
      expect(judgesPayload({})).toBeTruthy()
      expect(judgesPayload({ tool_name: 7 })).toBeTruthy()
    })

    it('passes on a well-formed call to a tool it does not judge', () => {
      expect(judgesPayload({ tool_name: 'Bash' })).toBeFalsy()
      expect(judgesPayload({ tool_name: 'Write' })).toBeTruthy()
      expect(judgesPayload({ tool_name: 'Edit' })).toBeTruthy()
      expect(judgesPayload({ tool_name: 'NotebookEdit' })).toBeTruthy()
    })
  })
})
