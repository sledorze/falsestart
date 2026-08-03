/**
 * The diagnostic must be honest in both directions, which is the whole reason it exists.
 *
 * A health report that says "fine" when the guard is off is worse than no report at all — it
 * converts an unnoticed failure into a confirmed one. So each case here breaks a different step and
 * asserts the diagnosis both fails and names the cause.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { diagnose } from './doctor.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const run = (options: { configPath?: string; projectDirectory?: string; rulesDirectory?: string }) =>
  diagnose({
    configPath: options.configPath,
    projectDirectory: options.projectDirectory ?? process.cwd(),
    rulesDirectory: options.rulesDirectory ?? 'rules',
    version: '0.0.0-test',
  })

layer(platform)('the doctor', (it) => {
  it.effect('reports a healthy installation, and proves the pipeline rather than claiming it', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({})
      const report = diagnosis.lines.join('\n')

      expect(diagnosis.healthy).toBeTruthy()
      expect(report).toContain('falsestart 0.0.0-test')
      expect(report).toContain('20 loaded')
      // The end-to-end proof, not a restatement of the config.
      expect(report).toContain('was blocked')
    }),
  )

  it.effect('fails, and names the directory, when the rules cannot be loaded', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({ rulesDirectory: 'no/such/rules' })

      expect(diagnosis.healthy).toBeFalsy()
      expect(diagnosis.lines.join('\n')).toContain('no/such/rules')
    }),
  )

  it.effect('fails, and names the rule, when an override targets something not loaded', () =>
    Effect.gen(function* () {
      // The repo's own config overrides `no-json-global`, which the clean-code set does not contain.
      // This exact combination silently disabled the guard during a dogfooding run: the CLI exits 1,
      // the agent runtime swallows stderr, and every write is allowed with no visible cause.
      const diagnosis = yield* run({ rulesDirectory: 'rules/clean-code' })

      expect(diagnosis.healthy).toBeFalsy()
      expect(diagnosis.lines.join('\n')).toContain('no-json-global')
    }),
  )

  it.effect('reports an unreachable probe without calling the guard broken', () =>
    Effect.gen(function* () {
      // "Misses five `src/` paths" is not "misses everything". A rule set scoped to `lib/**` blocks
      // perfectly well and probes zero here, and exiting 1 on that inference called it broken.
      const diagnosis = yield* run({
        configPath: 'src/testing/fixtures/empty.json',
        rulesDirectory: 'src/testing/fixtures/unreachable',
      })

      expect(diagnosis.healthy).toBeTruthy()
      expect(diagnosis.lines.join('\n')).toContain('not under src/')
    }),
  )

  it.effect('fails when the sample cannot be judged at all', () =>
    Effect.gen(function* () {
      // A rule whose body ast-grep rejects at MATCH time parses fine, so it loads and appears in
      // every count — then every real write hits exit 1 with the reason swallowed. Collapsing this
      // into "not blocked" reported a guard that cannot run as a clean bill of health.
      const diagnosis = yield* run({
        configPath: 'src/testing/fixtures/empty.json',
        rulesDirectory: 'src/testing/fixtures/broken',
      })

      expect(diagnosis.healthy).toBeFalsy()
      expect(diagnosis.lines.join('\n')).toContain('could not be judged')
    }),
  )

  it.effect('reports the sample as an observation, not as a verdict on the installation', () =>
    Effect.gen(function* () {
      // `rules/effect` forbids no type assertion, so the sample cannot fire. An earlier version
      // told users of a perfectly working effect guard that nothing was enforcing.
      const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json', rulesDirectory: 'rules/effect' })
      const report = diagnosis.lines.join('\n')

      expect(diagnosis.healthy).toBeTruthy()
      expect(report).toContain('rule(s) that apply there — expected unless one forbids type assertions')
      expect(report).not.toContain('proves nothing')
    }),
  )

  it.effect('distinguishes a project with no config from one whose config sets no overrides', () =>
    Effect.gen(function* () {
      // Reporting only where it LOOKED made these two cases print identically, so the diagnostic was
      // silent on "did you pick up my config?" — the question a preset/override mismatch turns on.
      const none = yield* run({ projectDirectory: 'src/testing/fixtures' })

      expect(none.lines.join('\n')).toContain('no config file in src/testing/fixtures')
    }),
  )

  it.effect('says the sample proved nothing when no rule reaches the sample path', () =>
    Effect.gen(function* () {
      // `src/**.ts` guards top-level files and nothing below them. Reporting the non-block as
      // "expected unless a rule forbids type assertions" was wrong: one does, and the sample was
      // simply outside its scope — which is exactly the typo this feature exists to surface.
      const diagnosis = yield* run({
        configPath: 'src/testing/fixtures/empty.json',
        rulesDirectory: 'src/testing/fixtures/glob-typo',
      })

      expect(diagnosis.lines.join('\n')).toContain('so the sample proves nothing')
    }),
  )

  it.effect('fails, and names the path, when an explicit config is absent', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({ configPath: 'no/such/config.json' })

      expect(diagnosis.healthy).toBeFalsy()
      expect(diagnosis.lines.join('\n')).toContain('no/such/config.json')
    }),
  )
})
