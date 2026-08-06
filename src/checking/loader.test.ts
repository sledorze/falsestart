import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { loadRules, readRuleDocuments } from './loader.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** A rule tree written to a real temp directory — the thing under test is filesystem behaviour. */
const withTree = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-rules-' })

    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

const rule = (id: string) => `
id: ${id}
language: tsx
rule:
  pattern: $X as any
`

layer(platform)('rule tree loading', (it) => {
  it.effect('loads every rule in a flat directory', () =>
    withTree({ 'a.yml': rule('alpha'), 'b.yaml': rule('beta') }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['alpha', 'beta'])
      }),
    ),
  )

  it.effect('descends into subdirectories', () =>
    withTree({ 'promise/b.yml': rule('beta'), 'type/a.yml': rule('alpha') }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['beta', 'alpha'])
      }),
    ),
  )

  it.effect('ignores files that are not rule documents', () =>
    withTree({ 'README.md': '# not a rule', 'a.yml': rule('alpha'), 'notes.txt': 'hello' }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['alpha'])
      }),
    ),
  )

  it.effect('orders rules by path so output is stable across runs', () =>
    withTree({ 'a/one.yml': rule('one'), 'b/two.yml': rule('two'), 'c/three.yml': rule('three') }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['one', 'two', 'three'])
      }),
    ),
  )

  it.effect('returns an empty set for an empty directory', () =>
    withTree({}, (directory) =>
      Effect.gen(function* () {
        expect(yield* loadRules(directory)).toEqual([])
      }),
    ),
  )

  it.effect('reports every malformed rule, not just the first', () =>
    withTree(
      { 'bad1.yml': 'id: 7\nlanguage: tsx', 'bad2.yml': 'language: nope', 'ok.yml': rule('fine') },
      (directory) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(loadRules(directory))

          expect(error._tag).toBe('RuleLoadError')
          expect(error.reasons).toHaveLength(2)
          expect(error.reasons.join('\n')).toContain('bad1.yml')
          expect(error.reasons.join('\n')).toContain('bad2.yml')
        }),
    ),
  )

  it.effect('refuses a tree where two rules share an id', () =>
    withTree({ 'one.yml': rule('duplicated'), 'two.yml': rule('duplicated') }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('duplicated')
      }),
    ),
  )

  it.effect('reports a rule-shaped entry it cannot read as a document', () =>
    // A DIRECTORY named `*.yml` is listed by the walk and passes the extension test, but reading
    // it as a file fails. The walk yielding a name is not proof that a document is behind it.
    withTree({ 'looks-like.yml/inner.txt': 'not a rule' }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('looks-like.yml')
      }),
    ),
  )

  it.effect('fails when the rule directory does not exist', () =>
    withTree({}, (directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const error = yield* Effect.flip(loadRules(path.join(directory, 'absent')))

        expect(error._tag).toBe('RuleLoadError')
      }),
    ),
  )
})

layer(platform)('shared utility rules', (it) => {
  const anyKeyword = `
id: anyKeyword
rule:
  kind: predefined_type
  regex: '^any$'
`

  const usesShared = `
id: uses-shared
language: tsx
rule:
  kind: as_expression
  has:
    matches: anyKeyword
`

  it.effect('makes a util defined under _utils available to every rule in the tree', () =>
    withTree({ '_utils/any-keyword.yml': anyKeyword, 'type/uses.yml': usesShared }, (directory) =>
      Effect.gen(function* () {
        const [loaded] = yield* loadRules(directory)

        expect(loaded?.utils?.['anyKeyword']).toBeDefined()
      }),
    ),
  )

  // The negative that says where the top-level case stops. `_utils` is recognised by the FIRST path
  // segment, so a `_utils/` tucked inside a category directory is not a fragment directory at all:
  // its documents are loaded as rules, fail validation for the fields a fragment does not carry,
  // and — loading being all-or-nothing — take the whole tree with them. Someone splitting a large
  // tree by category hits this while doing what the docs recommend, which is why it is documented
  // in `docs/using-the-hook.md` rather than left to be discovered.
  //
  // Asserted on the PATH and never on the current schema message: the wording is wrong about the
  // author's actual mistake and is meant to change, and a test pinned to it would turn that
  // improvement into a failure.
  it.effect('does not treat a _utils directory below the top level as shared matchers', () =>
    withTree({ 'cat/_utils/frag.yml': anyKeyword, 'cat/uses.yml': usesShared }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('cat/_utils/frag.yml')
      }),
    ),
  )

  it.effect('does not surface util documents as rules of their own', () =>
    withTree({ '_utils/any-keyword.yml': anyKeyword, 'type/uses.yml': usesShared }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['uses-shared'])
      }),
    ),
  )

  it.effect("lets a rule's own utils win a name collision with a shared one", () =>
    withTree(
      {
        '_utils/any-keyword.yml': anyKeyword,
        'type/uses.yml': `${usesShared}utils:\n  anyKeyword:\n    kind: type_identifier\n`,
      },
      (directory) =>
        Effect.gen(function* () {
          const [loaded] = yield* loadRules(directory)

          expect(loaded?.utils?.['anyKeyword']).toEqual({ kind: 'type_identifier' })
        }),
    ),
  )

  it.effect('reports a malformed util document rather than ignoring it', () =>
    withTree({ '_utils/broken.yml': 'rule:\n  kind: x\n', 'type/uses.yml': usesShared }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('broken.yml')
      }),
    ),
  )

  it.effect('reports a shared util whose YAML is malformed', () =>
    withTree({ '_utils/bad.yml': 'id: "unterminated' }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('YAML')
      }),
    ),
  )

  it.effect('reports a shared util that is not a mapping', () =>
    withTree({ '_utils/bad.yml': '- a\n- b\n' }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('mapping')
      }),
    ),
  )

  it.effect('reports a shared util that defines no matcher', () =>
    withTree({ '_utils/bad.yml': 'id: lonely\n' }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('needs a rule')
      }),
    ),
  )

  it.effect('leaves a tree with no shared utils exactly as it was', () =>
    withTree({ 'a.yml': rule('alpha') }, (directory) =>
      Effect.gen(function* () {
        const [loaded] = yield* loadRules(directory)

        expect(loaded?.utils).toBeUndefined()
      }),
    ),
  )
})

