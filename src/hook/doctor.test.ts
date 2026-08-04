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

  // An override REPLACES a rule's scope rather than merging with it, so writing one to add a single
  // exemption silently discards every extension the rule shipped covering. Nothing reported that.
  // This repo's own config had done it: `no-type-assertion` and `no-json-global` were pinned to
  // `{ts,tsx}` and had quietly stopped covering `.mts` and `.cts` — the two extensions a previous
  // release existed to add — with the whole suite green and the doctor calling it healthy.
  it.effect('names the extensions an override stops covering', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({ configPath: 'src/testing/fixtures/narrowing.json' })

      // Asserted as one whole line, not as substrings. `.mts` and `.js` already appear in the
      // scope block and the rule's name in the config line, so a `toContain` for each passed
      // against a doctor that reported nothing at all — checked, and it did.
      const reported = diagnosis.lines.find((line) => line.includes('stops covering'))

      expect(reported).toBeDefined()
      expect(reported).toContain('no-try-catch')
      expect(reported).toContain('.mts')
      expect(reported).toContain('.cts')
      expect(reported).toContain('.js')
      expect(reported).toContain('.jsx')
      expect(reported).toContain('.mjs')
      expect(reported).toContain('.cjs')
      // It kept the two it was scoped to, so those must NOT be listed as lost.
      expect(reported).not.toContain('.tsx')
    }),
  )

  it.effect('treats narrowing as information, not as a broken installation', () =>
    Effect.gen(function* () {
      // Narrowing is what overrides are FOR — `files: ['src/domain/**']` is the documented example.
      // Failing on it would make the feature unusable; saying nothing is how coverage disappears.
      const diagnosis = yield* run({ configPath: 'src/testing/fixtures/narrowing.json' })

      expect(diagnosis.healthy).toBeTruthy()
    }),
  )

  it.effect('says nothing about extensions when an override keeps the rule as wide as it ships', () =>
    Effect.gen(function* () {
      // The negative that keeps the report worth reading: an override that only adds a file
      // exemption has not dropped a language, and must not be reported as though it had.
      const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json' })

      expect(diagnosis.lines.join('\n')).not.toContain('stops covering')
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
