/**
 * Which repository speaks for this directory, and which path the ref is asked about.
 *
 * A real temp filesystem and real git throughout. The questions here are what `lstat` says about a
 * `.git` entry, what a gitfile really points at, and what a repository's committed tree really
 * holds; an in-memory double answers whichever of those its author implemented, and two revisions of
 * this design were broken by exactly that kind of assumption.
 *
 * **Proximity is not evidence.** "The nearest `.git`" is a heuristic, and every arrangement below
 * that breaks it was reachable by a `Write` tool call. Authority is established from the OUTSIDE in:
 * the outermost repository speaks first, and an inner one is trusted only where the repository
 * already trusted has nothing at that path, or accounts for it as one of its own linked worktrees.
 * No question is ever put to the candidate repository itself — an agent that created it wrote every
 * answer it could give.
 */
import { spawnSync } from 'node:child_process'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { enclosingGitDirectory, MAX_ANCHOR_WALK, resolveAnchor, resolveRulesPath } from './anchor.ts'
import type { GitAnswer } from './freeze.ts'

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

const runGit = (directory: string, args: readonly string[]): GitAnswer => {
  const result = spawnSync('git', ['--no-optional-locks', '-C', directory, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  })
  return {
    failed: result.error !== undefined || result.status !== 0,
    stderr: result.stderr?.toString() ?? '',
    stdout: result.stdout ?? new Uint8Array(),
  }
}

/**
 * The two questions `cli.ts` will put to git, spelled here exactly as it does.
 *
 * Every directory asked is recorded, because "the candidate repository is never consulted" is a claim
 * about WHICH repository was asked and nothing else can see it — and it is the whole of why a chain
 * of planted repositories does not win.
 */
