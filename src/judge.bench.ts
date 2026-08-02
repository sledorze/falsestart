/**
 * What falsestart costs on the path an agent actually walks.
 *
 * This is a latency-sensitive tool in a way most linters are not: it runs before *every* tool call
 * an agent makes, and the cost is paid in the loop a person is watching. A regression here does not
 * fail a test — it just makes the agent feel slower, which is the kind of decay nobody attributes
 * to the right cause.
 *
 * Measured in-process, deliberately. Timing the binary folds in ~70ms of Node startup and bundle
 * parse that dwarfs everything and moves with the runtime, hiding the part this code controls.
 * The startup cost is real and worth knowing, but it is not what a change to a matcher affects.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import { bench, describe } from 'vitest'
import { checkFile } from './core/engine.ts'
import { loadRules } from './core/loader.ts'
import { findViolations } from './core/matcher.ts'
import type { Rule } from './core/rule.ts'
import { parseRule } from './core/rule.ts'
import { appliesTo } from './core/scope.ts'
import { decide, judgesPayload } from './hook/decide.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const corpus: readonly Rule[] = await Effect.runPromise(loadRules('rules').pipe(Effect.provide(platform)))

/** A realistic file rather than a one-liner: agents write modules, not expressions. */
const source = [
  "import { Effect, Layer, Schema } from 'effect'",
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

const asAny = await Effect.runPromise(
  parseRule("id: b\nlanguage: tsx\nrule:\n  pattern: $X as any\nfiles:\n  - '**/*.ts'\n", 'bench.yml'),
)

describe('the path every tool call takes', () => {
  // The overwhelming majority of an agent's calls are Bash/Read/Grep, and they must cost nothing.
  bench('judgesPayload rejects a non-writing tool', () => {
    judgesPayload(bashPayload)
  })

  bench('appliesTo scopes one path', () => {
    appliesTo({ files: ['**/*.{ts,tsx}'], ignores: ['**/*.test.ts'] }, 'src/widget.ts')
  })
})

describe('judging one write', () => {
  bench('findViolations, one rule', async () => {
    await Effect.runPromise(findViolations(asAny, source))
  })

  bench('checkFile, the full shipped corpus', async () => {
    await Effect.runPromise(checkFile(corpus, file))
  })

  // The number that decides whether the hook is felt: everything from payload to verdict, minus
  // process startup and rule loading.
  bench('decide, payload to verdict', async () => {
    await Effect.runPromise(decide(corpus, writePayload))
  })
})

describe('startup work, paid once per tool call', () => {
  // Re-read every invocation, because the process is new every time. If this ever dominates, it is
  // the argument for caching — and the measurement that would justify the complexity.
  bench('loadRules over the shipped corpus', async () => {
    await Effect.runPromise(loadRules('rules').pipe(Effect.provide(platform)))
  })
})
