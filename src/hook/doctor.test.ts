/**
 * The diagnostic must be honest in both directions, which is the whole reason it exists.
 *
 * A health report that says "fine" when the guard is off is worse than no report at all — it
 * converts an unnoticed failure into a confirmed one. So each case here breaks a different step and
 * asserts the diagnosis both fails and names the cause.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, effect, expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { SHIPPED_RULE_IDS } from '../checking/rule-ids.generated.ts'
import type { FreezeOutcome, Frozen } from '../freezing/index.ts'
import type { AgentId } from './decide.ts'
import type { FailurePolicy } from './respond.ts'
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
      const target = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

/** A filesystem that cannot answer "what is this?" at all — not one that answers "nothing". */
const unstattable = Layer.mergeAll(
  NodePath.layer,
  FileSystem.layerNoop({ stat: () => Effect.fail(new Error('cannot stat') as never) }),
)

const run = (options: {
  agent?: AgentId
  changelogPath?: string
  configPath?: string
  failure?: FailurePolicy
  freeze?: FreezeOutcome
  probePaths?: readonly string[]
  projectDirectory?: string
  rulesDirectory?: string
  shippedDirectories?: readonly string[]
  unresolvedRules?: string
}) =>
  diagnose({
    agent: options.agent,
    changelogPath: options.changelogPath ?? 'CHANGELOG.md',
    configPath: options.configPath,
    failure: options.failure,
    freeze: options.freeze,
    probePaths: options.probePaths,
    projectDirectory: options.projectDirectory ?? process.cwd(),
    rulesDirectory: options.rulesDirectory ?? 'rules',
    shippedDirectories: options.shippedDirectories,
    unresolvedRules: options.unresolvedRules,
    version: '0.0.0-test',
  })

/**
 * What each policy has to say about a judged write, in the words the reader will act on.
 *
 * A module-level annotated table, so a row reads as data rather than as a case buried in a loop.
 */
