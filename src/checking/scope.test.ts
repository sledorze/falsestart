import { describe, expect, it } from 'vitest'
import { appliesTo, toScopingPath } from './scope.ts'

const scoped = (files?: readonly string[], ignores?: readonly string[]) => ({
  ...(files === undefined ? {} : { files }),
  ...(ignores === undefined ? {} : { ignores }),
})

describe('rule file scoping', () => {
  it('applies to every path when the rule declares no globs', () => {
    expect(appliesTo(scoped(), 'src/anything.ts')).toBeTruthy()
    expect(appliesTo(scoped(), '/abs/path/anything.tsx')).toBeTruthy()
  })

  it('applies only where a files glob matches', () => {
    const rule = scoped(['**/*.ts'])

    expect(appliesTo(rule, 'src/checking/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/checking/rule.tsx')).toBeFalsy()
  })

  it('matches a bare filename against a leading double star', () => {
    expect(appliesTo(scoped(['**/*.ts']), 'rule.ts')).toBeTruthy()
  })

  it('matches absolute paths, which is what a write-time hook actually receives', () => {
    expect(appliesTo(scoped(['**/*.ts']), '/workspaces/project/src/checking/rule.ts')).toBeTruthy()
  })

  it('honours brace alternation', () => {
    const rule = scoped(['**/*.{ts,tsx}'])

    expect(appliesTo(rule, 'a.ts')).toBeTruthy()
    expect(appliesTo(rule, 'a.tsx')).toBeTruthy()
    expect(appliesTo(rule, 'a.js')).toBeFalsy()
  })

  it('applies when any one of several files globs matches', () => {
    const rule = scoped(['**/*.ts', '**/*.css'])

    expect(appliesTo(rule, 'a.css')).toBeTruthy()
    expect(appliesTo(rule, 'a.html')).toBeFalsy()
  })

  it('subtracts ignores from an otherwise matching path', () => {
    const rule = scoped(['**/*.ts'], ['**/*.test.ts'])

    expect(appliesTo(rule, 'src/checking/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/checking/rule.test.ts')).toBeFalsy()
  })

  it('applies ignores even when the rule declares no files globs', () => {
    const rule = scoped(undefined, ['**/generated/**'])

    expect(appliesTo(rule, 'src/checking/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/generated/schema.ts')).toBeFalsy()
  })

  it('does not let a single star cross a directory boundary', () => {
    const rule = scoped(['src/*.ts'])

    expect(appliesTo(rule, 'src/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/checking/rule.ts')).toBeFalsy()
  })

  it('treats a literal directory segment as a real constraint, not a substring', () => {
    const rule = scoped(['**/domain/**/*.ts'])

    expect(appliesTo(rule, 'src/domain/order.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/subdomain/order.ts')).toBeFalsy()
  })

  it('normalises backslash separators so Windows-shaped paths scope identically', () => {
    expect(appliesTo(scoped(['**/*.ts']), 'src\\core\\rule.ts')).toBeTruthy()
    expect(appliesTo(scoped(['**/*.ts'], ['**/*.test.ts']), 'src\\core\\rule.test.ts')).toBeFalsy()
  })
})

describe('scoping path', () => {
  it('expresses a path inside the project root relative to it', () => {
    expect(toScopingPath('/repo/src/checking/rule.ts', '/repo')).toBe('src/checking/rule.ts')
  })

  it('is what makes a repo-relative glob match a payload that carries an absolute path', () => {
    // The regression this exists for: hooks report absolute paths, rules are authored relative to
    // the project, and matching one against the other silently never fires.
    const rule = { files: ['src/**/*.ts'] }

    expect(appliesTo(rule, '/repo/src/checking/rule.ts')).toBeFalsy()
    expect(appliesTo(rule, toScopingPath('/repo/src/checking/rule.ts', '/repo'))).toBeTruthy()
  })

  it('still admits a leading-globstar rule after normalisation', () => {
    expect(appliesTo({ files: ['**/*.ts'] }, toScopingPath('/repo/src/a.ts', '/repo'))).toBeTruthy()
  })

  it('tolerates a trailing separator on the root', () => {
    expect(toScopingPath('/repo/src/a.ts', '/repo/')).toBe('src/a.ts')
  })

  it('leaves a path outside the root absolute rather than inventing a relative one', () => {
    expect(toScopingPath('/elsewhere/a.ts', '/repo')).toBe('/elsewhere/a.ts')
  })

  it('does not treat a sibling directory sharing a prefix as inside the root', () => {
    expect(toScopingPath('/repo-other/a.ts', '/repo')).toBe('/repo-other/a.ts')
  })

  it('leaves the path alone when no root is known', () => {
    expect(toScopingPath('/repo/src/a.ts', undefined)).toBe('/repo/src/a.ts')
  })

  it('normalises separators so a Windows-shaped payload scopes identically', () => {
    expect(toScopingPath('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
  })

  it('leaves an already-relative path untouched', () => {
    expect(toScopingPath('src/a.ts', '/repo')).toBe('src/a.ts')
  })

  // A glob is matched against the literal string, so `./src/a.ts` matched NOTHING — not even
  // `**/*.ts`. Zero findings on a file that should be blocked is indistinguishable from a clean
  // file, so the failure is total and silent.
  //
  // Latent while the only caller passed Claude Code's always-absolute `file_path`. Any caller that
  // forwards paths hits it at once: lefthook's `root:` setting, the documented way to scope a hook
  // to one package of a monorepo, emits exactly `./src/a.ts`, as does `find . | xargs`.
  it.each([
    ['./src/a.ts', 'a leading ./'],
    ['src//a.ts', 'a doubled separator'],
    ['src/./a.ts', 'an interior ./'],
    ['./src/.//a.ts', 'all three at once'],
  ])('scopes %s (%s) exactly as the plain path does', (spelling) => {
    expect(toScopingPath(spelling, '/repo')).toBe(toScopingPath('src/a.ts', '/repo'))
  })

  it('finds the same violations however the path is spelled', () => {
    // The assertion that matters is not the string but the DECISION: a rule must reach the file
    // under every spelling of its path, since the spelling is chosen by whoever invoked us.
    const rule = { files: ['**/*.{ts,tsx,mts,cts}'] }

    for (const spelling of ['src/a.ts', './src/a.ts', 'src//a.ts', '/repo/src/a.ts', '/repo//src/a.ts']) {
      expect(appliesTo(rule, toScopingPath(spelling, '/repo'))).toBeTruthy()
    }
  })

  it('normalises the root as well as the path', () => {
    expect(toScopingPath('/repo/src/a.ts', '/repo/./')).toBe('src/a.ts')
    expect(toScopingPath('/repo//src/a.ts', '/repo')).toBe('src/a.ts')
  })

  it('leaves `..` alone rather than resolving it against a directory it cannot see', () => {
    // Resolving it would make a scoping decision depend on where the process was started, which is
    // how a rule begins behaving differently in CI than it does locally.
    expect(toScopingPath('../a.ts', '/repo')).toBe('../a.ts')
  })
})
