import { describe, expect, it } from 'vitest'
import { appliesTo, grammarFor, toScopingPath, canAnchor } from './scope.ts'

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

describe('choosing a grammar for a file', () => {
  it('lets the file decide within the JavaScript family', () => {
    // Rules declare `language: tsx` meaning "parse it as TSX", which is what lets one rule cover
    // `.ts`, `.mts` and `.js`. Honouring that literally parsed TypeScript with the TSX grammar,
    // which cannot see past an angle-bracket cast.
    expect(grammarFor('tsx', 'src/a.ts')).toBe('typescript')
    expect(grammarFor('tsx', 'src/a.mts')).toBe('typescript')
    expect(grammarFor('tsx', 'src/a.cts')).toBe('typescript')
    expect(grammarFor('tsx', 'src/a.tsx')).toBe('tsx')
    expect(grammarFor('tsx', 'src/a.js')).toBe('javascript')
    expect(grammarFor('typescript', 'src/a.jsx')).toBe('javascript')
  })

  it('leaves a language outside that family alone', () => {
    // A `.css` extension says nothing about which JavaScript parser to use, and overriding a CSS
    // rule's grammar would break it outright.
    expect(grammarFor('css', 'src/a.css')).toBe('css')
    expect(grammarFor('html', 'src/a.html')).toBe('html')
    expect(grammarFor('css', 'src/a.ts')).toBe('css')
  })

  it('keeps the declared grammar when the file cannot say better', () => {
    expect(grammarFor('tsx', 'Makefile')).toBe('tsx')
    expect(grammarFor('tsx', 'src/a.vue')).toBe('tsx')
    expect(grammarFor('tsx', 'src/a.')).toBe('tsx')
  })
})

describe('a root that is not a root', () => {
  it('leaves the path alone rather than slicing its leading separator off', () => {
    // `''`, `'.'` and `'/'` all normalise to nothing. Unguarded, the prefix became `/` — which every
    // absolute path starts with — so `/repo/src/a.ts` scoped as `repo/src/a.ts` and no repo-relative
    // glob matched it. Silent, and indistinguishable from a clean file.
    for (const root of ['', '.', './', '/', '//']) {
      expect(toScopingPath('/repo/src/a.ts', root)).toBe('/repo/src/a.ts')
    }
  })

  it('says which strings can anchor a glob at all', () => {
    for (const useless of [undefined, '', '   ', '.', './', '/', '//']) {
      expect(canAnchor(useless)).toBeFalsy()
    }
    for (const usable of ['/repo', '/repo/', 'C:/repo', 'relative/dir']) {
      expect(canAnchor(usable)).toBeTruthy()
    }
  })
})

describe('a path spelled with an interior ..', () => {
  it('collapses it, because a glob can never match a path that still carries one', () => {
    // The hook reported `sub/../src/a.ts` and every repo-relative glob missed it — silently, exit 0,
    // nothing on either stream — while `scan` judged the same file and denied. Two enforcement
    // points disagreeing about one file, and the quiet one is the one that guards writes.
    expect(toScopingPath('/repo/sub/../src/a.ts', '/repo')).toBe('src/a.ts')
    expect(toScopingPath('/repo/a/b/../../src/a.ts', '/repo')).toBe('src/a.ts')
    expect(toScopingPath('/repo/src/./a.ts', '/repo')).toBe('src/a.ts')
  })

  it('is purely lexical, so it still asks the filesystem nothing', () => {
    // The rule this module states is that scoping must not depend on the disk — which forbids
    // `realpath`, not string arithmetic. `a/b/../c` is `a/c` on every filesystem, present or not.
    expect(toScopingPath('/repo/nonexistent/../src/a.ts', '/repo')).toBe('src/a.ts')
  })

  it('drops a .. that would climb above an absolute root', () => {
    // `/..` is `/` on every filesystem. Keeping it would produce a path no glob can match, which is
    // the silent miss this whole change exists to end.
    expect(toScopingPath('/../etc/passwd', undefined)).toBe('/etc/passwd')
    expect(toScopingPath('/a/../../b/c.ts', undefined)).toBe('/b/c.ts')
  })

  it('keeps consecutive .. on a relative path, which have nothing to cancel', () => {
    expect(toScopingPath('../../outside/a.ts', undefined)).toBe('../../outside/a.ts')
  })

  it('leaves a .. it cannot collapse alone rather than inventing a parent', () => {
    // Climbing above the root has no lexical answer, so the path keeps its shape and simply fails
    // to match — the honest outcome, and the one `--warn-unscoped` can report.
    expect(toScopingPath('../outside/a.ts', undefined)).toBe('../outside/a.ts')
  })
})