const POLICY_ROWS: readonly { readonly expected: string; readonly policy: FailurePolicy }[] = [
  { expected: 'a write falsestart cannot check is DENIED', policy: 'closed' },
  { expected: 'reported on stderr and proceeds', policy: 'open' },
]

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

  it.effect('names an override that targets something not loaded, without calling the guard broken', () =>
    Effect.gen(function* () {
      // The repo's own config overrides `no-json-global`, which the clean-code set does not contain.
      // This used to FAIL, and the failure was the problem: the same check runs on the judging path,
      // where the guard fails open — so the CLI exited 1, the agent runtime swallowed stderr, and
      // every write was allowed with no visible cause. Under `--fail closed` it denied them all.
      //
      // It is also an ordinary state: two hook entries share one config file, so each necessarily
      // sees overrides for rules only the other loaded. Named here, where nothing is judged, and a
      // typo looks exactly the same as the sibling entry's rule — only the reader can tell.
      const diagnosis = yield* run({ rulesDirectory: 'rules/clean-code' })

      expect(diagnosis.lines.join('\n')).toContain('no-json-global')
      expect(diagnosis.lines.join('\n')).toContain('the override does nothing')
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

  // T14 — "why was that write denied with no finding" is the question this command exists to
  // answer, and the policy is half of the answer.
  describe.each(POLICY_ROWS)('under --fail $policy', ({ expected, policy }) => {
    effect('names the policy a judged write will be answered under', () =>
      Effect.gen(function* () {
        const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json', failure: policy })

        expect(diagnosis.lines.some((line) => line.startsWith('policy'))).toBeTruthy()
        expect(diagnosis.lines.join('\n')).toContain(expected)
      }).pipe(Effect.provide(platform)),
    )
  })

  // T15 — the placement, which is the whole argument. Every failure below the header returns early,
  // and the person asking why a write was denied with no finding is precisely the one whose
  // installation is in one of those states. A policy line only a healthy run prints is one nobody
  // sees.
  it.effect('names the policy even when nothing resolved', () =>
    withTree({}, (directory) =>
      Effect.gen(function* () {
        const diagnosis = yield* run({
          configPath: 'src/testing/fixtures/empty.json',
          failure: 'closed',
          projectDirectory: directory,
          rulesDirectory: `${directory}/absent`,
        })

        expect(diagnosis.healthy).toBeFalsy()
        expect(diagnosis.lines.join('\n')).toContain('--fail closed')
      }),
    ),
  )

  // T16 — a line that appears on every healthy run is one readers stop seeing, and under the
  // default it would announce the default, which is no news at all. `--doctor`'s output is
  // byte-unchanged for everyone who does not use the flag.
  it.effect('says nothing about a policy when the caller named none', () =>
    Effect.gen(function* () {
      const diagnosis = yield* run({ configPath: 'src/testing/fixtures/empty.json' })

      expect(diagnosis.lines.some((line) => line.startsWith('policy'))).toBeFalsy()
    }),
  )

  // T17 — the one resolution failure that happens before `diagnose` is reachable at all, so a
  // caller that returned early on it produced no report whatsoever, for the single question this
  // command exists to answer.
  it.effect('reports a rules package that could not be resolved, instead of nothing at all', () =>
    withTree({}, (directory) =>
      Effect.gen(function* () {
        const diagnosis = yield* run({
          configPath: 'src/testing/fixtures/empty.json',
          failure: 'closed',
          projectDirectory: directory,
          rulesDirectory: 'pkg:@acme/nope',
          unresolvedRules: "could not resolve rules package (Cannot find module '@acme/nope/package.json')",
        })
        const report = diagnosis.lines.join('\n')

        expect(diagnosis.healthy).toBeFalsy()
        expect(report).toContain('COULD NOT RESOLVE')
        // The header survived, and nothing tried to load a directory literally named `pkg:…`.
        expect(report).toContain('--fail closed')
        expect(report).not.toContain('COULD NOT LOAD')
      }),
    ),
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
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }), shipped: [] },
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
              shipped: [],
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
            shipped: [],
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
            shipped: [],
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
            shipped: [],
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
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }), shipped: [] },
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
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }), shipped: [] },
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
          freeze: { config: frozenWith({}), rules: frozenWith({ 'a.yml': committed }), shipped: [] },
          projectDirectory: rules,
          rulesDirectory: rules,
        })).lines.join('\n')

        expect(named).toContain('config  frozen — falsestart.config.ts')
        expect(none).toContain('config  frozen — no falsestart config at HEAD')
      }),
    ),
  )
})

/**
 * Which contract the hook will run under — the question a person asking "why did my deny not block"
 * is by definition unable to answer from their command line, because they are the one who never
 * passed `--agent`.
 */
