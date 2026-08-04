/**
 * Scanning, against a real filesystem.
 *
 * A memory double would answer whatever it was told to. Every interesting case here is specifically
 * about real filesystem behaviour — a path that is gone, a directory handed in where a file was
 * meant, a symlink, a path spelled `./like/this` — so the fixtures are real temp directories.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { parseRule } from '../checking/rule.ts'
import { render, ScanExit } from './report.ts'
import { fingerprint, scan } from './scan.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const noAsAny = parseRule(
  `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,tsx}'
`,
  'test.yml',
)

const VIOLATION = 'const x = value as any'

/** A real temp directory with real files in it, torn down with the scope. */
const withFiles = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-scan-' })

    for (const [name, contents] of Object.entries(files)) {
      const full = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(full), { recursive: true })
      yield* fs.writeFileString(full, contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

layer(platform)('scanning files on disk', (it) => {
  it.effect('reports a violation in a file the hook never saw', () =>
    withFiles({ 'src/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const report = yield* scan({
          paths: [`${root}/src/a.ts`],
          projectDirectory: root,
          rules: [yield* noAsAny],
        })

        expect(report.fresh).toHaveLength(1)
        expect(report.inScope).toBe(1)
      }),
    ),
  )

  // Locks the end-to-end property, but be clear about what provides it: in this path the
  // canonicalisation comes from `realPath` (resolved for symlink scoping), not from
  // `toScopingPath`. Reverting the `./` normalisation leaves this test GREEN — checked, so that
  // nobody reads it as the guard for that bug. `scope.test.ts` is the guard; six cases there go
  // red on the same revert. This one would catch a regression in the realPath step instead.
  it.effect('finds the same violation however the path is spelled', () =>
    withFiles({ 'src/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const rules = [yield* noAsAny]
        const counts: number[] = []

        for (const spelling of [`${root}/src/a.ts`, `${root}/./src/a.ts`, `${root}//src/a.ts`]) {
          const report = yield* scan({ paths: [spelling], projectDirectory: root, rules })
          counts.push(report.fresh.length)
        }

        expect(counts).toEqual([1, 1, 1])
      }),
    ),
  )

  it.effect('counts a file that vanished between listing and reading, without failing', () =>
    withFiles({ 'src/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        // The real race: a hook computes the file list, then a rebase or a clean removes one.
        const report = yield* scan({
          paths: [`${root}/src/a.ts`, `${root}/src/gone.ts`],
          projectDirectory: root,
          rules: [yield* noAsAny],
        })

        expect(report.missing).toEqual([`${root}/src/gone.ts`])
        expect(report.scanned).toHaveLength(1)
      }),
    ),
  )

  it.effect('fails on a directory rather than reporting it clean', () =>
    withFiles({ 'src/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        // `falsestart scan src/` is the first thing anyone types. Reporting zero findings for it
        // would be a guard that examined nothing and said everything was fine.
        const error = yield* Effect.flip(
          scan({ paths: [`${root}/src`], projectDirectory: root, rules: [yield* noAsAny] }),
        )

        expect(error.reason).toBe('BadResource')
      }),
    ),
  )

  it.effect('scopes a symlink by what it points at, and reports the name it was given', () =>
    withFiles({ 'vendor/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.symlink(`${root}/vendor/a.ts`, `${root}/link.ts`)

        const ignoringVendor = yield* parseRule(
          `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,tsx}'
ignores:
  - 'vendor/**'
`,
          'test.yml',
        )

        const report = yield* scan({
          paths: [`${root}/link.ts`],
          projectDirectory: root,
          rules: [ignoringVendor],
        })

        // The ignore protects the FILE, not merely the name it was reached by.
        expect(report.fresh).toHaveLength(0)
        expect(report.inScope).toBe(0)
      }),
    ),
  )

  it.effect('leaves a file no rule is scoped to out of the in-scope count', () =>
    withFiles({ 'notes.md': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const report = yield* scan({
          paths: [`${root}/notes.md`],
          projectDirectory: root,
          rules: [yield* noAsAny],
        })

        expect(report.scanned).toHaveLength(1)
        expect(report.inScope).toBe(0)
      }),
    ),
  )

  // A rule that parses but cannot run must stop a GATE, where the same condition deliberately does
  // not stop the hook. `decide.ts` argues a typo must not hold every write in the repo hostage; a
  // scan that cannot run has to fail, or it passes everything while looking healthy.
  it.effect('fails when a rule cannot run, rather than reporting the file clean', () =>
    withFiles({ 'src/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const broken = yield* parseRule(
          `
id: broken-at-match-time
language: tsx
message: 'parses, but ast-grep rejects the body when it runs'
rule:
  matches: no-such-util
files:
  - '**/*.{ts,tsx}'
`,
          'test.yml',
        )

        const error = yield* Effect.flip(scan({ paths: [`${root}/src/a.ts`], projectDirectory: root, rules: [broken] }))

        expect(error.reason).toContain('broken-at-match-time')
      }),
    ),
  )

  // Accepting one occurrence must not accept the next. Keyed as a set, baselining a file that
  // contained two identical `as any` lines made a THIRD identical line invisible — copy-pasting
  // more of an already-accepted pattern was permanently unguarded. The written file always listed
  // one entry per occurrence; only the reader collapsed them.
  it.effect('absorbs exactly as many occurrences as it accepted, not every identical one', () =>
    withFiles({ 'src/a.ts': `${VIOLATION}\n${VIOLATION}\n` }, (root) =>
      Effect.gen(function* () {
        const rules = [yield* noAsAny]
        const path = `${root}/src/a.ts`

        const before = yield* scan({ paths: [path], projectDirectory: root, rules })
        expect(before.fresh).toHaveLength(2)

        const accepted = new Map<string, number>()
        for (const finding of before.fresh) {
          const key = fingerprint(path, finding)
          accepted.set(key, (accepted.get(key) ?? 0) + 1)
        }

        // Same file, unchanged: both are absorbed.
        const unchanged = yield* scan({ baseline: accepted, paths: [path], projectDirectory: root, rules })
        expect(unchanged.fresh).toHaveLength(0)

        // One more identical line: the extra occurrence is reported.
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(path, `${VIOLATION}\n${VIOLATION}\n${VIOLATION}\n`)

        const grown = yield* scan({ baseline: accepted, paths: [path], projectDirectory: root, rules })
        expect(grown.fresh).toHaveLength(1)
      }),
    ),
  )

  it.effect('accepts a finding the baseline already carries, and still reports a new one', () =>
    withFiles({ 'src/a.ts': VIOLATION, 'src/b.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const rules = [yield* noAsAny]
        const first = yield* scan({ paths: [`${root}/src/a.ts`], projectDirectory: root, rules })
        const accepted = new Map(first.fresh.map((finding) => [fingerprint(`${root}/src/a.ts`, finding), 1]))

        const second = yield* scan({
          baseline: accepted,
          paths: [`${root}/src/a.ts`, `${root}/src/b.ts`],
          projectDirectory: root,
          rules,
        })

        expect(second.fresh).toHaveLength(1)
        expect(render(second).exitCode).toBe(ScanExit.Violations)
      }),
    ),
  )
})

