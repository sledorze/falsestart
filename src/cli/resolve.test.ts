/**
 * Rule-set resolution, tested at all — which it previously was not.
 *
 * Both functions lived inside `cli.ts`, excluded from the coverage ratchet and from mutation
 * testing, and neither had a test. `--preset` did not appear anywhere in the e2e suite, and `pkg:`
 * was covered only as far as `parseArguments` reading the prefix. So the code choosing which rule
 * set a repo enforces was the one piece of this codebase nothing checked.
 *
 * `packageRulesDirectory` is exercised against REAL installed packages rather than a stubbed
 * resolver. Its whole reason for existing is that a hand-joined `node_modules/<name>/rules` does
 * not exist under pnpm's layout, and a fake resolver would agree with whatever the test asserted
 * while telling you nothing about pnpm.
 */
import { describe, expect, it } from 'vitest'
import { packageRulesDirectory, presetDirectory } from './resolve.ts'

describe('preset resolution', () => {
  const packaged = '/somewhere/node_modules/@sledorze/falsestart/rules'

  it('reads `all` as the packaged root, which the loader searches recursively', () => {
    expect(presetDirectory('all', packaged)).toBe(packaged)
  })

  it('reads a named preset as the subdirectory of the same name', () => {
    expect(presetDirectory('clean-code', packaged)).toBe(`${packaged}/clean-code`)
    expect(presetDirectory('effect', packaged)).toBe(`${packaged}/effect`)
  })

  it('takes the packaged root as an argument rather than anchoring itself', () => {
    // The executable is bundled to `dist/cli.js` while the library build also emits
    // `dist/cli/resolve.js`. A self-anchored `../rules` would therefore mean `dist/rules` in one
    // artifact and the package root in the other — the same bug class as guessing a node_modules
    // path. Passing the anchor in is what keeps the two builds agreeing.
    expect(presetDirectory('all', '/a')).toBe('/a')
    expect(presetDirectory('all', '/b')).toBe('/b')
  })
})

describe('package rule-set resolution', () => {
  it('finds a real installed package wherever the package manager put it', () => {
    // `picomatch` is a genuine dependency of this project, and under pnpm it is NOT at
    // `node_modules/picomatch` — it lives in the content-addressed store. Asserting the resolved
    // path is real, rather than the guessed one, is the whole point of the function.
    const resolved = packageRulesDirectory('picomatch', process.cwd())

    expect(resolved).toContain('picomatch')
    expect(resolved.endsWith('/rules')).toBeTruthy()
  })

  it('keeps both segments of a scoped package name', () => {
    const resolved = packageRulesDirectory('@effect/platform-node', process.cwd())

    expect(resolved).toContain('platform-node')
    expect(resolved.endsWith('/rules')).toBeTruthy()
  })

  it('appends a subdirectory of the package rule set', () => {
    const whole = packageRulesDirectory('picomatch', process.cwd())
    const part = packageRulesDirectory('picomatch/strict', process.cwd())

    expect(part).toBe(`${whole}/strict`)
  })

  it('appends a subdirectory to a scoped package too', () => {
    // The segment split differs for scoped names — two segments are the package, the rest the
    // subdirectory — and getting it wrong resolves `@effect/platform-node` to `@effect`.
    const whole = packageRulesDirectory('@effect/platform-node', process.cwd())
    const part = packageRulesDirectory('@effect/platform-node/strict', process.cwd())

    expect(part).toBe(`${whole}/strict`)
  })

  it('throws for a package that is not installed, rather than inventing a path', () => {
    // A guessed path would load nothing and report nothing — the silent-inert-guard failure. The
    // caller turns this into a visible, non-blocking error.
    expect(() => packageRulesDirectory('@acme/definitely-not-installed', process.cwd())).toThrow(/Cannot find module/)
  })

  // "Resolves from the PROJECT rather than from falsestart" is the other half of this function's
  // contract, and it is deliberately NOT asserted here. Under plain node, resolving `picomatch`
  // from `/` or `/tmp` throws MODULE_NOT_FOUND and only the project directory succeeds — verified
  // directly. Under vitest it succeeds from every one of them, because the test loader resolves
  // through its own module graph rather than the filesystem walk this function relies on.
  //
  // A test written here would therefore have passed for a reason unrelated to the code, which is
  // the same defect as a test that passes because its assertion is satisfied by unrelated output.
  // The claim is exercised out of process instead, in `cli.e2e.test.ts`, where the real binary
  // runs under real node in a directory that genuinely has no such package.
})