layer(platform)('the active agent contract', (it) => {
  const agentLine = (lines: readonly string[]): string => lines.find((line) => line.startsWith('agent')) ?? ''

  // T-A21 — printed unconditionally, unlike `policy`, and above every early return. This is the one
  // departure from the `--fail` precedent: a line printed only when the flag was named is absent
  // from exactly the report that needs it.
  it.effect('names the active contract, always, and above every early return', () =>
    Effect.gen(function* () {
      expect(agentLine((yield* run({})).lines)).toContain('claude-code')
      expect(agentLine((yield* run({ agent: 'copilot' })).lines)).toContain('copilot')

      const unresolved = yield* run({ agent: 'copilot', unresolvedRules: 'nope' })
      expect(agentLine(unresolved.lines)).toContain('copilot')
    }),
  )

  // T-A22 — the field names, not just the tool names. Nothing inside falsestart can VERIFY the
  // Copilot mapping, because nothing here has a real Copilot payload; what it can do is stop hiding
  // the inference in the source, so a reader can diff it against one payload in ten seconds.
  it.effect('lists the active contract’s tools with their field names, and flags an inferred table', () =>
    Effect.gen(function* () {
      const copilot = yield* run({ agent: 'copilot' })
      expect(copilot.lines).toContain(
        'tools    create (path/content), edit (path/new_str) — any other tool call is ignored',
      )
      const provisional =
        copilot.lines[copilot.lines.indexOf(copilot.lines.find((line) => line.startsWith('tools')) ?? '') + 1]
      expect(provisional).toContain('PROVISIONAL')

      const claudeCode = yield* run({})
      expect(claudeCode.lines).toContain(
        'tools    Edit (file_path/new_string), NotebookEdit (notebook_path/new_source), Write (file_path/content) — any other tool call is ignored',
      )
      expect(claudeCode.lines.some((line) => line.includes('PROVISIONAL'))).toBeFalsy()
    }),
  )

  // T-A23 — the sample has to be written in the ACTIVE contract's vocabulary. Left hand-written in
  // Claude Code's, a healthy Copilot installation reports `the sample could not be judged` and exits
  // 1 — from the one command whose whole job is saying whether the installation is healthy.
  it.effect('reports a healthy Copilot installation as healthy', () =>
    Effect.gen(function* () {
      // The same fixture the claude-code health check uses, deliberately: what is being measured is
      // the contract the sample is written in, and a second rules directory would introduce a
      // second variable — this repo's own config narrows rules the `clean-code` tree does not load.
      const diagnosis = yield* run({ agent: 'copilot' })

      expect(diagnosis.healthy).toBeTruthy()
      expect(diagnosis.lines.some((line) => line.includes('was blocked'))).toBeTruthy()
    }),
  )
})

layer(platform)('a report over more than one rule source', (it) => {
  const ruleNamed = (id: string) => `id: ${id}\nlanguage: tsx\nseverity: error\nrule:\n  pattern: $X as any\n`

  it.effect('gives each source its own row rather than one combined total', () =>
    withTree({ 'own.yml': ruleNamed('mine') }, (own) =>
      withTree({ 'shipped.yml': ruleNamed('theirs') }, (shipped) =>
        Effect.gen(function* () {
          const { lines } = yield* run({
            configPath: 'empty.config.json',
            rulesDirectory: own,
            shippedDirectories: [shipped],
          })
          const rows = lines.filter((line) => line.includes('1 loaded'))

          // Two rows, each naming its own directory. One total across both cannot answer the
          // question this block exists for — "did my own rules load, or only the preset?"
          expect(rows).toHaveLength(2)
          // The count is asserted against the directory it belongs to, not merely somewhere in the
          // same string: `toContain(shipped)` alone stayed green while the row rendered
          // `…/clean-code— 6 loaded`, the separating space eaten by the report's column padding.
          expect(rows.join('\n')).toContain(`${shipped} — 1 loaded`)
          expect(rows.join('\n')).toContain(`${own} — 1 loaded`)
        }),
      ),
    ),
  )

  it.effect('refuses an installation whose two sources define the same rule id', () =>
    withTree({ 'own.yml': ruleNamed('no-as-any') }, (own) =>
      withTree({ 'shipped.yml': ruleNamed('no-as-any') }, (shipped) =>
        Effect.gen(function* () {
          const diagnosis = yield* run({
            configPath: 'empty.config.json',
            rulesDirectory: own,
            shippedDirectories: [shipped],
          })

          expect(diagnosis.healthy).toBeFalsy()
          expect(diagnosis.lines.join('\n')).toContain('OVERLAPPING SOURCES')
          expect(diagnosis.lines.join('\n')).toContain('no-as-any')
        }),
      ),
    ),
  )

  it.effect('names every source when one of them will not load', () =>
    withTree({ 'own.yml': ruleNamed('mine') }, (own) =>
      withTree({}, (sibling) =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          // A SIBLING temp root, never `path.join(own, 'absent')`. That spelling makes `own` a
          // substring of the absent path, which already appears in the `cannot read …` reason — so
          // `toContain(own)` was satisfied by the reason alone and the test passed with the whole
          // per-source block deleted.
          const absent = path.join(sibling, 'absent')
          const diagnosis = yield* run({
            configPath: 'empty.config.json',
            rulesDirectory: own,
            shippedDirectories: [absent],
          })

          expect(diagnosis.healthy).toBeFalsy()
          expect(diagnosis.lines.join('\n')).toContain('COULD NOT LOAD')
          // Both directories: "one of your two sources is broken" is not actionable without saying
          // which two were tried, and only the broken one appears in the reason.
          expect(diagnosis.lines.join('\n')).toContain(absent)
          expect(diagnosis.lines.join('\n')).toContain(own)
        }),
      ),
    ),
  )
})

