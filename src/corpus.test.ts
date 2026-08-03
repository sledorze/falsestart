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
import { loadRules } from './checking/loader.ts'
import { appliesTo } from './checking/scope.ts'
import { SHIPPED_RULE_IDS } from './checking/rule-ids.generated.ts'
import type { RuleExpectation } from './testing/assess.ts'
import { assessRule, findUntestedRules } from './testing/assess.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const corpus = loadRules('rules').pipe(Effect.provide(platform), Effect.orDie)

/** Which extensions the shipped corpus is meant to reach, and which it must stay off. */
const EXTENSION_EXPECTATIONS = [
  ['ts', true],
  ['tsx', true],
  ['mts', true],
  ['cts', true],
  ['js', false],
  ['jsx', false],
  ['mjs', false],
  ['cjs', false],
] as const

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
  'no-json-global': {
    allows: [
      // The remedy, both directions. `fromJsonString` puts a malformed document in the error
      // channel instead of throwing, and gives back a typed value instead of `any`.
      'const w = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Widget))(text)',
      'const s = yield* Schema.encodeEffect(Schema.fromJsonString(Widget))(widget)',
      // A member named `parse` on anything else is not this rule's business.
      'const doc = yaml.parse(source)',
      'const n = Number.parseInt(raw, 10)',
      'const v = json.parse(source)',
    ],
    catches: ['const config = JSON.parse(source)', 'const body = JSON.stringify(payload)'],
  },
  'no-manual-effect-run-in-tests': {
    allows: [
      "layer(platform)('loading', (it) => { it.effect('works', () => Effect.gen(function* () {})) })",
      "effect('works', () => Effect.gen(function* () {}))",
      // Providing a different layer for one case is the point of layers, not a workaround.
      'const r = program.pipe(Effect.provide(failingFileSystem))',
    ],
    catches: [
      'const r = await Effect.runPromise(program)',
      'const v = Effect.runSync(program)',
      'const e = Effect.runPromiseExit(program)',
    ],
    exempt: 'src/service.ts',
    path: 'src/service.test.ts',
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
  'no-raw-fetch': {
    allows: [
      // The remedy: a client that carries a typed error channel, interruption and a retry policy.
      'const res = yield* HttpClient.get(url)',
      'const res = yield* HttpClient.execute(HttpClientRequest.get(url))',
      // The minimal wrap, when a full client is more than the call needs.
      'const res = yield* Effect.tryPromise({ catch: toRequestError, try: () => send(url) })',
      // A member named `fetch` is somebody else's method, not the global.
      'const row = yield* repository.fetch(id)',
      'const r = prefetch(url)',
    ],
    catches: ['const res = await fetch(url)', 'const res = fetch(url, init)', 'void fetch(url)'],
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
    allows: [
      'const r = Effect.map(effect, decode)',
      'const v = thenable.thenify(x)',
      // The remedy the message itself recommends must not be blocked by the rule.
      'const r = program.pipe(Effect.catch(recover))',
      'const r = Effect.catch(program, recover)',
      // Any namespace exposing a `catch` combinator, not just the ones someone remembered to list.
      // `HttpClient` lives in `effect/unstable/http`, which the root import does not re-export.
      'const c = HttpClient.catch("RequestError", recover)',
      'const s = Cookies.finally(cleanup)',
    ],
    catches: [
      'load().then(use)',
      'load().catch(onError)',
      'load().finally(cleanup)',
      // A lowercase receiver is an ordinary promise value: still blocked.
      'promise.catch(onError)',
      // Capitalised, but a call expression rather than a namespace reference — the exemption is
      // structural (an identifier node), not "the text starts with a capital".
      'Promise.resolve(v).catch(onError)',
      'Promise.all(xs).then(use)',
    ],
  },
  'no-throwing-decode': {
    allows: [
      'const w = yield* Schema.decodeUnknownEffect(WidgetSchema)(payload)',
      'const r = Schema.decodeUnknownResult(WidgetSchema)(payload)',
      // Lazy-thunk constructors also end in Sync and are correct.
      'const e = Effect.failSync(() => new Boom())',
      'const d = Deferred.failSync(deferred, cause)',
    ],
    catches: [
      'const w = Schema.decodeUnknownSync(WidgetSchema)(payload)',
      'const w = Schema.decodeSync(WidgetSchema)(raw)',
      'const s = Schema.encodeSync(WidgetSchema)(widget)',
    ],
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
  'no-unsafe-api': {
    allows: [
      'const c = yield* Context.get(Repository)',
      'const head = Chunk.head(items)',
      'const v = Result.getOrElse(res, onNone)',
      // Not an Effect namespace: someone else's API may use the same suffix.
      'const v = myOwnHelper.readUnsafe(path)',
    ],
    catches: [
      'const c = Context.makeUnsafe(tag)',
      'const h = Chunk.headUnsafe(items)',
      'const v = Result.getOrThrow(res)',
    ],
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

/**
 * Ordinary, idiomatic, rule-abiding code. No shipped rule may flag any of it.
 *
 * The per-rule examples prove a rule catches what it aims at; they cannot prove it is not ALSO
 * catching half the language. A rule matching `$OBJ.$METHOD($$$ARGS)` passes an examples-only gate
 * with `catches: ['widget.render()']` and `allows: ['const x = 1']`, and then blocks essentially
 * every write — measured at 148 matches across this repo's own sources. Blast radius has to be
 * checked against realistic code, not against the examples an author chose.
 */
const CONFORMING = `
import { Context, Data, Effect, Layer, Schema } from 'effect'

class WidgetMissing extends Data.TaggedError('WidgetMissing')<{ readonly id: string }> {}

const WidgetSchema = Schema.Struct({
  id: Schema.String,
  size: Schema.Number,
})

class Repository extends Context.Service<Repository, { readonly find: (id: string) => Effect.Effect<unknown> }>()(
  'Repository',
) {}

const SIZES = ['small', 'large'] as const

const decodeWidget = (payload: unknown) => Schema.decodeUnknownEffect(WidgetSchema)(payload)

const findWidget = (id: string) =>
  Effect.gen(function* () {
    const repository = yield* Repository
    const raw = yield* repository.find(id)
    return yield* decodeWidget(raw)
  })

const program = findWidget('w-1').pipe(
  Effect.map((widget) => widget.size),
  Effect.catch(() => Effect.succeed(0)),
)

const testLayer = Layer.succeed(Repository, {
  find: () => Effect.fail(new WidgetMissing({ id: 'w-1' })),
})
`

describe('shipped rule corpus', () => {
  effect('no rule fires on ordinary conforming code', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      const overreaching: string[] = []
      for (const rule of rules) {
        const results = yield* assessRule(rule, [
          { code: CONFORMING, expectViolation: false, name: rule.id, path: 'src/widget.ts' },
        ])
        overreaching.push(
          ...results.filter((result) => !result.passed).map((result) => `${result.name}: ${result.detail}`),
        )
      }

      expect(overreaching).toEqual([])
    }),
  )

  effect('the exported rule-id union matches what actually ships', () =>
    Effect.gen(function* () {
      // The union is what a TypeScript config is checked against, so it drifting from the corpus
      // would mean the compiler blessing an id that no longer exists.
      const rules = yield* corpus

      expect([...SHIPPED_RULE_IDS].toSorted()).toEqual(rules.map((rule) => rule.id).toSorted())
    }),
  )

  effect('every rule carries examples of BOTH kinds', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      // A rule with only positive examples looks correct until it starts firing on innocent code,
      // so "has examples" is not enough — it must have examples it must NOT fire on.
      const lopsided = rules
        .map((rule) => EXAMPLES[rule.id])
        .flatMap((example, index) =>
          example === undefined || example.allows.length === 0 || example.catches.length === 0
            ? [rules[index]?.id ?? 'unknown']
            : [],
        )

      expect(lopsided).toEqual([])
    }),
  )

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

  // The inverse, which nothing checked: an EXAMPLES key naming a rule that does not exist is inert.
  // It reads as coverage, runs nothing, and survives a rule being renamed or deleted. Found by
  // writing the examples for `no-json-global` before the rule and watching the suite pass.
  // Extensions are scope, and scope is behaviour. `.mts` and `.cts` are TypeScript and were silently
  // unguarded — a repo using them installed falsestart and got nothing, with no signal at all.
  // `.js`/`.jsx` stay out deliberately: the four assertion rules match syntax that does not exist in
  // JavaScript, and `.js` in a TypeScript repo is usually build scripts and generated output. A repo
  // that wants them adds one config override; being silently guarded is not as easy to undo.
  effect('covers every TypeScript extension and no JavaScript one', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      const misscoped = rules.flatMap((rule) => {
        // Three rules are the inverse — they apply only to tests — so they are probed at a test path.
        const testOnly = (rule.files ?? []).some((glob) => glob.includes('.test.'))
        const at = (extension: string) => `src/a.${testOnly ? 'test.' : ''}${extension}`

        return EXTENSION_EXPECTATIONS.flatMap(([extension, covered]) =>
          appliesTo(rule, at(extension)) === covered
            ? []
            : [`${rule.id}: ${covered ? 'does not cover' : 'reaches'} .${extension}`],
        )
      })

      expect(misscoped).toEqual([])
    }),
  )

  effect('has no examples for a rule that does not exist', () =>
    Effect.gen(function* () {
      const rules = yield* corpus
      const ids = new Set(rules.map((rule) => rule.id))

      expect(Object.keys(EXAMPLES).filter((id) => !ids.has(id))).toEqual([])
    }),
  )
})