layer(platform)('the scan report', (it) => {
  it.effect('separates "clean" from "nothing was in scope"', () =>
    withFiles({ 'notes.md': VIOLATION, 'src/a.ts': 'const x = 1' }, (root) =>
      Effect.gen(function* () {
        const rules = [yield* noAsAny]

        const clean = render(yield* scan({ paths: [`${root}/src/a.ts`], projectDirectory: root, rules }))
        const inert = render(yield* scan({ paths: [`${root}/notes.md`], projectDirectory: root, rules }))
        const nothing = render(yield* scan({ paths: [], projectDirectory: root, rules }))

        // All three exit 0. The text is what has to tell them apart — a bare "0 findings" is
        // printed by a real pass, by a run that matched no rule, and by a run given no files, and
        // one of those is a guard enforcing nothing.
        expect(clean.exitCode).toBe(ScanExit.Clean)
        expect(clean.text).toContain('1 in scope')
        expect(clean.text).not.toContain('Nothing was in scope')

        expect(inert.text).toContain('0 in scope')
        expect(inert.text).toContain('Nothing was in scope')

        expect(nothing.text).toContain('scanned 0 file(s)')
        expect(nothing.text).toContain('Nothing was in scope')
      }),
    ),
  )

  it.effect('says how many files vanished before they could be read', () =>
    withFiles({ 'src/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const outcome = render(
          yield* scan({
            paths: [`${root}/src/a.ts`, `${root}/src/gone.ts`],
            projectDirectory: root,
            rules: [yield* noAsAny],
          }),
        )

        // Counted rather than silent: a gate that quietly examined fewer files than it was given
        // is the failure this report exists to make visible.
        expect(outcome.text).toContain('1 gone before it could be read')
      }),
    ),
  )

  it.effect('counts what it deliberately did not judge', () =>
    withFiles({ 'node_modules/pkg/i.ts': VIOLATION, 'src/a.ts': VIOLATION }, (root) =>
      Effect.gen(function* () {
        const outcome = render(
          yield* scan({
            paths: [`${root}/src/a.ts`, `${root}/node_modules/pkg/i.ts`],
            projectDirectory: root,
            rules: [yield* noAsAny],
          }),
        )

        // A dependency is not this repository's to answer for — but declining to judge it must be
        // stated, or "scanned everything and it was clean" and "quietly skipped half of it" look
        // the same.
        expect(outcome.text).toContain('1 excluded')
        expect(outcome.text).toContain('scanned 1 file(s)')
      }),
    ),
  )

  it.effect('names the file, line and rule of each finding', () =>
    withFiles({ 'src/a.ts': `const ok = 1\n${VIOLATION}` }, (root) =>
      Effect.gen(function* () {
        const outcome = render(
          yield* scan({ paths: [`${root}/src/a.ts`], projectDirectory: root, rules: [yield* noAsAny] }),
        )

        expect(outcome.text).toContain(`${root}/src/a.ts:2:11  no-as-any`)
        expect(outcome.exitCode).toBe(ScanExit.Violations)
      }),
    ),
  )
})