layer(platform)('the freeze block over more than one rule source', (it) => {
  it.effect('gives every shipped source its own row, saying which of the two it is', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        // A vendored preset the ref really holds and one in node_modules that it does not are
        // indistinguishable from any other line of the report, so each says so itself.
        const report = (yield* run({
          freeze: {
            config: frozenWith({}),
            rules: frozenWith({ 'a.yml': committed }),
            shipped: [
              { directory: './vendor/rules', source: frozenWith({ 'v.yml': committed }) },
              { directory: '/pkg/rules', source: { _tag: 'Unfrozen', reason: 'outside the project repository' } },
            ],
          },
          projectDirectory: rules,
          rulesDirectory: rules,
        })).lines.join('\n')

        expect(report).toContain('shipped frozen — 1 document(s) from ./vendor/rules')
        expect(report).toContain('shipped not frozen — outside the project repository')
      }),
    ),
  )

  it.effect('fails the diagnosis when a shipped source could not be read', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      Effect.gen(function* () {
        // The whole point of classifying them. A preset the ref cannot account for under `require`
        // is a guard that cannot do its job, and reporting healthy there is the failure this
        // command exists to prevent.
        const diagnosis = yield* run({
          freeze: {
            config: frozenWith({}),
            rules: frozenWith({ 'a.yml': committed }),
            shipped: [{ directory: '/pkg/rules', source: { _tag: 'Broken', reason: 'outside the repository' } }],
          },
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(diagnosis.healthy).toBeFalsy()
        expect(diagnosis.lines.join('\n')).toContain('COULD NOT BE READ — outside the repository')
      }),
    ),
  )
})

layer(platform)('which directory the scope block is relative to', (it) => {
  it.effect('names the project directory the probe paths are matched against', () =>
    withTree({ 'a.yml': committed }, (rules) =>
      withTree({}, (elsewhere) =>
        Effect.gen(function* () {
          // Without this the block is a list of counts against paths with no stated anchor, and the
          // anchor is the whole question when a rule reports zero.
          // `projectDirectory` deliberately NOT the same directory as `rulesDirectory`: bound to one
          // temp dir, the assertion cannot tell which of the two the report actually named, and the
          // whole suite stayed green with `--doctor` printing the rules directory as the anchor.
          // Under `--preset` the two are genuinely unrelated, so that mutation would have printed a
          // node_modules path.
          const report = (yield* run({ projectDirectory: elsewhere, rulesDirectory: rules })).lines.join('\n')

          expect(report).toContain(`paths below are matched relative to ${elsewhere}`)
          expect(report).not.toContain(`relative to ${rules}`)
          // The half this command cannot answer, because it reads no payload.
          expect(report).toContain("a judged write uses the payload's cwd when it carries one")
        }),
      ),
    ),
  )
})

