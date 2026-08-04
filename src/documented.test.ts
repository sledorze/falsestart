/**
 * Every area is documented, and documentation cites only entry points.
 *
 * No documentation tool checks this. cairn verifies that a doc's links RESOLVE and that their
 * targets have not CHANGED, but nothing notices a source file that no document mentions at all —
 * a new module passes `pnpm check` and `pnpm verify` untouched. `checks.coverage` cannot express
 * it either: its kinds classify scanned markdown, so a `src/**` glob matches nothing.
 *
 * This was checked by hand three times while the architecture doc was being written, and found a
 * real gap each time — `hook/options.ts`, then `config-file.ts` and `rule-ids`, then
 * `testing/assess.ts` and `index.ts`. AGENTS.md says to convert a manual proof into a permanent
 * test rather than trusting it will be repeated. This is that.
 *
 * The second assertion is the one that keeps the first honest. Citing an entry point is what makes
 * a document stable under implementation churn; a doc that reaches past one into an internal file
 * goes stale on every edit to it, and the drift then carries no information.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Schema } from 'effect'
import { loadRules } from './checking/loader.ts'
import { SHIPPED_RULE_IDS } from './checking/rule-ids.generated.ts'
import { WRITE_TOOLS } from './hook/decide.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** The `files` array, read from the manifest rather than restated where it would drift from it. */
const packagedFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const manifest = yield* fs.readFileString('package.json')

  return yield* Effect.orDie(
    Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(manifest).pipe(
      Effect.map((parsed) => (parsed as { readonly files: readonly string[] }).files),
    ),
  )
})

/**
 * Counts as the docs spell them, because prose says "twenty-three" and not "23".
 *
 * Only the range the corpus can plausibly occupy. A count outside it fails loudly here rather than
 * silently matching nothing, which is the failure mode a lookup table invites.
 */
const NUMBER_WORDS: readonly string[] = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'twenty-one',
  'twenty-two',
  'twenty-three',
  'twenty-four',
  'twenty-five',
]

/** Root modules that are entry points in their own right, alongside every `<area>/index.ts`. */
const ROOT_ENTRY_POINTS = new Set(['src/cli.ts', 'src/index.ts'])

const isEntryPoint = (file: string): boolean => file.endsWith('/index.ts') || ROOT_ENTRY_POINTS.has(file)

const isSource = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.bench.ts')

// Requirements stay in the type and the suite's layer supplies them, rather than each effect
// providing its own and then `orDie`-ing the error away. A filesystem failure here should fail the
// test with its real cause — `PlatformError: NotFound` — not as an untyped defect.
const sourceFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory('src', { recursive: true })
  return entries.map((entry) => `src/${entry}`).filter((file) => isSource(file))
})

const architecture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString('docs/architecture.md')
})

/**
 * The commands inside the fenced block under `## Install` — what a reader actually copies.
 *
 * Structural rather than a search of the whole file: a claim about the install instruction has to
 * be anchored to the install instruction, or prose that merely mentions the command satisfies it.
 */
const installCommands = (readme: string): readonly string[] => {
  const section = readme.split(/^## /m).find((part) => part.startsWith('Install'))
  const fenced = section?.match(/```bash\n([\s\S]*?)```/)

  return (fenced?.[1] ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
}

/** `[text](../src/x.ts)` — the links the docs check already tracks the content of. */
const citedSourceFiles = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/\]\(\.\.\/(src\/[^)]+\.ts)\)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

