/**
 * What a scan is allowed to answer for.
 *
 * The negative cases carry the weight here. Excluding too much is silent — a gate that quietly
 * declines to judge half a repository looks exactly like a clean one — so every default has a test
 * proving it does NOT swallow a directory a project might legitimately author code in.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXCLUSIONS, parseIgnoredPaths, partitionPaths } from './exclude.ts'

const partition = (paths: readonly string[], options: { exclude?: string[]; gitignored?: Set<string> } = {}) =>
  partitionPaths({ paths, projectDirectory: '/repo', ...options })

describe('what a scan answers for', () => {
  it('never judges a dependency', () => {
    // Handed one file from node_modules, an unfiltered scan reported 34 findings in somebody
    // else's library. Nobody can act on those, and the noise is what gets a gate switched off.
    const { excluded, judged } = partition(['/repo/src/a.ts', '/repo/node_modules/pkg/src/b.ts'])

    expect(judged).toEqual(['/repo/src/a.ts'])
    expect(excluded).toEqual([{ path: '/repo/node_modules/pkg/src/b.ts', reason: 'default' }])
  })

  it('never judges anything inside .git', () => {
    expect(partition(['/repo/.git/COMMIT_EDITMSG']).judged).toEqual([])
  })

  it('judges a nested dependency of a dependency too — or rather, does not', () => {
    expect(partition(['/repo/packages/web/node_modules/x/i.ts']).judged).toEqual([])
  })

  // The defaults are two directories that cannot contain code you authored. Everything else is a
  // guess, and guessing wrong here is the inert-guard failure this whole tool exists to remove.
  it.each([
    'dist/bundle.ts',
    'build/output.ts',
    'vendor/thing.ts',
    'lib/index.ts',
    'generated/schema.ts',
    'coverage/report.ts',
  ])('still judges %s, which a project may legitimately author', (relative) => {
    expect(partition([`/repo/${relative}`]).judged).toEqual([`/repo/${relative}`])
  })

  it('keeps the defaults to the two that cannot be authored', () => {
    // A test on the list itself, so growing it is a deliberate act with a reviewer rather than a
    // quiet convenience.
    expect(DEFAULT_EXCLUSIONS).toEqual(['**/node_modules/**', '**/.git/**'])
  })

  it('honours an explicit --exclude glob', () => {
    const { excluded, judged } = partition(['/repo/src/a.ts', '/repo/legacy/b.ts'], { exclude: ['legacy/**'] })

    expect(judged).toEqual(['/repo/src/a.ts'])
    expect(excluded).toEqual([{ path: '/repo/legacy/b.ts', reason: 'excluded' }])
  })

  it('honours what the caller says git ignores, by either spelling of the path', () => {
    const relative = partition(['/repo/src/gen.ts'], { gitignored: new Set(['src/gen.ts']) })
    const absolute = partition(['/repo/src/gen.ts'], { gitignored: new Set(['/repo/src/gen.ts']) })

    expect(relative.excluded).toEqual([{ path: '/repo/src/gen.ts', reason: 'gitignored' }])
    expect(absolute.excluded).toEqual([{ path: '/repo/src/gen.ts', reason: 'gitignored' }])
  })

  it('reports the reason the reader cannot change when several apply', () => {
    const { excluded } = partition(['/repo/node_modules/x/a.ts'], {
      exclude: ['**/*.ts'],
      gitignored: new Set(['node_modules/x/a.ts']),
    })

    expect(excluded).toEqual([{ path: '/repo/node_modules/x/a.ts', reason: 'default' }])
  })

  it('excludes nothing when asked for nothing', () => {
    const paths = ['/repo/src/a.ts', '/repo/src/b.ts']

    expect(partition(paths)).toEqual({ excluded: [], judged: paths })
  })

  it('matches a relative path the same as the absolute one', () => {
    // Callers hand over whichever they have; lefthook gives repo-relative, a shell loop often
    // gives absolute, and an exclusion that worked for only one of them would be a hole.
    expect(partition(['node_modules/x/a.ts']).judged).toEqual([])
    expect(partition(['./node_modules/x/a.ts']).judged).toEqual([])
  })
})

describe("reading git's answer about what it ignores", () => {
  it('splits on NUL, because that is what -z produces', () => {
    // Newlines would be wrong: git C-quotes any non-ASCII path when asked for them, which is the
    // same trap the documented `-z`/`-0` recipe avoids one layer up.
    expect([...parseIgnoredPaths('a.ts\u0000b.ts\u0000')]).toEqual(['a.ts', 'b.ts'])
  })

  it('reads no output as nothing ignored', () => {
    // `check-ignore` exits 1 with empty output when nothing matched. An answer, not a failure.
    expect(parseIgnoredPaths('').size).toBe(0)
  })

  it('keeps a path containing a space or an accent intact', () => {
    const parsed = parseIgnoredPaths('src/two words.ts\u0000src/café.ts')

    expect([...parsed]).toEqual(['src/two words.ts', 'src/café.ts'])
  })
})
