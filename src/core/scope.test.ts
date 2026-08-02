import { describe, expect, it } from 'vitest'
import { appliesTo } from './scope.ts'

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

    expect(appliesTo(rule, 'src/core/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/core/rule.tsx')).toBeFalsy()
  })

  it('matches a bare filename against a leading double star', () => {
    expect(appliesTo(scoped(['**/*.ts']), 'rule.ts')).toBeTruthy()
  })

  it('matches absolute paths, which is what a write-time hook actually receives', () => {
    expect(appliesTo(scoped(['**/*.ts']), '/workspaces/project/src/core/rule.ts')).toBeTruthy()
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

    expect(appliesTo(rule, 'src/core/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/core/rule.test.ts')).toBeFalsy()
  })

  it('applies ignores even when the rule declares no files globs', () => {
    const rule = scoped(undefined, ['**/generated/**'])

    expect(appliesTo(rule, 'src/core/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/generated/schema.ts')).toBeFalsy()
  })

  it('does not let a single star cross a directory boundary', () => {
    const rule = scoped(['src/*.ts'])

    expect(appliesTo(rule, 'src/rule.ts')).toBeTruthy()
    expect(appliesTo(rule, 'src/core/rule.ts')).toBeFalsy()
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
