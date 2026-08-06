/**
 * Which repository, and which path.
 *
 * A real temp filesystem throughout, and real git for the walk's `rev-parse`. Both are load-bearing:
 * the question these functions answer is what `lstat` says about a `.git` entry and what `realpath`
 * says about a directory that may not be there, and an in-memory double answers whichever of those
 * its author implemented. An earlier revision of this design used `stat` instead of `lstat` — a
 * defect a double would have carried straight through.
 */
import { spawnSync } from 'node:child_process'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { MAX_ANCHOR_WALK, resolveAnchor, resolveRulesPath } from './anchor.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/**
 * A real tree. Keys ending in `/` are directories; everything else is a file with the given content.
 *
 * The root is `realPath`ed before it is handed over, because the temp directory itself may be
 * reached through a symlink and every assertion here compares whole paths.
 */
const withTree = <A, E>(
  entries: Readonly<Record<string, string>>,
  use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-anchor-' }))

    for (const [name, contents] of Object.entries(entries)) {
      const target = path.join(root, name)
      if (name.endsWith('/')) {
        yield* fs.makeDirectory(target, { recursive: true })
      } else {
        yield* fs.makeDirectory(path.dirname(target), { recursive: true })
        yield* fs.writeFileString(target, contents)
      }
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

/** A real repository, so `rev-parse` answers the way it will in production. */
const initRepository = (directory: string) =>
  Effect.sync(() => spawnSync('git', ['init', '-q', directory], { encoding: 'utf8' }))

/**
 * The probe `cli.ts` will supply, spelled here exactly as it is there.
 *
 * It records the directories it was asked about, because "the walk costs zero extra spawns in the
 * common case" is a claim about the number of calls and nothing else can see it.
 */
const spawningRevParse = (calls: string[]) => (directory: string): string | undefined => {
  calls.push(directory)
  const result = spawnSync('git', ['--no-optional-locks', '-C', directory, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  })
  return result.status === 0 ? result.stdout.trim() : undefined
}

/** Every parent is its own repository — the only shape that walks all the way to the root. */
const echoingRevParse = (directory: string): string | undefined => directory

layer(platform)('resolving the anchor', (it) => {
  // T83 — C1. A planted `.git` gitfile in a monorepo subdirectory moves the toplevel there, and a
  // freeze that stopped at the moved toplevel would enforce the attacker's rules under the default.
  it.effect('walks over a planted gitfile onto the enclosing repository, in one rev-parse', () =>
    withTree({ 'pkg/app/.git': 'gitdir: /elsewhere/.git\n' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)
        const calls: string[] = []

        const resolved = yield* resolveAnchor(path.join(root, 'pkg', 'app'), spawningRevParse(calls))

        expect(resolved).toEqual({ anchor: 'verified', toplevel: root })
        expect(calls).toEqual([path.join(root, 'pkg')])
      }),
    ),
  )

  // T77 lives in the classification suite; this is the same fact one layer down, and it is what
  // makes the walk cost nothing in the common case.
  it.effect('stops on the first lstat when .git is a real directory', () =>
    withTree({}, (root) =>
      Effect.gen(function* () {
        yield* initRepository(root)
        const calls: string[] = []

        expect(yield* resolveAnchor(root, spawningRevParse(calls))).toEqual({ anchor: 'verified', toplevel: root })
        expect(calls).toEqual([])
      }),
    ),
  )

  // T84 — the walk gives up rather than reading some other repository.
  it.effect('returns the starting toplevel unverified when rev-parse finds nothing above', () =>
    withTree({ 'project/x.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const project = path.join(root, 'project')

        expect(yield* resolveAnchor(project, spawningRevParse([]))).toEqual({
          anchor: 'unverified',
          toplevel: project,
        })
      }),
    ),
  )

  // T84, second half: the filesystem root is an exit, not a place the loop spins on.
  it.effect('stops at the filesystem root when every parent claims to be a repository', () =>
    withTree({ 'project/x.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const project = path.join(root, 'project')

        expect(yield* resolveAnchor(project, echoingRevParse)).toEqual({ anchor: 'unverified', toplevel: project })
      }),
    ),
  )

  // T85 — C6. `stat` reports a symlinked `.git` as a directory, and an `unlink` plus one write
  // replaces the link without touching its target, so it is exactly the agent-replaceable pointer
  // this check exists to refuse.
  it.effect('treats a symlinked .git as unverified rather than as the directory it names', () =>
    withTree({ 'store/': '', 'wt/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(path.join(root, 'store'))
        yield* fs.symlink(path.join(root, 'store', '.git'), path.join(root, 'wt', '.git'))
        const worktree = path.join(root, 'wt')

        expect(yield* resolveAnchor(worktree, spawningRevParse([]))).toEqual({
          anchor: 'unverified',
          toplevel: worktree,
        })
      }),
    ),
  )

  // T86 — one visible write per level still loses at a root whose `.git` is a directory.
  it.effect('walks past a gitfile planted at every level up to the repository root', () =>
    withTree({ 'a/b/c/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(root)
        for (const level of ['a', 'a/b', 'a/b/c']) {
          yield* fs.writeFileString(path.join(root, level, '.git'), `gitdir: ${path.join(root, '.git')}\n`)
        }
        const calls: string[] = []

        const resolved = yield* resolveAnchor(path.join(root, 'a', 'b', 'c'), spawningRevParse(calls))

        expect(resolved).toEqual({ anchor: 'verified', toplevel: root })
        expect(calls).toHaveLength(3)
      }),
    ),
  )

  // T86, second half: a judged write must not be hangable by an arrangement of paths.
  it.effect('gives up unverified rather than walking further than MAX_ANCHOR_WALK', () =>
    withTree({ 'store/': '' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(path.join(root, 'store'))

        const depth = MAX_ANCHOR_WALK + 4
        let deepest = root
        for (let level = 0; level < depth; level += 1) {
          deepest = path.join(deepest, `level-${level}`)
          yield* fs.makeDirectory(deepest, { recursive: true })
          yield* fs.writeFileString(path.join(deepest, '.git'), `gitdir: ${path.join(root, 'store', '.git')}\n`)
        }
        const calls: string[] = []

        expect(yield* resolveAnchor(deepest, spawningRevParse(calls))).toEqual({
          anchor: 'unverified',
          toplevel: deepest,
        })
        expect(calls.length).toBeLessThanOrEqual(MAX_ANCHOR_WALK)
      }),
    ),
  )
})

