/**
 * The diagnostic must be honest in both directions, which is the whole reason it exists.
 *
 * A health report that says "fine" when the guard is off is worse than no report at all — it
 * converts an unnoticed failure into a confirmed one. So each case here breaks a different step and
 * asserts the diagnosis both fails and names the cause.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { SHIPPED_RULE_IDS } from '../checking/rule-ids.generated.ts'
import type { FreezeOutcome, Frozen } from '../freezing/index.ts'
import { diagnose } from './doctor.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** A rule tree on the real filesystem, because the report describes what `loadRules` found there. */
const withTree = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-doctor-' })

    for (const [name, contents] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(root, name), contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

/** A filesystem that cannot answer "what is this?" at all — not one that answers "nothing". */
const unstattable = Layer.mergeAll(
  NodePath.layer,
  FileSystem.layerNoop({ stat: () => Effect.fail(new Error('cannot stat') as never) }),
)

const run = (options: {
  changelogPath?: string
  configPath?: string
  freeze?: FreezeOutcome
  projectDirectory?: string
  rulesDirectory?: string
}) =>
  diagnose({
    changelogPath: options.changelogPath ?? 'CHANGELOG.md',
    configPath: options.configPath,
    freeze: options.freeze,
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

  // "23 loaded" answers how many rules are there, and stops one word short of what the reader came
  // for: whether any of them can stop a write. An evaluation of this tool read the severity table in
  // `docs/reference.md` and still concluded the model was binary deny/allow, so the fact needs a
  // surface at the moment someone asks what they have, not only a row in a table.
  it.effect('says how many of the loaded rules block and how many advise', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json' })
      // Asserted as one whole line rather than as substrings of the report. `0` and the rule count
      // both appear elsewhere in it — see the comment above the `stops covering` case, where
      // exactly that mistake passed against a doctor that reported nothing at all.
      const reported = diagnosis.lines.find((line) => line.startsWith('rules'))

      expect(reported).toBeDefined()
      expect(reported).toContain(`${SHIPPED_RULE_IDS.length} loaded`)
      // The zero is the case worth asserting: every shipped rule blocks, so this is the line the
      // reader who believes advisory rules do not exist will actually see.
      expect(reported).toContain(`(${SHIPPED_RULE_IDS.length} block, 0 advise)`)
    }),
  )

  it.effect('counts a rule that declares no severity among the ones that block', () =>
    // Three rules and not two: `severity` is optional and defaults to `error`, so a tree of one
    // declared `error` and one declared `warning` never exercises the defaulting the count has to
    // do — and no shipped rule leaves it out, so nothing else here would. It is also the only
    // assertion that the REPORT defaults it: `engine.test.ts` proves the engine does, and the
    // report computes its own count from the loaded documents rather than from a finding.
    withTree(
      {
        'advises.yml': 'id: advises\nlanguage: tsx\nseverity: warning\nrule:\n  pattern: $X as never\n',
        'blocks.yml': 'id: blocks\nlanguage: tsx\nseverity: error\nrule:\n  pattern: $X as any\n',
        'undeclared.yml': 'id: undeclared\nlanguage: tsx\nrule:\n  pattern: $X as unknown\n',
      },
      (rules) =>
        Effect.gen(function* () {
          const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json', rulesDirectory: rules })
          const reported = diagnosis.lines.find((line) => line.startsWith('rules'))

          expect(reported).toBeDefined()
          expect(reported).toContain('3 loaded (2 block, 1 advise)')
        }),
    ),
  )

  it.effect('does not explain an advisory tree as though nothing forbade the sample', () =>
    // The `rules` line above now tells this reader they have an advisory set. Reaching the
    // not-blocked branch and offering "expected unless one forbids type assertions" then names the
    // wrong cause: a `warning`-severity rule DID forbid it, matched it, and reported it — which is
    // the one outcome that line was written without.
    withTree({ 'soft.yml': 'id: soft\nlanguage: tsx\nseverity: warning\nrule:\n  pattern: $X as any\n' }, (rules) =>
      Effect.gen(function* () {
        const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json', rulesDirectory: rules })
        const reported = diagnosis.lines.find((line) => line.startsWith('check'))

        expect(reported).toBeDefined()
        expect(reported).toContain('advise')
        expect(reported).not.toContain('expected unless one forbids type assertions')
        // Advisory rules are a healthy installation, not a broken one.
        expect(diagnosis.healthy).toBeTruthy()
      }),
    ),
  )

  it.effect('fails, and names the path, when an explicit config is absent', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({ configPath: 'no/such/config.json' })

      expect(diagnosis.healthy).toBeFalsy()
      expect(diagnosis.lines.join('\n')).toContain('no/such/config.json')
    }),
  )
})

/**
 * The freeze block, which is the entire answer to "I edited a rule and nothing happened".
 *
 * The divergence list is what makes that answer specific rather than a policy statement, and it is
 * computed here and nowhere else: reporting it on every judged write would train it away, and a
 * trained-away signal is worse than none because it still looks like coverage.
 */
const frozenWith = (documents: Readonly<Record<string, string>>): Frozen => ({
  _tag: 'Frozen',
  anchor: 'verified',
  documents: new Map(Object.entries(documents)),
  ref: 'HEAD',
})