layer(platform)('documentation covers the source', (it) => {
  it.effect('every area entry point is cited by the architecture doc', () =>
    Effect.gen(function* () {
      const cited = new Set(citedSourceFiles(yield* architecture))
      const entryPoints = (yield* sourceFiles).filter((file) => isEntryPoint(file))

      // `src/index.ts` is the library barrel; the doc describes the areas, not the barrel.
      const shouldBeCited = entryPoints.filter((file) => file !== 'src/index.ts')

      expect(shouldBeCited.filter((file) => !cited.has(file))).toEqual([])
    }),
  )

  it.effect('the architecture doc cites no file below an entry point', () =>
    Effect.gen(function* () {
      // Reaching past an entry point into an implementation file is what made this document go
      // stale on every unrelated edit, back when it named fourteen of them.
      const cited = citedSourceFiles(yield* architecture)

      expect(cited.filter((file) => !isEntryPoint(file))).toEqual([])
    }),
  )

  // The reference table is the only place a reader learns which rules exist — `--help` lists flags,
  // not rules. It is hand-maintained, and it had silently fallen two rules behind while claiming a
  // total that no longer matched: a reader would have concluded those rules did not exist.
  it.effect('the reference table lists every shipped rule', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      const undocumented = SHIPPED_RULE_IDS.filter((id) => !reference.includes(`\`${id}\``))

      expect(undocumented).toEqual([])
    }),
  )

  // Seven counts are written into the prose and exactly ONE of them was asserted — the `All N
  // rules` line below. Adding `no-effect-assertion` meant hand-editing the other six across three
  // files, found by grep; missing one would have shipped a doc that miscounts its own corpus, with
  // every check green. The single existing assertion is the proof this is cheap to guard, not a
  // reason to guard only one of them.
  it.effect('every rule count written into the docs matches the corpus', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reachesJavaScript = (rule: { readonly files?: readonly string[] | undefined }): boolean =>
        (rule.files ?? []).some((glob) => glob.includes('js'))

      const all = yield* loadRules('rules')
      // A count past the end fails loudly rather than matching nothing, which is the failure a
      // lookup table invites: a silent miss would read as "the docs say the right number".
      const word = (count: number): string => NUMBER_WORDS[count] ?? `NO-WORD-FOR-${count}`
      const capitalised = (count: number): string => {
        const spelled = word(count)
        return `${spelled.slice(0, 1).toUpperCase()}${spelled.slice(1)}`
      }

      const total = all.length
      const javascript = all.filter((rule) => reachesJavaScript(rule)).length
      const typescriptOnly = total - javascript
      const cleanCode = (yield* loadRules('rules/clean-code')).length
      const effect = (yield* loadRules('rules/effect')).length

      const claims = [
        { file: 'README.md', text: `\`clean-code\` is ${word(cleanCode)} rules` },
        { file: 'README.md', text: `\`effect\` is ${word(effect)} rules` },
        { file: 'README.md', text: `${capitalised(javascript)} of the ${word(total)} rules match JavaScript` },
        { file: 'docs/reference.md', text: `${capitalised(javascript)} of the ${word(total)} rules are scoped` },
        { file: 'docs/reference.md', text: `${capitalised(typescriptOnly)} stay TypeScript-only` },
        {
          file: 'docs/reference.summary.md',
          text: `${capitalised(javascript)} of ${word(total)} shipped rules`,
        },
      ]

      const wrong: string[] = []
      for (const claim of claims) {
        const content = yield* fs.readFileString(claim.file)
        if (!content.includes(claim.text)) {
          wrong.push(`${claim.file}: expected to say "${claim.text}"`)
        }
      }

      expect(wrong).toEqual([])
    }),
  )

  it.effect('states the rule count it actually documents', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      expect(reference).toContain(`All ${SHIPPED_RULE_IDS.length} rules are \`error\` severity`)
    }),
  )

  // A setup snippet is copy-pasted, not read. Both of these were fenced ```jsonc with a header
  // comment and trailing commas, so pasting one produced a `.claude/settings.json` that does not
  // parse — which discards every hook and permission rule in that file, not just falsestart's. The
  // failure is total and looks like nothing happening.
  it.effect('every settings snippet in the docs is valid JSON', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const invalid = yield* Effect.all(
        ['README.md', 'docs/using-the-hook.md'].map((file) =>
          Effect.gen(function* () {
            const markdown = yield* fs.readFileString(file)
            const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)```/g)]

            return blocks.flatMap((block, index) => {
              const body = block[1]
              if (body === undefined) {
                return []
              }
              const parsed = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)(body)
              return parsed._tag === 'Failure' ? [`${file} block ${index}`] : []
            })
          }),
        ),
      )

      expect(invalid.flat()).toEqual([])
    }),
  )

  // Which tool calls get judged is the most consequential fact about this hook, and until now the
  // docs never stated it — a reader could not tell whether their write tool was covered. Anything
  // outside the map is allowed in silence, which is indistinguishable from a clean write, so a
  // fourth write tool appearing upstream would go unguarded with no signal at all.
  it.effect('the reference documents exactly the tool calls that are judged', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      const documented = [...reference.matchAll(/^\| `(\w+)`\s+\| `(\w+)`\s+\| `(\w+)`\s+\|$/gm)].map((row) =>
        [row[1], row[2], row[3]].join('/'),
      )
      const actual = Object.entries(WRITE_TOOLS).map(([name, fields]) => `${name}/${fields.path}/${fields.content}`)

      expect(documented.toSorted()).toEqual(actual.toSorted())
    }),
  )

  // A README link is read on npmjs.com, where only `files` exists. `docs/` was once omitted, which
  // killed three links in the tarball; adding CONTRIBUTING/SECURITY links repeated it within the
  // hour. Nothing noticed either time, because the repo checkout resolves them fine.
  it.effect('every relative README link resolves to a file the package ships', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const readme = yield* fs.readFileString('README.md')
      const manifest = yield* fs.readFileString('package.json')
      const shipped: readonly string[] = yield* Effect.orDie(
        Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(manifest).pipe(
          Effect.map((parsed) => (parsed as { readonly files: readonly string[] }).files),
        ),
      )

      // npm always includes these regardless of `files`.
      const always = new Set(['README.md', 'LICENSE', 'package.json'])
      const targets = [...readme.matchAll(/\]\((\.\/[^)]+)\)/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1].replace('./', '')],
      )

      const unshipped = targets.filter(
        (target) => !always.has(target) && !shipped.some((entry) => target === entry || target.startsWith(`${entry}/`)),
      )

      expect(unshipped).toEqual([])
    }),
  )

  // The summary's tarball inventory is a claim about `package.json`, and cairn cannot reach it.
  // `--refs` hashes the targets of `[text](path)` LINKS, and this sentence links nothing;
  // `--prose-refs` fires on a backticked citation whose target MOVED, and it names no path at all.
  // So the doc-to-summary edge stays green while the inventory goes false, which is exactly what
  // happened: adding `CHANGELOG.md` to `files` left the summary listing a tarball that no longer
  // existed, through a full `pnpm verify` and a merged PR. Found by eye, which is the one method
  // the tooling exists to replace — so it is a test now.
  it.effect('the summary names every file the package actually ships', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const summary = yield* fs.readFileString('README.summary.md')
      const shipped = yield* packagedFiles

      // Matched on the name a reader would recognise, not the filename: the sentence says
      // "CODE_OF_CONDUCT", not "CODE_OF_CONDUCT.md", and pinning the extension would fail on prose
      // that is perfectly correct.
      const unnamed = shipped.filter((entry) => !summary.includes(entry.replace(/\.md$/, '')))

      expect(unnamed).toEqual([])
    }),
  )

  // The README told a first-time user the package was `private: true` and to install a `0.0.1`
  // tarball packed from a checkout. Both went false at the first release and nothing noticed —
  // `--refs` tracks what a doc says about SOURCE files, and this claim is about the registry.
  // Someone followed it, installed a pre-implementation copy, and reported that falsestart blocked
  // nothing; the tool was fine and the hook was wired correctly.
  //
  // The assertion is on the COMMAND BLOCK, not on the file. A first draft searched the whole
  // README for the right install string, and a README that said "do NOT run `pnpm add -D
  // @sledorze/falsestart` — install from git instead" passed it, which is the same failure with
  // the search term embedded in its own refutation. What a reader copies is the fenced block under
  // `## Install`; that is the only text worth constraining, and constraining it exactly leaves
  // prose free to mention packing or provenance without breaking the build.
  it.effect('the README install block installs the package this repo publishes', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const readme = yield* fs.readFileString('README.md')
      const summary = yield* fs.readFileString('README.summary.md')
      const manifest = yield* fs.readFileString('package.json')

      const parsed: { readonly name: string; readonly private?: boolean } = yield* Effect.orDie(
        Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(manifest).pipe(
          Effect.map((value) => value as { readonly name: string; readonly private?: boolean }),
        ),
      )

      const install = `pnpm add -D ${parsed.name}`

      expect(installCommands(readme)).toEqual([install])
      // npmjs.com does not render README.md for this package — the registry's `readme` field is
      // README.summary.md, so the page a prospective user reads is the summary. Tying the two
      // together keeps the install instruction from being fixed only where npm will not show it.
      expect(summary).toContain(install)
      // An install command for a package npm will refuse to publish is the same failure wearing a
      // different hat: the command is correct and the package is not there.
      expect(parsed.private).toBeUndefined()
    }),
  )

  it.effect('every area holds an entry point', () =>
    Effect.gen(function* () {
      const files = yield* sourceFiles
      const areas = new Set(
        files.flatMap((file) => {
          const [, area, rest] = file.split('/')
          return area !== undefined && rest !== undefined ? [area] : []
        }),
      )

      const withoutEntryPoint = [...areas].filter((area) => !files.includes(`src/${area}/index.ts`))

      expect(withoutEntryPoint).toEqual([])
    }),
  )
})
