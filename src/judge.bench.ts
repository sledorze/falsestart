/**
 * What falsestart costs on the path an agent actually walks.
 *
 * This is latency-sensitive in a way most linters are not: it runs before *every* tool call an
 * agent makes, and the cost is paid in a loop someone is watching. A regression here fails no test
 * — the agent just feels slower, and nobody attributes that to the right cause.
 *
 * Measured in-process, deliberately. Timing the binary folds in ~70ms of Node startup and bundle
 * parse that dwarfs everything and moves with the runtime, hiding the part this code controls.
 *
 * `bench` comes from `@effect/vitest` for consistency with the rest of the suite, though unlike
 * `effect()` and `layer()` it is a plain re-export of vitest's own — there is no Effect-aware
 * benchmark helper, so the Effect has to be run here.
 *
 * `runPromise` throughout, and returned rather than awaited, so vitest owns the scheduling.
 *
 * It used to be `runSync` for the judging benches, on the premise that everything on that path was
 * a synchronous Effect. That stopped being true — matching went async — and the failure was
 * SILENT in the worst way: `runSync` threw `AsyncFiberError` on every iteration, vitest recorded no
 * samples, and the summary printed `NaNx faster than …` for the three benchmarks that measure the
 * actual cost of judging. A benchmark that measures nothing looks exactly like a fast one.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { bench, describe } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { checkFile } from './checking/engine.ts'
import { loadRules } from './checking/loader.ts'
import { findViolations } from './checking/matcher.ts'
import type { Rule } from './checking/rule.ts'
import { parseRule } from './checking/rule.ts'
import { appliesTo } from './checking/scope.ts'
import { decide, judgesPayload } from './hook/decide.ts'
import { respond } from './hook/respond.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const corpus: readonly Rule[] = await Effect.runPromise(loadRules('rules').pipe(Effect.provide(platform)))

/** A realistic module rather than a one-liner: agents write files, not expressions. */
const source = [
  "import { Effect, Schema } from 'effect'",
  '',
  'const WidgetSchema = Schema.Struct({ id: Schema.String, size: Schema.Number })',
  '',
  'const findWidget = (id: string) =>',
  '  Effect.gen(function* () {',
  '    const repository = yield* Repository',
  '    return yield* repository.find(id)',
  '  })',
  '',
  'const program = findWidget("w-1").pipe(Effect.map((w) => w.size))',
].join('\n')

const file = { content: source, path: 'src/widget.ts' }

const writePayload = {
  cwd: '/repo',
  tool_input: { content: source, file_path: '/repo/src/widget.ts' },
  tool_name: 'Write',
}

const bashPayload = { cwd: '/repo', tool_input: { command: 'ls' }, tool_name: 'Bash' }

const writeInput = JSON.stringify(writePayload)
const bashInput = JSON.stringify(bashPayload)

const oneRule = Effect.runSync(
  parseRule("id: b\nlanguage: tsx\nrule:\n  pattern: $X as any\nfiles:\n  - '**/*.ts'\n", 'bench.yml'),
)

describe('the path every tool call takes', () => {
  // Most of an agent's calls are Bash/Read/Grep. They must cost nothing.
  bench('judgesPayload rejects a non-writing tool', () => {
    judgesPayload(bashPayload)
  })

  bench('appliesTo scopes one path', () => {
    appliesTo({ files: ['**/*.{ts,tsx}'], ignores: ['**/*.test.ts'] }, 'src/widget.ts')
  })
})

describe('judging one write', () => {
  bench('findViolations, one rule', () => Effect.runPromise(findViolations(oneRule, source).pipe(Effect.asVoid)))

  bench('checkFile, the full shipped corpus', () => Effect.runPromise(checkFile(corpus, file).pipe(Effect.asVoid)))

  bench('decide, payload to verdict', () => Effect.runPromise(decide(corpus, writePayload).pipe(Effect.asVoid)))
})

describe('the whole hook, as the binary runs it', () => {
  // Everything the process does after startup: parse the payload, load rules, look for a config,
  // judge, render the response. This is the number a change to falsestart can actually move.
  bench('respond, a write that gets blocked', () =>
    Effect.runPromise(
      respond({ input: writeInput, projectDirectory: '.', rulesDirectory: 'rules' }).pipe(
        Effect.asVoid,
        Effect.provide(platform),
      ),
    ),
  )

  // The common case: a tool falsestart has no opinion about. Short-circuits before loading rules.
  bench('respond, a tool it does not judge', () =>
    Effect.runPromise(
      respond({ input: bashInput, projectDirectory: '.', rulesDirectory: 'rules' }).pipe(
        Effect.asVoid,
        Effect.provide(platform),
      ),
    ),
  )
})

describe('startup work, paid once per tool call', () => {
  // Re-read every invocation, because the process is new every time. If this ever dominates, it is
  // the argument for caching — and the measurement that would justify the complexity.
  bench('loadRules over the shipped corpus', () =>
    Effect.runPromise(loadRules('rules').pipe(Effect.asVoid, Effect.provide(platform))),
  )
})
