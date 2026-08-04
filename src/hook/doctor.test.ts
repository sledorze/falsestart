/**
 * The diagnostic must be honest in both directions, which is the whole reason it exists.
 *
 * A health report that says "fine" when the guard is off is worse than no report at all — it
 * converts an unnoticed failure into a confirmed one. So each case here breaks a different step and
 * asserts the diagnosis both fails and names the cause.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer } from 'effect'
import { SHIPPED_RULE_IDS } from '../checking/rule-ids.generated.ts'
import { diagnose } from './doctor.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** A filesystem that cannot answer "what is this?" at all — not one that answers "nothing". */
const unstattable = Layer.mergeAll(
  NodePath.layer,
  FileSystem.layerNoop({ stat: () => Effect.fail(new Error('cannot stat') as never) }),
)

const run = (options: {
  changelogPath?: string
  configPath?: string
  projectDirectory?: string
  rulesDirectory?: string
}) =>
  diagnose({
    changelogPath: options.changelogPath ?? 'CHANGELOG.md',
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
      expect(report).toContain(`${SHIPPED_RULE_IDS.length} loaded`)
      // The end-to-end proof, not a restatement of the config.
      expect(report).toContain('was blocked')
    }),
  )

  // `--doctor` is what a consumer runs to verify an upgrade — it is where they learn the version
  // they now have. A minor bump that adds an `error`-severity rule makes a previously-passing repo
  // red, and 0.2.0 did exactly that twice with nothing in the report to say where to read about it.
  it.effect('points at the release notes for the version it is reporting', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({})
      const reported = diagnosis.lines.find((line) => line.startsWith('changes'))

      expect(reported).toBeDefined()
      expect(reported).toContain('CHANGELOG.md')
    }),
  )

  it.effect('says nothing about release notes when the installation has none', () =>
    Effect.gen(function* () {
      // The negative that keeps the pointer worth following: an install without the file must not
      // be told to go read it. A path printed for a file that is not there is worse than silence —
      // it sends the reader looking for the one artifact that would have answered the question.
      const diagnosis = yield* run({ changelogPath: 'no/such/CHANGELOG.md' })

      expect(diagnosis.lines.some((line) => line.startsWith('changes'))).toBeFalsy()
      expect(diagnosis.healthy).toBeTruthy()
    }),
  )

  it.effect('treats a filesystem it cannot even question as an installation with no notes', () =>
    Effect.gen(function* () {
      // A path that cannot be stat'd and a file that is not there leave the reader in the same
      // place, so they get the same answer. The alternative is a diagnostic that dies on a line
      // it prints as a courtesy — and this one is the only report available when things are broken.
      const diagnosis = yield* run({}).pipe(Effect.provide(unstattable))

      expect(diagnosis.lines.some((line) => line.startsWith('changes'))).toBeFalsy()
    }),
  )

  it.effect('does not mistake a directory of that name for release notes', () =>
    Effect.gen(function* () {
      // `exists` says yes to a directory, so the claim "printed only when the file is really there"
      // was false as written before this. Cheap to get right, and the report is the one place where
      // a claim that is nearly true is worth least.
      const diagnosis = yield* run({ changelogPath: 'docs' })

      expect(diagnosis.lines.some((line) => line.startsWith('changes'))).toBeFalsy()
    }),
  )

  it.effect('says nothing about release notes when the caller names none', () =>
    Effect.gen(function* () {
      // `changelogPath` is optional on the published `DiagnoseOptions`: a required field would be a
      // compile error in every library caller written before it existed. Omitting it has to be a
      // supported call, not an accident that happens to work.
      const diagnosis = yield* diagnose({
        configPath: 'src/testing/fixtures/empty.json',
        projectDirectory: process.cwd(),
        rulesDirectory: 'rules',
        version: '0.0.0-test',
      })

      expect(diagnosis.lines.some((line) => line.startsWith('changes'))).toBeFalsy()
      expect(diagnosis.healthy).toBeTruthy()
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

  // A rule that cannot run under the grammar its own scope implies falls back to the grammar it
  // declares. That keeps one misconfigured rule from disabling every other rule for a file — but a
  // silent fallback is the same disease this diagnostic exists to cure, so it is stated here, once,
  // rather than on every tool call where it would become noise.
  it.effect('names a rule that will fall back to another grammar', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({
        configPath: 'src/testing/fixtures/empty.json',
        rulesDirectory: 'src/testing/fixtures/mismatched-grammar',
      })
      const reported = diagnosis.lines.find((line) => line.includes('falls back'))

      expect(reported).toBeDefined()
      expect(reported).toContain('as-any-in-javascript')
      expect(reported).toContain('.js')
      // Informational: the rule still runs, under the grammar it declares.
      expect(diagnosis.healthy).toBeTruthy()
    }),
  )

  it.effect('says nothing about grammar for a rule set that runs where it is scoped', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json' })

      expect(diagnosis.lines.join('\n')).not.toContain('falls back')
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
