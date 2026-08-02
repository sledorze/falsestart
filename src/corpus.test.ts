/**
 * The shipped rules, proved against worked examples.
 *
 * Every rule carries at least one example it must catch and one it must leave alone. The second
 * kind is the one that matters most: a rule with only positive examples looks correct right up
 * until it starts firing on code nobody meant to forbid.
 *
 * The coverage gate at the bottom fails if a rule is added to `rules/` without examples, so the
 * corpus cannot quietly grow an untested member.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { loadRules } from './core/loader.ts'
import type { RuleExpectation } from './testing/assess.ts'
import { assessRule, findUntestedRules } from './testing/assess.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const corpus = loadRules('rules').pipe(Effect.provide(platform), Effect.orDie)

const src = 'src/service.ts'

// Assembled rather than written inline: a literal `${` inside a plain string trips a lint rule
// aimed at accidental non-interpolation, which is exactly what this example needs on purpose.
const INTERPOLATION = `const label = \`id: ${'$'}{widget.id}\``

/**
 * `catches` must trip the rule; `allows` must not. Paths are meaningful — scope is behaviour.
 *
 * `path` is where the rule is expected to apply, and `exempt` a path it must stay off. Most rules
 * police source and exempt tests; `no-vi-mocking` is the inverse, which is precisely why these are
 * per-rule rather than assumed.
 */
interface Example {
  readonly allows: readonly string[]
  readonly catches: readonly string[]
  readonly exempt?: string
  readonly path?: string
}

const EXAMPLES: Readonly<Record<string, Example>> = {
  'no-as-any': {
    allows: ['const w = value as Widget', 'const n = value as unknown as Widget'],
    catches: ['const w = value as any', 'call(payload as any)'],
  },
  'no-as-never': {
    allows: ['const n = value as Narrow'],
    catches: ['const n = value as never'],
  },
  'no-await': {
    allows: ['const run = () => Effect.tryPromise({ try: () => fetch(url), catch: onError })'],
    catches: ['const run = async () => { const r = await fetch(url); return r }'],
  },
  'no-double-cast': {
    allows: ['const w = value as Widget', 'const u: unknown = value'],
    catches: ['const w = value as unknown as Widget'],
  },
  'no-new-promise': {
    allows: ['const p = Effect.async<number>((resume) => resume(Effect.succeed(1)))'],
    catches: ['const p = new Promise((resolve) => resolve(1))'],
  },
  'no-process-env': {
    allows: ['const port = yield* Config.int("PORT")'],
    catches: ['const port = process.env.PORT'],
  },
  'no-process-exit': {
    allows: ['return Effect.fail(new Fatal())'],
    catches: ['process.exit(1)'],
  },
  'no-raw-coercion': {
    allows: [
      // Requires a type that already has the conversion, rather than accepting anything.
      'const s = widget.toString()',
      // Names a parse and admits failure.
      'const n = Number.parseInt(raw, 10)',
      // A reference, not a coercion of an unknown value.
      'const present = items.filter(Boolean)',
      // Interpolation is not the coercion this rule is about.
      INTERPOLATION,
    ],
    catches: ['const s = String(value)', 'const n = Number(input)', 'const b = Boolean(input)', 'const b = !!input'],
  },
  'no-raw-error': {
    allows: [
      "class WidgetMissing extends Data.TaggedError('WidgetMissing')<{ readonly id: string }> {}",
      'return Effect.fail(new WidgetMissing({ id }))',
      'throw new ValidationFailure({ field })',
    ],
    catches: ['throw new Error("boom")', 'const e = new TypeError("bad")', 'return Effect.fail(new RangeError("x"))'],
  },
  'no-test-lifecycle-hooks': {
    allows: [
      'const Built = Layer.effectDiscard(buildOnce)',
      "layer(Built)('the executable', (it) => { it.effect('works', () => run) })",
      'const scoped = Effect.acquireRelease(open, close)',
    ],
    catches: [
      'beforeAll(() => build())',
      'afterAll(() => cleanup())',
      'beforeEach(() => reset())',
      'afterEach(() => restore())',
    ],
    exempt: 'src/service.ts',
    path: 'src/service.test.ts',
  },
  'no-then-catch': {
    allows: ['const r = Effect.map(effect, decode)', 'const v = thenable.thenify(x)'],
    catches: ['load().then(use)', 'load().catch(onError)', 'load().finally(cleanup)'],
  },
  'no-try-catch': {
    allows: ['const r = Effect.try({ try: () => parse(raw), catch: onError })'],
    catches: ['try { parse(raw) } catch (error) { report(error) }'],
  },
  'no-type-assertion': {
    allows: [
      // A const assertion narrows a literal rather than overriding a type.
      'const modes = ["a", "b"] as const',
      // Import and export aliases are a different AST node, never an assertion.
      'import * as widgets from "./widgets"',
      'import { make as makeWidget } from "./widgets"',
      'export { make as makeWidget }',
      // A guard establishes the type instead of asserting it.
      'if (isWidget(value)) { use(value) }',
    ],
    catches: ['const w = value as Widget', 'const w = value as any', 'call(payload as Widget)'],
  },
  'no-vi-mocking': {
    allows: [
      // Injection rather than interception.
      'const layer = Layer.succeed(Clock, testClock)',
      'const layer = Layer.mock(Repository, { find: () => Effect.succeed(widget) })',
      'it("works", () => Effect.gen(function* () { yield* TestClock.adjust("1 second") }))',
      // A component receiving its dependency instead of having it mocked out.
      'render(<Widget repository={testRepository} />)',
    ],
    catches: [
      'const find = vi.fn()',
      'vi.mock("./repository")',
      'vi.spyOn(repository, "find")',
      'const mocked = vi.mocked(repository)',
      'vi.useFakeTimers()',
    ],
    // The inverse of every other rule: it applies IN tests and must stay off source.
    exempt: 'src/service.ts',
    path: 'src/service.test.ts',
  },
  'prefer-smart-constructor': {
    allows: [
      // Built through a constructor that owns the invariant.
      'const widget = new Widget({ id, size })',
      // Decoded rather than asserted.
      'const widget = yield* Schema.decodeUnknownEffect(WidgetSchema)(payload)',
      // No declared type: an options record, not a domain value.
      'const options = { concurrency: "unbounded" }',
    ],
    catches: ['const w: Widget = { id, size }'],
  },
}

