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
import { Effect, FileSystem, Layer, Path, Schema } from 'effect'
import { checkFile } from './checking/engine.ts'
import { loadRules } from './checking/loader.ts'
import { appliesTo } from './checking/scope.ts'
import { RuleDescriptionSchema } from './checking/listing.ts'
import { parseRule, RuleSchema, SUPPORTED_LANGUAGES } from './checking/rule.ts'
import { SHIPPED_RULE_IDS } from './checking/rule-ids.generated.ts'
import { FREEZE_MODES } from './freezing/index.ts'
import { parseArguments } from './cli/options.ts'
import type { AgentId } from './hook/decide.ts'
import { AGENT_CONTRACTS, AGENTS, decide } from './hook/decide.ts'
import { diagnose } from './hook/doctor.ts'
import { FAILURE_POLICIES, respond } from './hook/respond.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** Where each contract's tool table lives, so a whole-file scan cannot read one against the other. */
const TOOL_TABLE_HEADINGS: Readonly<Record<AgentId, string>> = {
  'claude-code': '#### Claude Code (the default)',
  copilot: '#### GitHub Copilot CLI',
}

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

/** Every fenced block with the language it declares, so a block can be selected without counting. */
const fencedBlocks = (markdown: string): readonly { readonly body: string; readonly info: string }[] =>
  [...markdown.matchAll(/^```(\w*)\n([\s\S]*?)^```/gm)].map((block) => ({
    body: block[2] ?? '',
    info: block[1] ?? '',
  }))

/**
 * The output samples under one heading — chosen by WHERE they sit and how they are fenced, never
 * by what the lines inside them look like.
 *
 * That independence is the whole point. A selector that admitted only lines already shaped like a
 * finding would hand an empty set to the assertion for precisely the document that had dropped the
 * coordinates, and pass. The page fences every output sample bare and everything else with a
 * language, so "bare fence under this heading" says nothing about the format being checked.
 */
const outputSamplesUnder = (markdown: string, heading: string): readonly string[] => {
  // Two hashes at least: a rule sample inside the section is a YAML block whose first line is a
  // `# path/to/rule.yml` comment, and a one-hash split ends the section there — before the output
  // the check is about, which then reads as "no sample here" and passes.
  const section = markdown.split(heading)[1]?.split(/^#{2,6} /m)[0] ?? ''

  return fencedBlocks(section)
    .filter((block) => block.info === '')
    .map((block) => block.body.trim())
}

/** The finding lines an advisory envelope carries, which is what `decide`'s `describe` renders. */
const findingLines = (systemMessage: string): readonly string[] =>
  systemMessage.replace(/^falsestart:\n/, '').split('\n')

const ADVISORY_RULE = `
id: advises-only
language: tsx
severity: warning
message: 'as any erases the type'
rule:
  pattern: $X as any
`

/** A rule tree on the real filesystem, the same shape `respond.test.ts` uses. */
const withRules = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-documented-' })

    for (const [name, contents] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(root, name), contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

/** `[text](../src/x.ts)` — the links the docs check already tracks the content of. */
const citedSourceFiles = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/\]\(\.\.\/(src\/[^)]+\.ts)\)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

/**
 * Documents that describe what falsestart DOES, and so must cite the code that decides it.
 *
 * Classified by name rather than by content, which is the only classification that survives a new
 * document: whatever someone adds to `docs/` is in, unless it is one of the two kinds that are
 * structurally indexes rather than descriptions.
 *
 * `path` is relative to `docs/` and may name a subdirectory, which is why the exemptions compare
 * the BASENAME. Matching the whole path exempted `_SUMMARY.md` and nothing else: a first version
 * read `docs/` non-recursively, and a thirty-eight-line invention placed in `docs/guides/` passed
 * it, `cairn check` and the whole suite — the same document, one directory deeper.
 */
const isBehaviourDoc = (path: string): boolean => {
  const name = path.slice(path.lastIndexOf('/') + 1)

  return (
    name.endsWith('.md') &&
    // A summary is a digest of a doc that carries the citations itself.
    !name.endsWith('.summary.md') &&
    // The directory summary is a link index over its children.
    name !== '_SUMMARY.md' &&
    // The one-paragraph front door: it points at the other documents and describes no behaviour.
    path !== 'overview.md'
  )
}

