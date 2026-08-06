import { describe, expect, it } from 'vitest'
import { FREEZE_MODES } from '../freezing/index.ts'
import { DEFAULT_RULES_DIRECTORY, parseArguments } from './options.ts'

describe('command line', () => {
  it('takes the rule directory from --rules', () => {
    expect(parseArguments(['--rules', 'my-rules'])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      freeze: 'auto',
      freezeRef: 'HEAD',
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
      freeze: 'auto',
      freezeRef: 'HEAD',
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
      freeze: 'auto',
      freezeRef: 'HEAD',
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
      freeze: 'auto',
      freezeRef: 'HEAD',
      preset: undefined,
      rulesDirectory: 'my-rules',
      rulesPackage: undefined,
    })
  })

  it('recognises --doctor after the flags it reports on', () => {
    expect(parseArguments(['--preset', 'all', '--doctor'])._tag).toBe('Doctor')
  })

  it('recognises --list-rules as its own mode, carrying the same resolution as a judging run', () => {
    // "Resolved, not raw" is what the document is for, so the flags that decide the resolution
    // have to arrive on the mode intact — a dropped `--config` would emit a rule set nobody asked
    // for, which is exactly the substitution this file exists to prevent.
    expect(parseArguments(['--list-rules', '--preset', 'clean-code', '--config', 'c.json'])).toEqual({
      _tag: 'ListRules',
      configPath: 'c.json',
      freeze: 'auto',
      freezeRef: 'HEAD',
      preset: 'clean-code',
      rulesDirectory: DEFAULT_RULES_DIRECTORY,
      rulesPackage: undefined,
    })
  })

  it('refuses --list-rules with --doctor, and with --version', () => {
    // Two report modes in one process: whichever won, the other flag was taken and dropped. Both
    // orderings, because the parser is order-sensitive elsewhere and `--version` is checked late.
    for (const args of [
      ['--list-rules', '--doctor'],
      ['--doctor', '--list-rules'],
      ['--list-rules', '--version'],
      ['--version', '--list-rules'],
    ]) {
      const parsed = parseArguments(args)

      expect(parsed._tag).toBe('Invalid')
      expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--list-rules')
    }
  })

  it('refuses --list-rules with --warn-unscoped', () => {
    // It reports on the path a real payload carries, and `--list-rules` reads no payload. The
    // information is not missing: the listing states every rule's files and ignores.
    const parsed = parseArguments(['--list-rules', '--warn-unscoped'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--warn-unscoped')
  })

  it('refuses the scan-only flags alongside --list-rules', () => {
    // A REGRESSION PIN on behaviour that already exists: both flags take values and are parsed
    // unconditionally, so they reach the `!scanning` guard whatever mode was asked for. Reverting
    // `--list-rules` does not make this fail, and a green run of it is no evidence the new mode
    // works — falsify it by deleting a term from that guard.
    expect(parseArguments(['--list-rules', '--baseline', 'b.json'])._tag).toBe('Invalid')
    expect(parseArguments(['--list-rules', '--exclude', 'x/**'])._tag).toBe('Invalid')
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
})

describe('the scan command', () => {
  it('takes paths as positional arguments', () => {
    expect(parseArguments(['scan', 'src/a.ts', 'src/b.ts'])).toMatchObject({
      _tag: 'Scan',
      pathSource: 'Argv',
      paths: ['src/a.ts', 'src/b.ts'],
    })
  })

  it('dispatches on args[0] and nowhere else', () => {
    // "Positionals are allowed once `scan` is seen" would admit this, and a misconfiguration that
    // still runs is what this module exists to refuse.
    expect(parseArguments(['my-rules', 'scan'])._tag).toBe('Invalid')
  })

  it('reads paths from stdin when asked, newline or NUL', () => {
    expect(parseArguments(['scan', '-'])).toMatchObject({ pathSource: 'Newline' })
    expect(parseArguments(['scan', '-0'])).toMatchObject({ pathSource: 'Nul' })
  })

  it('keeps the rule-set flags the hook uses', () => {
    expect(parseArguments(['scan', '--preset', 'all', '--config', 'c.json', 'a.ts'])).toMatchObject({
      configPath: 'c.json',
      freeze: 'auto',
      freezeRef: 'HEAD',
      paths: ['a.ts'],
      preset: 'all',
    })
  })

  it('takes a baseline, and a request to write one', () => {
    expect(parseArguments(['scan', '--baseline', 'b.json', '--update-baseline', 'a.ts'])).toMatchObject({
      baselinePath: 'b.json',
      writeBaseline: true,
    })
  })

  it('collects --exclude globs, repeatably', () => {
    expect(parseArguments(['scan', '--exclude', 'legacy/**', '--exclude', 'gen/**', 'a.ts'])).toMatchObject({
      exclude: ['legacy/**', 'gen/**'],
      paths: ['a.ts'],
    })
  })

  it('refuses --update-baseline with nothing to write to', () => {
    const parsed = parseArguments(['scan', '--update-baseline', 'a.ts'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--baseline')
  })

  it('refuses the scan-only flags outside scan, rather than ignoring them', () => {
    // A flag accepted and silently dropped is the failure this file's opening paragraph forbids,
    // and one shipped that way once already.
    for (const args of [['--baseline', 'b.json'], ['--update-baseline'], ['some/path.ts']]) {
      expect(parseArguments(args)._tag).toBe('Invalid')
    }
  })

  it('refuses --warn-unscoped with scan, whose report already carries the aggregate', () => {
    const parsed = parseArguments(['scan', '--warn-unscoped', 'a.ts'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed._tag === 'Invalid' && parsed.problem).toContain('--warn-unscoped')
  })

  it('refuses scan combined with a mode that answers a different question', () => {
    expect(parseArguments(['scan', '--doctor'])._tag).toBe('Invalid')
    expect(parseArguments(['scan', '--version'])._tag).toBe('Invalid')
    // `scan` judges paths and reports findings; `--list-rules` reports a rule set. Accepting both
    // means one of them was written and thrown away.
    const combined = parseArguments(['scan', '--list-rules', 'a.ts'])
    expect(combined._tag).toBe('Invalid')
    // And refused by NAME, not swept up by the unrecognised-argument guard at the end of the loop.
    // Both spellings are `Invalid`, so only the message tells them apart — and the difference is
    // whether a reader is told which two things cannot be combined or just that a flag is unknown.
    expect(combined._tag === 'Invalid' && combined.problem).not.toContain('unrecognised')
  })

  it('answers --help with the SCAN usage, not the hook usage', () => {
    // Handing a reader a different command's usage documents neither. `scan` has its own flags and
    // its own exit codes, and the generic text mentions none of them.
    const parsed = parseArguments(['scan', '--help'])

    expect(parsed._tag).toBe('Help')
    expect(parsed._tag === 'Help' && parsed.text).toContain('--baseline')
    expect(parsed._tag === 'Help' && parsed.text).toContain('--update-baseline')
    expect(parsed._tag === 'Help' && parsed.text).toContain('-0')
  })

  it('still refuses an unrecognised flag inside scan', () => {
    expect(parseArguments(['scan', '--rulez', 'x'])._tag).toBe('Invalid')
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
      freeze: 'auto',
      freezeRef: 'HEAD',
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
      freeze: 'auto',
      freezeRef: 'HEAD',
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
      freeze: 'auto',
      freezeRef: 'HEAD',
      rulesDirectory: 'r',
      rulesPackage: undefined,
      warnUnscoped: false,
    })
  })

  it('takes a shipped rule set from --preset', () => {
    expect(parseArguments(['--preset', 'effect'])).toEqual({
      _tag: 'Run',
      configPath: undefined,
      freeze: 'auto',
      freezeRef: 'HEAD',
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
      freeze: 'auto',
      freezeRef: 'HEAD',
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

/**
 * The freeze switch lives on the command line and nowhere else.
 *
 * The thing being frozen must not carry its own off switch: if `freeze` were readable from
 * `falsestart.config.json`, disarming would be `{"freeze":"off"}` and the freeze would have to
 * bootstrap itself out of an unfrozen read of the file that disables it. The command line is a
 * different trust root — it lives in the agent runtime's settings.
 */
describe('the freeze switch', () => {
  // T58
  describe.each(FREEZE_MODES)('--freeze %s', (mode) => {
    it('parses, in every mode that resolves a rule set', () => {
      for (const [args, tag] of [
        [[], 'Run'],
        [['--doctor'], 'Doctor'],
        [['--list-rules'], 'ListRules'],
        [['scan', 'a.ts'], 'Scan'],
      ] as const) {
        const parsed = parseArguments([...args, '--freeze', mode])

        expect(parsed._tag).toBe(tag)
        expect(parsed).toHaveProperty('freeze', mode)
      }
    })
  })

  it('defaults to auto, and to HEAD, in every mode', () => {
    // Default-on closes the hole for everyone who did not read the issue, which is everyone. A
    // default that regressed in ONE mode would be invisible: that mode would simply stop freezing.
    for (const args of [[], ['--doctor'], ['--list-rules'], ['scan', 'a.ts']]) {
      const parsed = parseArguments(args)

      expect(parsed).toHaveProperty('freeze', 'auto')
      expect(parsed).toHaveProperty('freezeRef', 'HEAD')
    }
  })

  it('takes another ref from --freeze-ref', () => {
    expect(parseArguments(['--freeze-ref', 'refs/remotes/origin/main'])).toHaveProperty(
      'freezeRef',
      'refs/remotes/origin/main',
    )
  })

  // T59 — a value accepted and dropped is the failure this file's opening paragraph exists to
  // prevent, and an unknown mode degrading to the default is the same failure wearing a hat.
  it('refuses a mode it does not know, naming the ones it does', () => {
    const parsed = parseArguments(['--freeze', 'bogus'])

    expect(parsed._tag).toBe('Invalid')
    expect(parsed).toHaveProperty('problem', expect.stringContaining('auto, off, require'))
  })

  it('refuses a flag where a value belongs, rather than waiting on a payload', () => {
    // `--rules -x` consumed the flag as the directory and then blocked on stdin forever, with no
    // output to explain itself. Both new flags take a value, so both can do it.
    expect(parseArguments(['--freeze'])).toEqual({ _tag: 'Invalid', problem: '--freeze needs a value' })
    expect(parseArguments(['--freeze-ref'])).toEqual({ _tag: 'Invalid', problem: '--freeze-ref needs a value' })
    expect(parseArguments(['--freeze', '--doctor'])).toEqual({ _tag: 'Invalid', problem: '--freeze needs a value' })
  })
})