const expectationsFor = (ruleId: string): readonly RuleExpectation[] => {
  const example = EXAMPLES[ruleId]
  if (example === undefined) {
    return []
  }

  const path = example.path ?? src
  const exempt = example.exempt ?? 'src/service.test.ts'

  return [
    ...example.catches.map((code, index) => ({
      code,
      expectViolation: true,
      name: `${ruleId} catches #${index + 1}: ${code}`,
      path,
    })),
    ...example.allows.map((code, index) => ({
      code,
      expectViolation: false,
      name: `${ruleId} allows #${index + 1}: ${code}`,
      path,
    })),
    // Proving the exemption per rule keeps a future scope change from silently widening a rule to
    // files it was never meant to police.
    ...example.catches.slice(0, 1).map((code) => ({
      code,
      expectViolation: false,
      name: `${ruleId} stays off ${exempt}`,
      path: exempt,
    })),
  ]
}

describe('shipped rule corpus', () => {
  effect('loads cleanly', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      expect(rules.length).toBeGreaterThan(0)
    }),
  )

  effect('every rule behaves as its examples say', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      const failures: string[] = []
      for (const rule of rules) {
        const results = yield* assessRule(rule, expectationsFor(rule.id))
        failures.push(
          ...results.filter((result) => !result.passed).map((result) => `${result.name} — ${result.detail}`),
        )
      }

      expect(failures).toEqual([])
    }),
  )

  effect('no rule ships without examples', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      expect(findUntestedRules(rules, Object.keys(EXAMPLES))).toEqual([])
    }),
  )
})