/**
 * The frozen path: the loader is handed bytes and must not touch the working tree.
 *
 * "Must not touch" is asserted with a `FileSystem` whose every read fails, rather than by counting
 * calls — a loader that reads the tree and then ignores what it found would pass a call count and
 * still be reading the thing the freeze exists to stop reading.
 */
const unreadable = Layer.mergeAll(
  NodePath.layer,
  FileSystem.layerNoop({
    readDirectory: () => Effect.fail(new Error('the working tree must not be read') as never),
    readFileString: () => Effect.fail(new Error('the working tree must not be read') as never),
  }),
)

layer(unreadable)('rule tree loading from committed bytes', (it) => {
  // T31
  it.effect('never reads the working tree when it is given documents', () =>
    Effect.gen(function* () {
      const loaded = yield* loadRules('/no/such/place', new Map([['a.yml', rule('alpha')]]))

      expect(loaded.map((entry) => entry.id)).toEqual(['alpha'])
    }),
  )

  // T32 — validation is the loader's job on either path, not something the working tree provided.
  it.effect('still refuses two rules sharing an id', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        loadRules(
          '/no/such/place',
          new Map([
            ['a.yml', rule('same')],
            ['b.yml', rule('same')],
          ]),
        ),
      )

      expect(error.reasons.join('\n')).toContain('duplicate rule id')
    }),
  )

  // T33 — the `_utils` split is about the KEY, not about a filesystem path.
  it.effect('treats a frozen _utils document as a shared util rather than a rule', () =>
    Effect.gen(function* () {
      const loaded = yield* loadRules(
        '/no/such/place',
        new Map([
          ['_utils/shared.yml', 'id: anyKeyword\nrule:\n  kind: any\n'],
          ['a.yml', rule('alpha')],
        ]),
      )

      expect(loaded.map((entry) => entry.id)).toEqual(['alpha'])
      expect(loaded[0]?.utils).toEqual({ anyKeyword: { kind: 'any' } })
    }),
  )

  // T34 — `isRuleDocument` decides on either path, or a committed README becomes a broken rule.
  it.effect('ignores a frozen document that is not a rule document', () =>
    Effect.gen(function* () {
      const loaded = yield* loadRules(
        '/no/such/place',
        new Map([
          ['README.md', '# how these rules work\n'],
          ['a.yml', rule('alpha')],
        ]),
      )

      expect(loaded.map((entry) => entry.id)).toEqual(['alpha'])
    }),
  )
})

layer(platform)('reading a rule tree from disk', (it) => {
  // T35 — the extraction must not change the key shape, or every frozen tree fails to load for a
  // reason that looks nothing like the cause.
  it.effect('returns the keys the recursive walk produces, sorted', () =>
    withTree({ '_utils/shared.yml': 'id: u\nrule:\n  kind: any\n', 'b/c.yml': rule('c'), 'a.yml': rule('a') }, (directory) =>
      Effect.gen(function* () {
        const documents = yield* readRuleDocuments(directory)

        expect([...documents.keys()]).toEqual(['_utils/shared.yml', 'a.yml', 'b/c.yml'])
        expect(documents.get('a.yml')).toBe(rule('a'))
      }),
    ),
  )
})