const asking = (asked: string[]) => ({
  listTreeAt: (repository: string, relative: string): GitAnswer => {
    asked.push(`${repository} ? ${relative}`)
    return runGit(repository, ['ls-tree', 'HEAD', '--', relative])
  },
  refExists: (repository: string): GitAnswer => runGit(repository, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']),
})

const commitAll = (directory: string) =>
  Effect.sync(() => {
    spawnSync('git', ['-C', directory, 'add', '-A'])
    spawnSync('git', ['-C', directory, '-c', 'user.email=a@b.c', '-c', 'user.name=a', 'commit', '-qm', 'first'])
  })

const anchorOf = (start: string, asked: string[] = []) =>
  resolveAnchor({ projectDirectory: start, toplevel: start, ...asking(asked) })

layer(platform)('deciding which repository speaks for a directory', (it) => {
  it.effect('an ordinary repository speaks for itself, and git is not asked anything', () =>
    withTree({ 'keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        yield* initRepository(root)
        const asked: string[] = []

        expect(yield* anchorOf(root, asked)).toEqual({ _tag: 'Anchored', anchor: 'verified', toplevel: root })
        expect(asked).toEqual([])
      }),
    ),
  )

  /**
   * The exploit this rewrite exists for: a `.git` DIRECTORY created where none was.
   *
   * The previous rule stopped at the nearest `.git` directory and called it verified, on the
   * reasoning that a write to one fails EISDIR — which is true of REPLACING a directory and says
   * nothing about creating one. Under `auto` and under `require` alike, the attacker's committed
   * rules were then enforced while `--doctor` reported a healthy frozen tree.
   */
  it.effect('refuses to let a .git DIRECTORY created at a tracked path speak', () =>
    withTree({ 'pkg/rules/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* commitAll(root)
        const pkg = path.join(root, 'pkg')
        yield* initRepository(pkg)
        yield* commitAll(pkg)
        const asked: string[] = []

        expect(yield* anchorOf(pkg, asked)).toEqual({ _tag: 'Anchored', anchor: 'verified', toplevel: root })
        expect(asked).toEqual([`${root} ? pkg`])
      }),
    ),
  )

  it.effect('refuses to let a planted .git FILE at a tracked path speak either', () =>
    withTree({ 'pkg/rules/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* commitAll(root)
        const pkg = path.join(root, 'pkg')
        yield* fs.writeFileString(path.join(pkg, '.git'), 'gitdir: /elsewhere/.git\n')

        expect(yield* anchorOf(pkg)).toEqual({ _tag: 'Anchored', anchor: 'verified', toplevel: root })
      }),
    ),
  )

  /**
   * And a chain of them, which is what makes "ask the enclosing repository" different from "ask the
   * nearest one". Every question must go to the authority established from OUTSIDE; a candidate that
   * an agent created must never be asked whether it is legitimate.
   */
  it.effect('asks only the outermost authority, however many repositories are planted below it', () =>
    withTree({ 'a/b/c/rules/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* commitAll(root)
        for (const level of ['a', 'a/b', 'a/b/c']) {
          const nested = path.join(root, level)
          yield* initRepository(nested)
          yield* commitAll(nested)
        }
        const asked: string[] = []

        const resolved = yield* anchorOf(path.join(root, 'a', 'b', 'c'), asked)

        expect(resolved).toEqual({ _tag: 'Anchored', anchor: 'verified', toplevel: root })
        expect(asked).toEqual([`${root} ? a`, `${root} ? a/b`, `${root} ? a/b/c`])
      }),
    ),
  )

  /**
   * The case that keeps this from being an outage for everyone with a dotfiles repository in `$HOME`.
   *
   * An inner repository at a path the outer one has nothing at is not shadowing anything. It is an
   * independent checkout that happens to live there, and it speaks for itself.
   */
  it.effect('lets an independent checkout at an untracked path speak for itself', () =>
    withTree({ 'dotfile.txt': 'x', 'project/rules/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* fs.writeFileString(path.join(root, '.gitignore'), 'project\n')
        yield* commitAll(root)
        const project = path.join(root, 'project')
        yield* initRepository(project)
        yield* commitAll(project)

        expect(yield* anchorOf(project)).toEqual({ _tag: 'Anchored', anchor: 'verified', toplevel: project })
      }),
    ),
  )

  it.effect('treats an outer repository with no commits as accounting for nothing', () =>
    withTree({ 'project/rules/r.yml': 'id: r\n' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)
        const project = path.join(root, 'project')
        yield* initRepository(project)
        yield* commitAll(project)

        expect(yield* anchorOf(project)).toEqual({ _tag: 'Anchored', anchor: 'verified', toplevel: project })
      }),
    ),
  )

  it.effect('trusts a real linked worktree of the authority as its own authority', () =>
    withTree({ 'keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* commitAll(root)
        const worktree = path.join(root, 'wt')
        yield* Effect.sync(() => spawnSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'wt', worktree]))

        expect((yield* fs.stat(path.join(worktree, '.git'))).type).toBe('File')
        expect(yield* anchorOf(worktree)).toEqual({ _tag: 'Anchored', anchor: 'verified', toplevel: worktree })
      }),
    ),
  )

  // The negative half AGENTS.md asks for: superficially similar, provably untouched. A directory
  // merely NAMED `worktrees` is not `<authority>/.git/worktrees`.
  it.effect('is not fooled by a gitdir under a directory named worktrees somewhere else', () =>
    withTree({ 'decoy/worktrees/fake/HEAD': 'ref: refs/heads/master\n', 'wt/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* commitAll(root)
        yield* fs.writeFileString(
          path.join(root, 'wt', '.git'),
          `gitdir: ${path.join(root, 'decoy', 'worktrees', 'fake')}\n`,
        )

        expect(yield* anchorOf(path.join(root, 'wt'))).toEqual({
          _tag: 'Anchored',
          anchor: 'verified',
          toplevel: root,
        })
      }),
    ),
  )

  it.effect('is not fooled by a gitfile whose target does not exist, or by one that is not a gitfile', () =>
    withTree({ 'a/.git': 'gitdir: /no/such/place\n', 'b/.git': 'not a gitfile at all\n', 'keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* commitAll(root)

        for (const name of ['a', 'b']) {
          expect(yield* anchorOf(path.join(root, name))).toEqual({
            _tag: 'Anchored',
            anchor: 'verified',
            toplevel: root,
          })
        }
      }),
    ),
  )

  /**
   * A repository with no enclosing repository at all and a `.git` that is not a directory: a linked
   * worktree outside its main repository, or `--separate-git-dir`. Nothing encloses it, so nothing
   * can account for it — and that is reported rather than refused, because both are supported git
   * workflows. `--freeze=require` is what refuses here.
   */
  it.effect('reports an anchor that nothing encloses and that one write can repoint', () =>
    withTree({ 'store/': '', 'wt/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* initRepository(path.join(root, 'store'))
        const worktree = path.join(root, 'wt')
        yield* fs.writeFileString(path.join(worktree, '.git'), `gitdir: ${path.join(root, 'store', '.git')}\n`)

        expect(yield* anchorOf(worktree)).toEqual({ _tag: 'Anchored', anchor: 'unverified', toplevel: worktree })
      }),
    ),
  )

  it.effect('refuses when the authority cannot be asked whether it tracks the path', () =>
    withTree({ 'pkg/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)
        yield* commitAll(root)
        const pkg = path.join(root, 'pkg')
        yield* initRepository(pkg)

        const resolved = yield* resolveAnchor({
          listTreeAt: () => ({ failed: true, stderr: 'fatal: bad object', stdout: new Uint8Array() }),
          projectDirectory: pkg,
          refExists: () => ({ failed: false, stderr: '', stdout: new Uint8Array() }),
          toplevel: pkg,
        })

        expect(resolved._tag).toBe('Ambiguous')
        expect(resolved).toHaveProperty('reason', expect.stringContaining('fatal: bad object'))
      }),
    ),
  )

  it.effect('refuses rather than following a chain deeper than MAX_ANCHOR_WALK', () =>
    withTree({}, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)

        let deepest = root
        for (let level = 0; level < MAX_ANCHOR_WALK + 2; level += 1) {
          deepest = path.join(deepest, `level-${level}`)
          yield* initRepository(deepest)
        }

        expect((yield* anchorOf(deepest))._tag).toBe('Ambiguous')
      }),
    ),
  )

  it.effect('reports an unverified anchor when nothing anywhere has a .git entry', () =>
    withTree({ 'project/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const project = path.join(root, 'project')

        expect(yield* anchorOf(project)).toEqual({ _tag: 'Anchored', anchor: 'unverified', toplevel: project })
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

/**
 * Whether there is a repository here AT ALL, asked of the filesystem rather than of git.
 *
 * This exists because git failing to answer "which repository" is not evidence that there is no
 * repository. A malformed `~/.gitconfig` makes `rev-parse` exit non-zero in every directory on the
 * machine, and reading that as "nothing to freeze" hands the working tree back to whoever wrote the
 * file. Establishing the absence POSITIVELY is what closes it, and it must not depend on matching
 * git's own prose, which is another program's text and may be reworded.
 */
layer(platform)('establishing that there is no repository at all', (it) => {
  it.effect('finds a .git directory at the path itself', () =>
    withTree({}, (root) =>
      Effect.gen(function* () {
        yield* initRepository(root)

        expect(yield* enclosingGitDirectory(root)).toBe(root)
      }),
    ),
  )

  it.effect('finds one at an ancestor', () =>
    withTree({ 'a/b/c/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* initRepository(root)

        expect(yield* enclosingGitDirectory(path.join(root, 'a', 'b', 'c'))).toBe(root)
      }),
    ),
  )

  it.effect('answers nothing when no ancestor up to the root has one', () =>
    withTree({ 'a/b/keep.txt': 'x' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path

        expect(yield* enclosingGitDirectory(path.join(root, 'a', 'b'))).toBeUndefined()
      }),
    ),
  )

  it.effect('does not count a .git FILE as a repository', () =>
    withTree({ 'wt/.git': 'gitdir: /elsewhere/.git\n' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path

        // A gitfile is a pointer an agent writes. "There is a repository here" has to rest on the
        // one thing a write cannot produce.
        expect(yield* enclosingGitDirectory(path.join(root, 'wt'))).toBeUndefined()
      }),
    ),
  )
})
