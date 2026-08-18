/**
 * Real git repositories on a real filesystem, in the shapes the guards are about.
 *
 * Separated from the assertions because a fixture is a claim about a SITUATION — "a branch that only
 * weakens a test", "a stack whose parent is not `main`" — and reading it next to the expectation it
 * feeds obscured which of the two was wrong when one failed. Named for the situation rather than the
 * mechanics, so a test reads as the sentence it is checking.
 *
 * A real repository rather than a double, deliberately: every guard here asks git a question that
 * only git can answer — what a merge-base resolves to, what a ref contains, what a deletion took
 * with it. AGENTS.md prefers the real filesystem exactly where the behaviour under test IS the
 * filesystem.
 */
import { Effect, FileSystem } from 'effect'
import { run } from './process.ts'

/**
 * A real repository with one commit, on a branch that is not `main` and has no remote — exactly the
 * shape a default `actions/checkout` produces, where `origin/main` does not exist.
 */
export const repositoryWithNoBase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-mutation-' }))

  yield* fs.makeDirectory(`${root}/src`, { recursive: true })
  yield* fs.writeFileString(`${root}/src/a.ts`, 'export const a = 1\n')
  yield* run('git', ['init', '-q', '-b', 'feature', '.'], root)
  yield* run('git', ['config', 'user.email', 'test@example.com'], root)
  yield* run('git', ['config', 'user.name', 'test'], root)
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'first'], root)

  return root
})

/**
 * A repository with a `main` to diff against, and a branch that changed only `src/a.test.ts`.
 *
 * The shape of a pull request that weakens a test and touches nothing else — which is the defect
 * this whole gate exists to catch, and the one shape a filter on "source files, tests excluded"
 * sees as an empty change set.
 */
export const branchThatOnlyWeakensATest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-mutation-' }))

  yield* fs.makeDirectory(`${root}/src`, { recursive: true })
  yield* fs.writeFileString(`${root}/src/a.ts`, 'export const a = (n: number): boolean => n > 0\n')
  yield* fs.writeFileString(`${root}/src/a.test.ts`, 'it("holds", () => expect(a(1)).toBe(true))\n')
  // A near-miss neighbour: `b.e2e.test.ts` is not the sibling test of `b.ts`, and must not be
  // treated as one.
  yield* fs.writeFileString(`${root}/src/b.ts`, 'export const b = (n: number): boolean => n < 0\n')
  yield* fs.writeFileString(`${root}/src/b.e2e.test.ts`, 'it("holds", () => expect(b(-1)).toBe(true))\n')
  yield* run('git', ['init', '-q', '-b', 'main', '.'], root)
  yield* run('git', ['config', 'user.email', 'test@example.com'], root)
  yield* run('git', ['config', 'user.name', 'test'], root)
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'first'], root)
  yield* run('git', ['checkout', '-q', '-b', 'weaken'], root)
  yield* fs.writeFileString(`${root}/src/a.test.ts`, 'it("holds", () => expect(1).toBe(1))\n')
  yield* run('git', ['commit', '-qam', 'weaken the test'], root)

  return root
})

/** The same repository, but the branch changed a test whose name has no sibling implementation. */
export const branchThatWeakensATestWithNoSubject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* branchThatOnlyWeakensATest

  yield* run('git', ['checkout', '-q', 'main'], root)
  yield* run('git', ['checkout', '-q', '-b', 'weaken-e2e'], root)
  yield* fs.writeFileString(`${root}/src/b.e2e.test.ts`, 'it("holds", () => expect(1).toBe(1))\n')
  yield* run('git', ['commit', '-qam', 'weaken the e2e test'], root)

  return root
})

/**
 * `main` → `parent` (adds `src/parent.ts`) → `child` (adds `src/child.ts`), checked out at `child`.
 *
 * The stack AGENTS.md prescribes — "if work B depends on work A landing first, branch B off A's
 * branch, not off `main`" — and the shape that makes a hard-coded `main` score the wrong thing.
 */
export const aStackedBranch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-mutation-' }))

  yield* fs.makeDirectory(`${root}/src`, { recursive: true })
  yield* fs.writeFileString(`${root}/src/base.ts`, 'export const base = 1\n')
  yield* run('git', ['init', '-q', '-b', 'main', '.'], root)
  yield* run('git', ['config', 'user.email', 'test@example.com'], root)
  yield* run('git', ['config', 'user.name', 'test'], root)
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'first'], root)
  yield* run('git', ['checkout', '-q', '-b', 'parent'], root)
  yield* fs.writeFileString(`${root}/src/parent.ts`, 'export const parent = 2\n')
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'parent work'], root)
  yield* run('git', ['checkout', '-q', '-b', 'child'], root)
  yield* fs.writeFileString(`${root}/src/child.ts`, 'export const child = 3\n')
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'child work'], root)

  return root
})

/**
 * A repository whose `main` carried a document, on a branch that deleted it and COMMITTED the
 * deletion — so the working tree is clean and nothing but a comparison against the base can see it.
 *
 * That state is the whole point. `--report-deletions` defaults to `--deletions-since HEAD`, which
 * compares the WORKING TREE against HEAD, and a CI checkout never has an uncommitted deletion in
 * it: the check ran on every pull request here and inspected nothing, printing its "nothing to
 * check" line each time. `overview.md` survives so that the directory still has a document and the
 * report is not crowded by an orphaned `_SUMMARY.md`.
 */
export const aBranchThatDeletedADocument = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-deletions-' }))

  yield* fs.writeFileString(`${root}/.cairnrc.json`, '{ "ignore": ["node_modules/**"], "roots": ["."] }')
  yield* fs.writeFileString(`${root}/_SUMMARY.md`, '# Root\n\n- [overview](overview.md)\n- [guide](guide.md)\n')
  yield* fs.writeFileString(`${root}/overview.md`, '# Overview\n\nWhat this is.\n')
  yield* fs.writeFileString(`${root}/guide.md`, '# Tuning knobs\n\nHow to tune the scanner.\n')
  yield* run('git', ['init', '-q', '-b', 'main', '.'], root)
  yield* run('git', ['config', 'user.email', 'test@example.com'], root)
  yield* run('git', ['config', 'user.name', 'test'], root)
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'first'], root)
  yield* run('git', ['checkout', '-q', '-b', 'consolidate'], root)
  yield* run('git', ['rm', '-q', 'guide.md'], root)
  yield* fs.writeFileString(`${root}/_SUMMARY.md`, '# Root\n\n- [overview](overview.md)\n')
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'consolidate'], root)

  return root
})