layer(platform)('documentation covers the source', (it) => {
  /**
   * `--refs` is only armed on a doc that carries `[text](../src/x.ts)` links, so a document with
   * none tracks nothing and can never go stale — it is green on the day it is written and green
   * forever after, whatever the code does. AGENTS.md states the rule ("link a behaviour doc to the
   * code that decides the behaviour") and, until this test, nothing enforced it: a forty-line
   * document of pure invention was added to `docs/`, given a one-character summary, stamped, and
   * passed `pnpm check`, `pnpm coverage:ci` and `pnpm verify` in that state.
   *
   * This does not make a doc TRUE — no check here can. It makes the doc's claims re-checkable,
   * which is the precondition every other doc guard in this repo depends on.
   */
  it.effect('every behaviour doc cites at least one source file, so --refs has something to hash', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const documents = (yield* fs.readDirectory('docs', { recursive: true })).filter((path) => isBehaviourDoc(path))
      // The classifier is what this test is worth: widen an exemption until nothing is classified
      // and the assertion below passes over an empty set, which is the defect this file exists to
      // catch happening to the check that catches it.
      expect(documents).toEqual(expect.arrayContaining(['architecture.md', 'reference.md', 'using-the-hook.md']))

      const uncited: string[] = []

      for (const name of documents) {
        const cited = citedSourceFiles(yield* fs.readFileString(`docs/${name}`))
        if (cited.length === 0) {
          uncited.push(name)
        }
      }

      expect(uncited).toEqual([])
    }),
  )

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
        // The seventh count, and the one that proves the point of the six above it: the summary's
        // own corpus total sat at "twenty-two" against a corpus of twenty-three, two lines from a
        // sentence that was asserted here and therefore correct.
        { file: 'docs/reference.summary.md', text: `**Shipped rules:** ${word(total)}` },
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

  // The comment-matching recipe is a CLAIM about what ast-grep can do, published in a document that
  // ships inside the package — and an adoption report reached the opposite conclusion ("rules match
  // the AST, not comments") and gave up on it. So the snippet is not merely read here, it is run:
  // parsed as a rule and put through the real engine, on the two inputs whose difference is the
  // entire reason to do this structurally rather than with grep.
  it.effect('the comment-matching recipe in the hook guide really matches a comment, and only a comment', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const markdown = yield* fs.readFileString('docs/using-the-hook.md')

      const snippet = [...markdown.matchAll(/```yaml\n([\s\S]*?)```/g)]
        .map((block) => block[1] ?? '')
        .find((body) => body.includes('kind: comment'))
      expect(snippet).toBeDefined()

      const rule = yield* parseRule(snippet ?? '', 'docs/using-the-hook.md')

      const findingsFor = (content: string, path = 'src/widget.ts') =>
        checkFile([rule], { content, path }).pipe(Effect.map((findings) => findings.length))

      // Every form the prose claims, in one file.
      expect(yield* findingsFor('// eslint-disable-next-line\nconst a = 1')).toBe(1)
      expect(yield* findingsFor('/* eslint-disable */\nconst a = 1')).toBe(1)
      expect(yield* findingsFor('/** eslint-disable me */\nconst a = 1')).toBe(1)
      expect(yield* findingsFor('const a = 1 // eslint-disable-line')).toBe(1)

      // The claim that makes the recipe worth publishing: a STRING carrying the same text is a
      // different node, so the rule never sees it. A text-matching hook cannot tell them apart.
      expect(yield* findingsFor("const s = 'eslint-disable'")).toBe(0)
      expect(yield* findingsFor('// an ordinary note\nconst a = 1')).toBe(0)

      // The `files` glob, which is the line a reader copy-pastes. `checkFile` applies `appliesTo`,
      // so this is a real scope check — and without it, narrowing the published glob to `**/*.ts`
      // left this test green, leaving the eight extensions it advertises entirely unverified.
      for (const extension of ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']) {
        expect(yield* findingsFor('// eslint-disable-next-line\nconst a = 1', `src/widget.${extension}`)).toBe(1)
      }
    }),
  )

  // `docs/reference.md` opens with "Every flag, export and shipped rule". The rules are pinned by a
  // test above and the flags by the table's own reader, and the EXPORTS were pinned by nothing: seven
  // were missing when this was written, six of them added in the week's work. A document that claims
  // to be exhaustive and is not is worse than one that claims nothing, and `docs/` ships inside the
  // published `files` array.
  //
  // The library surface is read from `index.test.ts`'s own list rather than by importing the module,
  // so the two enumerations cannot drift apart quietly either: that list is already the one thing
  // that must be edited before an export can be added.
  it.effect('the reference documents every export the library surface offers', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const surface = yield* fs.readFileString('src/index.test.ts')
      const reference = yield* fs.readFileString('docs/reference.md')

      const start = surface.indexOf('toSorted()).toEqual([')
      const listed = surface.slice(start, surface.indexOf('])', start))
      const exported = [...listed.matchAll(/'([A-Za-z_][A-Za-z0-9_]*)'/g)].map((match) => match[1])

      expect(exported.length).toBeGreaterThan(50)
      expect(exported.filter((name) => !reference.includes(`\`${name}\``))).toEqual([])
    }),
  )

  // `--help` and `DecideOptions.warnUnscoped` both claimed the signal fires on every `.js` write.
  // That was true until 0.2.0 gave `clean-code` its first rules reaching JavaScript, and then went
  // quietly false in the copy most users read. A noise claim is exactly the kind that rots when the
  // rule set grows, so it is measured here rather than asserted.
  it.effect('no shipped preset leaves a .js write unscoped, whatever the help text used to say', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      for (const preset of ['clean-code', 'effect', 'all']) {
        const directory = preset === 'all' ? 'rules' : path.join('rules', preset)
        const rules = yield* loadRules(directory)

        expect(rules.some((rule) => appliesTo(rule, 'src/a.js'))).toBeTruthy()
      }

      // And the help text must not say otherwise.
      const options = yield* fs.readFileString('src/cli/options.ts')
      const help = options.slice(options.indexOf('--warn-unscoped'), options.indexOf('--version       Print'))

      expect(help).not.toContain('.js write')
    }),
  )

  // T-A18 — which tool calls get judged is the most consequential fact about this hook, and until
  // this test the docs never stated it — a reader could not tell whether their write tool was
  // covered. Anything outside the map is allowed in silence, which is indistinguishable from a
  // clean write, so a fourth write tool appearing upstream would go unguarded with no signal at all.
  //
  // Anchored per contract rather than scanned whole, for the reason the `language` row is: a
  // whole-file scan would now pick up BOTH tables and compare their union against one contract's.
  // Looped over `AGENTS` so a third contract cannot be added without a table to describe it.
  it.effect('the reference documents exactly the tool calls each contract judges', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      for (const id of AGENTS) {
        const section = reference.split(TOOL_TABLE_HEADINGS[id])[1]?.split(/^#{2,6} /m)[0] ?? ''
        const documented = [...section.matchAll(/^\| `([\w-]+)`\s+\| `(\w+)`\s+\| `(\w+)`\s+\|$/gm)].map((row) =>
          [row[1], row[2], row[3]].join('/'),
        )
        const actual = Object.entries(AGENT_CONTRACTS[id].tools).map(
          ([name, fields]) => `${name}/${fields.path}/${fields.content}`,
        )

        // Asserted first, so a renamed or moved heading fails loudly instead of comparing two empty
        // arrays and reporting success.
        expect(documented.length).toBeGreaterThan(0)
        expect(documented.toSorted()).toEqual(actual.toSorted())
      }
    }),
  )

  // T-A19 — the envelope keys, which the table above says nothing about. A reader whose Copilot
  // config names the event `PreToolUse` gets the snake_case payload, and a reference documenting
  // only the camelCase one tells them falsestart cannot read what it reads perfectly well.
  it.effect('the reference states the envelope keys the code reads, for every spelling', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      for (const id of AGENTS) {
        const section = reference.split(TOOL_TABLE_HEADINGS[id])[1]?.split(/^#{2,6} /m)[0] ?? ''
        const missing = AGENT_CONTRACTS[id].envelopes
          .flatMap((envelope) => [envelope.name, envelope.input])
          .filter((key) => !section.includes(`\`${key}\``))

        expect(missing).toEqual([])
      }
    }),
  )

  // #63 — the refusal a payload from another event gets is one string literal in `decide.ts` and
  // prose in two documents, and nothing links them: cairn hashes what a doc LINKS to, and this is
  // a claim about a MESSAGE. Quoted verbatim in the reference, from the real decision path, so the
  // sentence a reader searches for is the sentence their terminal printed.
  it.effect('the reference quotes the refusal a registration at another event really gets', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      const decision = yield* decide([], {
        hook_event_name: 'PostToolUse',
        tool_input: { content: 'const x = 1', file_path: '/repo/src/a.ts' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Report')
      expect(reference).toContain(decision._tag === 'Report' ? decision.problem : 'no refusal was produced')
    }),
  )

  // The document a person registering the hook actually reads, and deliberately weaker: it pins
  // that the guide names the event falsestart is NOT, not that it repeats the whole sentence.
  // "falsestart is a PreToolUse hook" is already there and always was; what was missing is what
  // happens when you register it somewhere else, and only the second claim distinguishes them.
  it.effect('the hook guide says what registering it at another event does', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const guide = yield* fs.readFileString('docs/using-the-hook.md')

      expect(guide).toContain('PostToolUse')
    }),
  )

  // `language` is the one required field whose legal values are a closed set, and a rule naming a
  // language falsestart cannot run is rejected at load time — so a reader who trusts a sixth entry
  // in this row writes a rule that never loads. Nothing checked the row: cairn hashes what a doc
  // LINKS to, and this is a claim about a constant in a file the reference links nowhere.
  it.effect('the reference lists exactly the languages a rule may declare', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      // Anchored to the section that makes the claim, not to the first matching line in the file:
      // `--list-rules` documents a `language` field of its own, in a table that appears earlier and
      // describes the grammar a rule DECLARES rather than the values it may take. A whole-file
      // search silently started reading that one instead, and compared the wrong cell.
      const section = reference.split('## Rule document')[1]?.split(/^#{2,6} /m)[0] ?? ''
      const row = section.split('\n').find((line) => line.startsWith('| `language`')) ?? ''
      // The row, then its Meaning cell: the field name is backticked too, and reading the whole
      // line would compare `language` against the languages.
      const meaning = row.split('|')[3] ?? ''
      const documented = [...meaning.matchAll(/`([^`]+)`/g)].flatMap((value) =>
        value[1] === undefined ? [] : [value[1]],
      )

      // Both directions, because each fails differently: a language added to the constant and not
      // to the row is an unusable feature, and one left in the row after being dropped is a rule
      // the reader will write and falsestart will refuse.
      expect(documented.toSorted()).toEqual([...SUPPORTED_LANGUAGES].toSorted())
    }),
  )

  // Two documents now say the rule format's fields are EXACTLY this list — the architecture doc
  // rests its corpus non-goal on it ("nowhere for a question about anywhere else to go"), which is
  // an argument that only holds while the enumeration is complete. Same blind spot the languages
  // row has: a claim about a schema in a file neither document links, so cairn cannot see it drift.
  it.effect('both documents enumerate exactly the fields a rule document may carry', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      // From the parser rather than from a list kept here, which would just move the drift.
      const fields = Object.keys(RuleSchema.fields)

      // The reference states them as table rows, the architecture doc as a sentence, so each is
      // read the way it is written and both must name every one.
      const reference = yield* fs.readFileString('docs/reference.md')
      const documentedRows = [...reference.matchAll(/^\| `(\w+)`\s+\| (?:yes|no)\s+\|/gm)].flatMap((row) =>
        row[1] === undefined ? [] : [row[1]],
      )

      expect(documentedRows.toSorted()).toEqual(fields.toSorted())

      // The sentence wraps, so the paragraph it opens is what has to be read — a line-bounded match
      // would silently drop whichever fields fell past the wrap and pass on a partial list.
      const explanation = yield* architecture
      const sentence = explanation.split('\n').find((line) => line.includes('fields are exactly')) ?? ''
      const paragraph = `${sentence} ${explanation.split(sentence)[1]?.split('\n\n')[0] ?? ''}`
      const named = new Set(
        [...paragraph.matchAll(/`(\w+)`/g)].flatMap((value) => (value[1] === undefined ? [] : [value[1]])),
      )

      expect(fields.filter((field) => !named.has(field))).toEqual([])
    }),
  )

  // The same blind spot the rule-document table has, one command over: `--list-rules` emits a
  // declared shape, and the table describing it is a five-row claim about that shape in a document
  // that links the schema nowhere. A field added to the document without a row here is a promise a
  // consumer cannot read; a row left behind after a field is dropped is one they will write a
  // decode against and lose.
  it.effect('the --list-rules field table lists exactly the fields the document carries', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const reference = yield* fs.readFileString('docs/reference.md')

      // Stops at the next heading, so the `#### --list-rules exit codes` rows below it — `| \`0\` |`
      // and `| \`2\` |` — cannot be read as fields.
      const section = reference.split('### `falsestart --list-rules`')[1]?.split(/^#{2,6} /m)[0] ?? ''
      const documented = [...section.matchAll(/^\| `(\w+)`\s+\|/gm)].flatMap((row) =>
        row[1] === undefined ? [] : [row[1]],
      )

      // Asserted first, so a renamed or moved heading fails loudly instead of comparing two empty
      // arrays and reporting success.
      expect(documented.length).toBeGreaterThan(0)
      expect(documented.toSorted()).toEqual(Object.keys(RuleDescriptionSchema.fields).toSorted())
    }),
  )

  // The worked example of an advisory finding is the entire fix for a reader who concluded
  // falsestart is binary deny/allow — and an example of an OUTPUT shape is a claim about the
  // binary that no documentation tool can reach. Asserted on both sides: checking only what
  // `respond` emits leaves a doc sample that quietly dropped the coordinates passing.
  it.effect('the advisory example is the envelope falsestart actually emits', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const howTo = yield* fs.readFileString('docs/using-the-hook.md')

      // Every advisory envelope on the page, selected by prefix rather than by index — this change
      // adds fences to the page, and an index would have rotted the moment it did.
      const envelopes = fencedBlocks(howTo)
        .map((block) => block.body.trim())
        .filter((body) => body.startsWith('{"systemMessage"'))

      expect(envelopes.length).toBeGreaterThan(0)
      for (const envelope of envelopes) {
        const parsed: Record<string, string> = JSON.parse(envelope)
        // Exactly one key: advice that also carried a `permissionDecision` would be a block wearing
        // the wrong envelope, which is the distinction the section exists to draw.
        expect(Object.keys(parsed)).toEqual(['systemMessage'])
        expect(parsed['systemMessage']).toMatch(/^falsestart:\n/)
      }

      const sample = outputSamplesUnder(howTo, '### Rules that advise instead of blocking')
      // Asserted before the format check, because a heading that moved or was renamed would
      // otherwise leave the check below iterating over nothing and reporting success.
      expect(sample).toHaveLength(1)
      const documented: Record<string, string> = JSON.parse(sample[0] ?? '{}')

      const emitted = yield* withRules({ 'advises.yml': ADVISORY_RULE }, (rules) =>
        respond({
          input: JSON.stringify({
            tool_input: { content: 'const x = value as any', file_path: '/repo/src/widget.ts' },
            tool_name: 'Write',
          }),
          projectDirectory: rules,
          rulesDirectory: rules,
        }),
      )
      const actual: Record<string, string> = JSON.parse(emitted.stdout ?? '{}')

      expect(emitted.exitCode).toBe(0)
      expect(Object.keys(actual)).toEqual(['systemMessage'])

      // The rule id and the message are deliberately not compared: the doc's example is
      // illustrative, and pinning its wording would fail on a perfectly correct prose edit. What
      // must agree is the LINE FORMAT, which is what a reader learns to recognise.
      for (const line of [
        ...findingLines(documented['systemMessage'] ?? ''),
        ...findingLines(actual['systemMessage'] ?? ''),
      ]) {
        expect(line).toMatch(/^\S+ \(\d+:\d+\): /)
      }
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
  /**
   * T72 — the help text and the parser drift by nothing but forgetfulness, and no doc link and no
   * content hash can see it: `--help` names three modes, the parser accepts whatever it accepts, and
   * a fourth mode added to one and not the other is invisible from both sides.
   */
  it('the freeze modes --help names are exactly the ones the parser accepts', () => {
    const help = parseArguments(['--help'])
    const named = (help._tag === 'Help' ? help.text : '').match(
      /--freeze <mode>\s+Where rules and config are read from: ([^.]+)\./,
    )

    expect((named?.[1] ?? '').split(', ').toSorted()).toEqual([...FREEZE_MODES].toSorted())
  })

  /**
   * T4 — the same drift, one flag over. `--fail` is the switch a reader reaches for when a write was
   * denied with no finding, and a policy the help text names but the parser refuses would send them
   * to a second failure.
   */
  it('the --fail policies --help names are exactly the ones the parser accepts', () => {
    const help = parseArguments(['--help'])
    const named = (help._tag === 'Help' ? help.text : '').match(
      /--fail <policy>\s+What happens when falsestart itself cannot do its job:\s+([^.]+)\./,
    )

    expect((named?.[1] ?? '').split(', ').toSorted()).toEqual([...FAILURE_POLICIES].toSorted())
  })

  /**
   * T-A20 — `--doctor` writes its sample from `contract.sample` rather than from `contract.tools`,
   * because a lookup would need a `?? …` arm no input can reach. The two therefore have to be
   * asserted equal, or the sample silently stops exercising the mapping the report just printed.
   *
   * STATED LIMITATION: this proves internal consistency, not correctness against Copilot. Nothing
   * inside falsestart can prove the latter — it has no real Copilot payload — which is why the
   * report prints the field names for a reader to check instead.
   */
  it('the doctor sample agrees with its own contract’s tool table', () => {
    for (const id of AGENTS) {
      const contract = AGENT_CONTRACTS[id]

      expect(contract.tools[contract.sample.tool]).toEqual({
        content: contract.sample.content,
        path: contract.sample.path,
      })
    }
  })

  /**
   * T-A17 — the same drift, one flag over, and the one where getting it wrong is worst: an agent
   * the help text names but the parser refuses sends a reader to a refused command line in front of
   * a runtime where every non-zero exit denies.
   */
  it('the agents --help names are exactly the ones the parser accepts', () => {
    const help = parseArguments(['--help'])
    const named = (help._tag === 'Help' ? help.text : '').match(
      /--agent <name>\s+Which agent runtime is on the other end:\s+([^.]+)\./,
    )

    expect((named?.[1] ?? '').split(', ').toSorted()).toEqual([...AGENTS].toSorted())
  })

  /**
   * T73 — `SECURITY.md` carries no summary and no link cairn could hash, so nothing else in this
   * repository can see what it claims. The framing sentence was already right; the escapes it names
   * were not, and an earlier draft pinned only the sentence that needed no pinning.
   */
  it.effect('SECURITY.md names the boundary and every way through it', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      // Whitespace-normalised, because prettier reflows this prose and a claim is a claim wherever
      // the line happens to break.
      const security = (yield* fs.readFileString('SECURITY.md')).replaceAll(/\s+/g, ' ')

      for (const claim of [
        'cannot defend against an agent that can rewrite the things which say where its rules come from',
        'can commit a weakened rule',
        'refs/remotes/*',
        'a write tool cannot replace it',
        '.claude/settings.json',
      ]) {
        expect(security).toContain(claim)
      }
    }),
  )

  /**
   * T74 — the two sentences that read as harmless and are false. The second is the one a real
   * worktree falsifies with a single `Write`.
   */
  it.effect('SECURITY.md claims neither of the two things that are not true', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const security = (yield* fs.readFileString('SECURITY.md')).replaceAll(/\s+/g, ' ')

      expect(security).not.toContain('takes a commit rather than an uncommitted edit')
      expect(security).not.toContain('an uncommitted change cannot change what is enforced')
    }),
  )
  /**
   * The remedy a refusal prints is RUN, not read.
   *
   * Six of this repository's tests have now guarded nothing, and the sixth is why this one exists:
   * three tests asserted the literal substring `--freeze=off` and nothing ever executed it, so a
   * remedy the parser refuses shipped in five documents and in every deny reason. A user whose
   * repository is blocked follows the printed instruction and gets a second failure.
   *
   * A test that asserts the CONTENT of an instruction is not a test that the instruction works.
   */
  it.effect('every --freeze remedy the tool prints is one the parser accepts', () =>
    Effect.gen(function* () {
      const refused = yield* respond({
        freeze: () =>
          Effect.succeed({
            config: { _tag: 'Broken', reason: 'HEAD does not resolve in a repository that has refs' },
            rules: { _tag: 'Broken', reason: 'HEAD does not resolve in a repository that has refs' },
            shipped: [],
          }),
        input: JSON.stringify({
          tool_input: { content: 'const x = y as any', file_path: '/r/a.ts' },
          tool_name: 'Write',
        }),
        projectDirectory: '/no/such/place',
        rulesDirectory: '/no/such/place',
      })
      const diagnosis = yield* diagnose({
        configPath: undefined,
        freeze: {
          config: { _tag: 'Frozen', anchor: 'unverified', documents: new Map(), ref: 'HEAD' },
          rules: { _tag: 'Frozen', anchor: 'unverified', documents: new Map(), ref: 'HEAD' },
          shipped: [],
        },
        projectDirectory: 'rules',
        rulesDirectory: 'rules',
        version: '0.0.0-test',
      })

      const decision: unknown = JSON.parse(refused.stdout ?? '{}')
      const reason =
        typeof decision === 'object' && decision !== null && 'hookSpecificOutput' in decision
          ? String(JSON.stringify(decision.hookSpecificOutput)).replaceAll(String.raw`\n`, ' ')
          : ''

      // Split the way a shell would, so the SEPARATOR is part of what is being tested:
      // `--freeze=off` is one argv token and `--freeze off` is two, and only one of them parses.
      const words = [reason, ...diagnosis.lines]
        .join(' ')
        .split(/\s+/)
        .map((word) => word.replace(/[.,;`'"]+$/, ''))
      const remedies = words.flatMap((word, index) =>
        word.startsWith('--freeze') ? [word.includes('=') ? [word] : [word, words[index + 1] ?? '']] : [],
      )

      // The fixture has to actually contain instructions, or an empty list would pass silently.
      expect(remedies.length).toBeGreaterThan(1)
      for (const remedy of remedies) {
        expect(parseArguments(remedy)).not.toHaveProperty('_tag', 'Invalid')
      }
    }),
  )

  /**
   * T13 — the same guard for `--fail`, whose deny reason is the one a blocked repository reads
   * first. It has to name both policies, because one of them is how the reader gets unblocked.
   */
  it.effect('every --fail remedy the tool prints is one the parser accepts, and both policies are offered', () =>
    Effect.gen(function* () {
      const refused = yield* respond({
        failure: 'closed',
        input: JSON.stringify({
          tool_input: { content: 'const x = y as any', file_path: '/r/a.ts' },
          tool_name: 'Write',
        }),
        projectDirectory: '/no/such/place',
        rulesDirectory: '/no/such/place',
      })
      const diagnosis = yield* diagnose({
        configPath: undefined,
        failure: 'closed',
        projectDirectory: 'rules',
        rulesDirectory: 'rules',
        version: '0.0.0-test',
      })

      const decision: unknown = JSON.parse(refused.stdout ?? '{}')
      const reason =
        typeof decision === 'object' && decision !== null && 'hookSpecificOutput' in decision
          ? String(JSON.stringify(decision.hookSpecificOutput)).replaceAll(String.raw`\n`, ' ')
          : ''

      const words = [reason, ...diagnosis.lines]
        .join(' ')
        .split(/\s+/)
        .map((word) => word.replace(/[.,;`'"]+$/, ''))
      const remedies = words.flatMap((word, index) =>
        word.startsWith('--fail') ? [word.includes('=') ? [word] : [word, words[index + 1] ?? '']] : [],
      )

      expect(remedies.length).toBeGreaterThan(1)
      for (const remedy of remedies) {
        expect(parseArguments(remedy)).not.toHaveProperty('_tag', 'Invalid')
      }
      // Both policies must actually be named. Without this, emptying the escape leaves the two
      // `--fail closed` occurrences in the lead and the doctor line, `length > 1` still holds, and
      // the mutant survives — with the reader who is blocked never told how to get unblocked.
      expect(new Set(remedies.map((pair) => pair.join(' ')))).toEqual(new Set(['--fail closed', '--fail open']))
    }),
  )
})
