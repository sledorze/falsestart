import { describe, expect, it } from 'vitest'
import { DEFAULT_RULES_DIRECTORY, parseArguments } from './options.ts'

describe('command line', () => {
  it('takes the rule directory from --rules', () => {
    expect(parseArguments(['--rules', 'my-rules'])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      preset: undefined,
      rulesDirectory: 'my-rules',
      rulesPackage: undefined,
      warnUnscoped: false,
    })
  })

  it('falls back to a conventional directory when given nothing', () => {
    expect(parseArguments([])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      preset: undefined,
      rulesDirectory: DEFAULT_RULES_DIRECTORY,
      rulesPackage: undefined,
      warnUnscoped: false,
    })
  })

  it('recognises --warn-unscoped', () => {
    expect(parseArguments(['--warn-unscoped'])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      preset: undefined,
      rulesDirectory: DEFAULT_RULES_DIRECTORY,
      rulesPackage: undefined,
      warnUnscoped: true,
    })
  })

  it('leaves the warning off unless asked', () => {
    expect(parseArguments([])).toMatchObject({ warnUnscoped: false })
  })

  it('refuses --warn-unscoped with --doctor rather than accepting a flag it ignores', () => {
    // This shipped the other way first: the flag was recorded on the `Doctor` result, nothing
    // consumed it, and `--doctor --warn-unscoped` was byte-identical to `--doctor`. The test that
    // was here asserted the PARSE and passed the whole time, which is worse than no test — it
    // documented plumbing that did not exist. `--warn-unscoped` reports on the path a real payload
    // carries; `--doctor` reads no payload.
    const parsed = parseArguments(['--doctor', '--warn-unscoped'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--warn-unscoped')
  })

  it('leaves --doctor with no warnUnscoped field at all', () => {
    // Absent rather than `false`: a field nothing reads is one the next reader has to check for a
    // consumer that is not there.
    expect(parseArguments(['--doctor'])).not.toHaveProperty('warnUnscoped')
  })

  it('does not consume the argument after --warn-unscoped', () => {
    // The valueless-flag regression this file already carries scars from: a flag that eats the
    // next token turned `--rules --doctor` into a hang with no output.
    expect(parseArguments(['--warn-unscoped', '--rules', 'my-rules'])).toMatchObject({
      rulesDirectory: 'my-rules',
      warnUnscoped: true,
    })
  })

  it('recognises --doctor, keeping the resolution it would have run with', () => {
    expect(parseArguments(['--doctor', '--rules', 'my-rules'])).toEqual({
      _tag: 'Doctor',
      configPath: undefined,
      preset: undefined,
      rulesDirectory: 'my-rules',
      rulesPackage: undefined,
    })
  })

  it('recognises --doctor after the flags it reports on', () => {
    expect(parseArguments(['--preset', 'all', '--doctor'])._tag).toBe('Doctor')
  })

  it('recognises --version ahead of everything else', () => {
    expect(parseArguments(['--version'])).toEqual({ _tag: 'Version' })
    expect(parseArguments(['--rules', 'x', '--version'])).toEqual({ _tag: 'Version' })
  })

  it('refuses a flag where a value belongs rather than swallowing it', () => {
    // `--rules --doctor` consumed `--doctor` as the directory, fell through to the judging path,
    // and waited on a payload that was never coming — a hang with no output to explain itself.
    const parsed = parseArguments(['--rules', '--doctor'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed).toMatchObject({ problem: '--rules needs a value' })
  })

  it('refuses --rules with no directory rather than quietly using the default', () => {
    // Silently falling back would run a DIFFERENT rule set than the one asked for, and look
    // completely normal while doing it.
    const parsed = parseArguments(['--rules'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--rules')
  })

  it('refuses a flag it does not recognise', () => {
    // A typo must not degrade to "run with the default rules"; that is a misconfiguration wearing
    // the appearance of a working guard.
    const parsed = parseArguments(['--rulez', 'my-rules'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--rulez')
  })

  it('refuses a bare positional argument', () => {
    expect(parseArguments(['my-rules'])._tag).toBe('Invalid')
  })

  it('answers --help with usage text', () => {
    const parsed = parseArguments(['--help'])

    expect(parsed._tag).toBe('Help')
    expect(parsed._tag === 'Help' && parsed.text).toContain('--rules')
  })

  it('answers -h the same way', () => {
    expect(parseArguments(['-h'])._tag).toBe('Help')
  })

  it('answers --help even when other arguments are present', () => {
    expect(parseArguments(['--rules', 'x', '--help'])._tag).toBe('Help')
  })

  it('takes the last --rules when it is repeated', () => {
    expect(parseArguments(['--rules', 'first', '--rules', 'second'])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      preset: undefined,
      rulesDirectory: 'second',
      rulesPackage: undefined,
      warnUnscoped: false,
    })
  })

  it('takes a config path from --config', () => {
    expect(parseArguments(['--config', 'my.json'])).toEqual({
      _tag: 'Run',
      configPath: 'my.json',
      rulesDirectory: DEFAULT_RULES_DIRECTORY,
      rulesPackage: undefined,
      warnUnscoped: false,
    })
  })

  it('refuses --config with no file', () => {
    const parsed = parseArguments(['--config'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--config')
  })

  it('accepts both flags together', () => {
    expect(parseArguments(['--rules', 'r', '--config', 'c.json'])).toEqual({
      _tag: 'Run',
      configPath: 'c.json',
      rulesDirectory: 'r',
      rulesPackage: undefined,
      warnUnscoped: false,
    })
  })

  it('takes a shipped rule set from --preset', () => {
    expect(parseArguments(['--preset', 'effect'])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      preset: 'effect',
      rulesDirectory: DEFAULT_RULES_DIRECTORY,
      rulesPackage: undefined,
      warnUnscoped: false,
    })
  })

  it('refuses an unknown preset by name', () => {
    const parsed = parseArguments(['--preset', 'efect'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('efect')
  })

  it('refuses --preset with no value', () => {
    expect(parseArguments(['--preset'])._tag).toBe('Invalid')
  })

  it('refuses --preset combined with --rules, rather than ranking them', () => {
    // Silently preferring one would run a different rule set than the caller named.
    const parsed = parseArguments(['--preset', 'all', '--rules', 'r'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('cannot be combined')
  })

  it('takes a rules package from a pkg: prefixed --rules', () => {
    expect(parseArguments(['--rules', 'pkg:@acme/falsestart-rules'])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      preset: undefined,
      rulesDirectory: DEFAULT_RULES_DIRECTORY,
      rulesPackage: '@acme/falsestart-rules',
      warnUnscoped: false,
    })
  })

  it('keeps a subdirectory in the package specifier', () => {
    const parsed = parseArguments(['--rules', 'pkg:@acme/falsestart-rules/strict'])

    expect(parsed._tag === 'Run' && parsed.rulesPackage).toBe('@acme/falsestart-rules/strict')
  })

  it('still reads an unprefixed value as a directory', () => {
    // `--rules rules` has always meant ./rules; reinterpreting bare names as packages would
    // silently change which rule set an existing invocation loads.
    const parsed = parseArguments(['--rules', 'rules'])

    expect(parsed._tag === 'Run' && parsed.rulesDirectory).toBe('rules')
    expect(parsed._tag === 'Run' && parsed.rulesPackage).toBeUndefined()
  })

  it('refuses a pkg: prefix with no package name', () => {
    expect(parseArguments(['--rules', 'pkg:'])._tag).toBe('Invalid')
  })
})
