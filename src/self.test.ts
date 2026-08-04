/**
 * falsestart passes its own rules.
 *
 * This was true by inspection and false in fact. A hand count found four source files that the
 * shipped corpus blocked — three `no-type-assertion`, one `prefer-smart-constructor` — and nothing
 * in `verify`, `lefthook` or CI had ever said so. A guard whose own codebase would be denied by it
 * is not one anybody should adopt.
 *
 * The count only stays at zero if something checks it, so this is that check rather than a note in
 * a changelog. AGENTS.md: convert every manual dogfooding proof into a permanent test.
 *
 * It runs the real corpus through the real scope overrides, so `falsestart.config.ts` is exercised
 * too — the exemption for the `@ast-grep/napi` seam in `matcher.ts` has to be a real, reviewed
 * override rather than a rule nobody enabled.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer } from 'effect'
import { checkFile } from './checking/engine.ts'
import { loadRules } from './checking/loader.ts'
import { applyScopeOverrides, findNarrowedScopes } from './config/config.ts'
import { loadDefaultConfig } from './config/config-file.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/**
 * Stryker's `inPlace` mode rewrites the real source files, and this suite reads them from disk — so
 * under mutation testing it judges Stryker's instrumentation rather than what is committed. It found
 * 13 violations in that instrumentation and failed the dry run before a single mutant could be
 * evaluated, which made the whole mutation suite unrunnable.
 *
 * The property asserted here is about the COMMITTED source; an instrumented copy is not a thing it
 * has an opinion about. `process.env` is read directly because `no-process-env` exempts test files
 * and no Effect service models "am I running inside another tool's worker".
 */
const underMutationTesting = process.env['STRYKER_MUTATOR_WORKER'] !== undefined

const sourceFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory('src', { recursive: true })
  return entries.map((entry) => `src/${entry}`).filter((file) => file.endsWith('.ts'))
})

layer(platform)('falsestart judged by its own rules', (it) => {
  it.effect.skipIf(underMutationTesting)('blocks nothing in its own source', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const shipped = yield* loadRules('rules')
      const config = yield* loadDefaultConfig('.')
      const rules = yield* applyScopeOverrides(shipped, config)

      const files = yield* sourceFiles
      const findings = yield* Effect.all(
        files.map((path) =>
          Effect.gen(function* () {
            const content = yield* fs.readFileString(path)
            const violations = yield* checkFile(rules, { content, path })
            return violations.map((violation) => `${path}: ${violation.ruleId} (${violation.line})`)
          }),
        ),
      )

      expect(findings.flat()).toEqual([])
    }),
  )

  // Both of this repo's overrides exist to exempt ONE FILE each. Neither is meant to drop a
  // language, and both had — pinned to `{ts,tsx}`, they stopped covering `.mts` and `.cts` at the
  // release that added those extensions, and every JavaScript one when `no-json-global` gained
  // them. An override replaces a rule's scope rather than merging into it, so an extension left
  // out of the restatement is silently unguarded, and the suite above cannot see it: there are no
  // `.mts` files here to go unchecked. It stayed green the entire time.
  //
  // `--doctor` now reports this for any project. Here it is asserted, because this repo's config
  // is the worked example the docs point at, and a worked example with a silent hole in it teaches
  // the hole.
  it.effect('narrows no rule to fewer languages than it ships with', () =>
    Effect.gen(function* () {
      const shipped = yield* loadRules('rules')
      const config = yield* loadDefaultConfig('.')
      const scoped = yield* applyScopeOverrides(shipped, config)

      const narrowed = findNarrowedScopes(shipped, scoped).map(
        (entry) => `${entry.ruleId} lost ${entry.lostExtensions.join(', ')}`,
      )

      expect(narrowed).toEqual([])
    }),
  )

  // The exemption must be doing real work. If `matcher.ts` ever stops needing it — because the seam
  // moved or a validated type replaced the assertion — this fails and the override should be
  // deleted rather than left behind as a permanent hole nobody re-examines.
  it.effect.skipIf(underMutationTesting)('needs every override its config declares', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const rules = yield* loadRules('rules')

      const content = yield* fs.readFileString('src/checking/matcher.ts')
      const violations = yield* checkFile(rules, { content, path: 'src/checking/matcher.ts' })

      expect(violations.map((violation) => violation.ruleId)).toContain('no-type-assertion')
    }),
  )
})