layer(platform)('probing the paths the caller actually has', (it) => {
  const scopedTo = (glob: string) =>
    `id: monorepo-rule\nlanguage: tsx\nseverity: error\nmessage: nope\nrule:\n  pattern: $X as any\nfiles: ['${glob}']\n`

  it.effect('counts the rules that apply to a path the caller named', () =>
    withTree({ 'a.yml': scopedTo('packages/*/src/**/*.ts'), 'packages/app/src/widget.ts': '' }, (rules) =>
      Effect.gen(function* () {
        // The whole point. The built-in probes are all under `src/`, so a rule set scoped to a
        // monorepo layout reports zero against every one of them and the report says nothing an
        // adopter can act on.
        const diagnosis = yield* run({
          probePaths: ['packages/app/src/widget.ts'],
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(diagnosis.lines.join('\n')).toContain('1 rule(s) apply to packages/app/src/widget.ts')
      }),
    ),
  )

  it.effect('fails the diagnosis when a path the caller named is covered by nothing', () =>
    withTree({ 'a.yml': scopedTo('packages/*/src/**/*.ts'), 'services/api/src/widget.ts': '' }, (rules) =>
      Effect.gen(function* () {
        // Naming a path is an ASSERTION that it should be guarded — which is what makes this usable
        // as a CI check, and what the built-in probes can never be: `no rule applies to any probed
        // path` stays exit 0 precisely because a rule set scoped elsewhere is not broken.
        const diagnosis = yield* run({
          probePaths: ['services/api/src/widget.ts'],
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(diagnosis.healthy).toBeFalsy()
        expect(diagnosis.lines.join('\n')).toContain('services/api/src/widget.ts')
      }),
    ),
  )

  it.effect('stays healthy when every named path is covered', () =>
    withTree(
      { 'a.yml': scopedTo('packages/*/src/**/*.ts'), 'packages/app/src/a.ts': '', 'packages/web/src/b.ts': '' },
      (rules) =>
        Effect.gen(function* () {
          const diagnosis = yield* run({
            probePaths: ['packages/app/src/a.ts', 'packages/web/src/b.ts'],
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(diagnosis.healthy).toBeTruthy()
        }),
    ),
  )

  it.effect('keeps the built-in probes non-fatal, even beside a named one', () =>
    withTree({ 'a.yml': scopedTo('packages/*/src/**/*.ts'), 'packages/app/src/a.ts': '' }, (rules) =>
      Effect.gen(function* () {
        // The negative that protects the existing rationale: every built-in probe reports zero for
        // this rule set, and that is not a broken installation. Only the NAMED path decides.
        const diagnosis = yield* run({
          probePaths: ['packages/app/src/a.ts'],
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(diagnosis.lines.join('\n')).toContain('0 rule(s) apply to src/a.ts')
        expect(diagnosis.healthy).toBeTruthy()
      }),
    ),
  )

  it.effect('relativises an absolute named path against the project directory', () =>
    withTree({ 'a.yml': scopedTo('packages/*/src/**/*.ts'), 'packages/app/src/widget.ts': '' }, (rules) =>
      Effect.gen(function* () {
        // An absolute path is what a hook reports, so a caller pasting one from a payload must not
        // get a silent zero. Asserting the COUNT LINE, not just `healthy`: bound to `healthy` alone
        // this passed with `--path` ignored entirely, which is the shape of assertion this repo has
        // shipped green five times.
        const diagnosis = yield* run({
          probePaths: [`${rules}/packages/app/src/widget.ts`],
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(diagnosis.lines.join('\n')).toContain('1 rule(s) apply to packages/app/src/widget.ts')
        expect(diagnosis.healthy).toBeTruthy()
      }),
    ),
  )

  it.effect('separates a path that is not there from one no rule covers', () =>
    withTree({ 'a.yml': scopedTo('packages/*/src/**/*.ts') }, (rules) =>
      Effect.gen(function* () {
        // "You typed it wrong" and "your rules do not cover it" are different answers, and this is
        // the command whose whole job is keeping them apart. Reported as the same red, a mistyped
        // --path is indistinguishable from the scoping bug the flag exists to catch.
        const typo = yield* run({
          probePaths: ['packages/app/src/wigdet.ts'],
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(typo.healthy).toBeFalsy()
        expect(typo.lines.join('\n')).toContain('no such FILE')
        expect(typo.lines.join('\n')).not.toContain('no rule applies to')
      }),
    ),
  )

  it.effect('refuses a directory and a glob, which a hook never reports', () =>
    withTree({ 'a.yml': scopedTo('packages/*/src/**/*.ts'), 'packages/app/src/widget.ts': '' }, (rules) =>
      Effect.gen(function* () {
        for (const path of ['packages/app/src', 'packages/*/src/**']) {
          const diagnosis = yield* run({ probePaths: [path], projectDirectory: rules, rulesDirectory: rules })

          expect(diagnosis.healthy).toBeFalsy()
          expect(diagnosis.lines.join('\n')).toContain('no such FILE')
        }
      }),
    ),
  )

  it.effect('says nothing can reach a rule its own ignores excludes everywhere', () =>
    withTree(
      {
        'a.yml': `id: ignored-everywhere\nlanguage: tsx\nseverity: error\nmessage: nope\nrule:\n  pattern: $X as any\nfiles: ['src/**/*.ts']\nignores: ['**/*']\n`,
      },
      (rules) =>
        Effect.gen(function* () {
          // No --path value can ever make this rule apply, so telling its author to go and probe
          // for one sends them after a path that cannot exist. An over-broad `ignores` arriving
          // from a config override is exactly how a rule ends up here.
          const diagnosis = yield* run({ projectDirectory: rules, rulesDirectory: rules })
          const report = diagnosis.lines.join('\n')

          expect(report).toContain('nothing can reach: ignored-everywhere')
          expect(report).not.toContain('no probed path reaches: ignored-everywhere')
          expect(diagnosis.healthy).toBeTruthy()
        }),
    ),
  )

  it.effect('names a loaded rule that applies to none of the probed paths', () =>
    withTree({ 'a.yml': scopedTo('packages/*/src/**/*.ts') }, (rules) =>
      Effect.gen(function* () {
        // Reported, never fatal: a rule scoped somewhere none of these paths reach is an ordinary
        // state. It is named because "0 rule(s) apply" per PATH does not say which RULE is inert.
        const diagnosis = yield* run({ projectDirectory: rules, rulesDirectory: rules })

        expect(diagnosis.lines.join('\n')).toContain('monorepo-rule')
        expect(diagnosis.healthy).toBeTruthy()
      }),
    ),
  )
})

layer(platform)('a rule set that cannot guard anything', (it) => {
  it.effect('fails when the source the caller named holds no rules at all', () =>
    withTree({ 'README.md': '# not a rule' }, (rules) =>
      Effect.gen(function* () {
        // The state this whole command exists to catch: registered, silent, enforcing nothing. A
        // MISSING directory already exits 1; an empty one reported `0 loaded` and exited 0, and
        // every judged write under it was allowed in silence.
        //
        // No inference is needed here, which is what separates it from `no rule applies to any
        // probed path` — that one stays green because a rule set scoped to `lib/**` genuinely
        // guards something. Zero rules guards nothing, whatever the layout.
        const diagnosis = yield* run({ projectDirectory: rules, rulesDirectory: rules })

        expect(diagnosis.healthy).toBeFalsy()
        expect(diagnosis.lines.join('\n')).toContain('0 loaded')
        expect(diagnosis.lines.join('\n')).toContain('NOTHING TO ENFORCE')
      }),
    ),
  )

  it.effect('counts rules across every source before calling the set empty', () =>
    withTree({ 'README.md': '# not a rule' }, (own) =>
      withTree({ 'a.yml': committed }, (shipped) =>
        Effect.gen(function* () {
          // The negative. An empty `--rules` directory beside a preset that loaded is not an empty
          // rule set, and failing there would refuse a perfectly good `--preset X --rules ./mine`.
          const diagnosis = yield* run({
            projectDirectory: own,
            rulesDirectory: own,
            shippedDirectories: [shipped],
          })

          expect(diagnosis.lines.join('\n')).not.toContain('NOTHING TO ENFORCE')
        }),
      ),
    ),
  )
})