const committed = `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
files:
  - '**/*.ts'
`

layer(platform)('the doctor under a freeze', (it) => {
  // T54
  it.effect('names the ref and the document count, and reports no drift when there is none', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        const report = (yield* run({
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }) },
          projectDirectory: rules,
          rulesDirectory: rules,
        })).lines.join('\n')

        expect(report).toContain('freeze   ref     HEAD')
        expect(report).toContain('1 document(s)')
        expect(report).not.toContain('NOT in effect')
      }),
    ),
  )

  // T55 — the primary answer. Without this the report says "frozen" and leaves the reader exactly
  // where they were.
  it.effect('lists every working-tree change that is not in effect', () =>
    withTree(
      { 'a.yml': `${committed}severity: warning\n`, 'b.yml': committed.replace('no-as-any', 'other') },
      (rules) =>
        Effect.gen(function* () {
          const report = (yield* run({
            freeze: {
              config: frozenWith({}),
              rules: frozenWith({ 'a.yml': committed, 'gone.yml': committed.replace('no-as-any', 'gone') }),
            },
            projectDirectory: rules,
            rulesDirectory: rules,
          })).lines.join('\n')

          expect(report).toContain('NOT in effect')
          expect(report).toContain('changed  a.yml')
          expect(report).toContain('added    b.yml')
          expect(report).toContain('removed  gone.yml')
        }),
    ),
  )

  // T56 — a `--preset` user's rules live in node_modules and are not freezable. That is the stated
  // policy, not a broken installation.
  it.effect('prints the reason nothing was frozen and stays healthy', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        const diagnosis = yield* run({
          freeze: {
            config: { _tag: 'Unfrozen', reason: 'no falsestart config at HEAD' },
            rules: { _tag: 'Unfrozen', reason: `${rules} is not tracked at HEAD` },
          },
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(diagnosis.healthy).toBeTruthy()
        expect(diagnosis.lines.join('\n')).toContain('not frozen — ')
        expect(diagnosis.lines.join('\n')).toContain('is not tracked at HEAD')
      }),
    ),
  )

  // T57 — and a freeze that could not be read is not a clean bill of health.
  it.effect('fails the diagnosis when the freeze could not be read', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        const diagnosis = yield* run({
          freeze: {
            config: { _tag: 'Broken', reason: 'HEAD does not resolve in a repository that has refs' },
            rules: { _tag: 'Broken', reason: 'HEAD does not resolve in a repository that has refs' },
          },
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(diagnosis.healthy).toBeFalsy()
        expect(diagnosis.lines.join('\n')).toContain('COULD NOT BE READ')
      }),
    ),
  )

  // T78 — the one line a worktree user must see, because for them it is the difference between what
  // this feature claims and what it delivers. Not a failure: a linked worktree is a supported git
  // workflow, and calling it broken by default would be wrong about a correct installation.
  it.effect('reports an anchor that one write can repoint, without calling it broken', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        const diagnosis = yield* run({
          freeze: {
            config: { _tag: 'Frozen', anchor: 'unverified', documents: new Map(), ref: 'HEAD' },
            rules: { _tag: 'Frozen', anchor: 'unverified', documents: new Map([['a.yml', committed]]), ref: 'HEAD' },
          },
          projectDirectory: rules,
          rulesDirectory: rules,
        })
        const report = diagnosis.lines.join('\n')

        expect(diagnosis.healthy).toBeTruthy()
        expect(report).toContain('anchor  UNVERIFIED')
        expect(report).toContain(rules)
        expect(report).toContain('linked worktree outside its main repository')
        expect(report).toContain('--separate-git-dir')
        expect(report).toContain('--freeze require')
      }),
    ),
  )

  // T79 — printed only where it means something. A line that appears on every healthy run is one
  // readers stop seeing, and this is precisely the fact that must not be skimmed past.
  it.effect('prints no anchor line at all for an ordinary repository', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        const report = (yield* run({
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }) },
          projectDirectory: rules,
          rulesDirectory: rules,
        })).lines.join('\n')

        expect(report).not.toContain('anchor')
      }),
    ),
  )

  // Not in the design's catalogue. The rules directory can be gone entirely and the freeze still
  // holds — that is what the lexical path derivation buys — so the divergence read has to survive it.
  it.effect('reports every committed document as removed when the rules directory is gone', () =>
    withTree({}, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const report = (yield* run({
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }) },
          projectDirectory: root,
          rulesDirectory: path.join(root, 'deleted'),
        })).lines.join('\n')

        expect(report).toContain('removed  a.yml')
      }),
    ),
  )

  // And the config side of the block, which names WHICH config the ref holds.
  it.effect('names the config the ref committed, and says so when it holds none', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        const named = (yield* run({
          freeze: {
            config: frozenWith({ 'falsestart.config.ts': 'export default { rules: {} }\n' }),
            rules: frozenWith({ 'a.yml': committed }),
          },
          projectDirectory: rules,
          rulesDirectory: rules,
        })).lines.join('\n')
        const none = (yield* run({
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }) },
          projectDirectory: rules,
          rulesDirectory: rules,
        })).lines.join('\n')

        expect(named).toContain('config  frozen — falsestart.config.ts')
        expect(none).toContain('config  frozen — no falsestart config at HEAD')
      }),
    ),
  )
})