layer(platform)('deriving the path the ref is asked about', (it) => {
  // T87 — C5b. `rm -rf rules` made an earlier revision fall back to the working tree under
  // `require`, whose entire purpose is refusing what it cannot verify.
  it.effect('names the path the command line gave even when nothing is there', () =>
    withTree({ 'keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const derived = yield* resolveRulesPath({ named: './rules', projectReal: root, toplevelReal: root })

        expect(derived).toEqual({ _tag: 'Contained', relative: 'rules' })
      }),
    ),
  )

  it.effect('names the same path when the directory really is there', () =>
    withTree({ 'rules/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const derived = yield* resolveRulesPath({ named: './rules', projectReal: root, toplevelReal: root })

        expect(derived).toEqual({ _tag: 'Contained', relative: 'rules' })
      }),
    ),
  )

  // T88 — C5a. `ln -s .weak rules` made falsestart ask the ref about a directory the attacker chose.
  it.effect('refuses a rules directory that resolves somewhere other than where it was named', () =>
    withTree({ '.weak/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.symlink(path.join(root, '.weak'), path.join(root, 'rules'))

        const derived = yield* resolveRulesPath({ named: './rules', projectReal: root, toplevelReal: root })

        expect(derived).toEqual({ _tag: 'Diverged', real: path.join(root, '.weak') })
      }),
    ),
  )

  it.effect('reports a path the command line placed outside the repository', () =>
    withTree({ 'inside/keep.txt': 'x', 'outside/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const derived = yield* resolveRulesPath({
          named: '../outside',
          projectReal: path.join(root, 'inside'),
          toplevelReal: path.join(root, 'inside'),
        })

        expect(derived).toEqual({ _tag: 'Outside' })
      }),
    ),
  )
})
