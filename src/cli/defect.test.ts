import { describe, expect, it } from 'vitest'
import { describeDefect } from './defect.ts'

describe('an unexpected defect reaching the top of the program', () => {
  it('says something, because saying nothing is what made this dangerous', () => {
    // `runMain` is invoked with `disableErrorReporting`, on the reasoning that every message this
    // program has is already written in the hook contract's shape. That holds for failures and not
    // for DEFECTS: a throw escapes every `Effect.result` boundary, so nothing wrote anything.
    // Measured with `files: ['']`, which throws inside picomatch: exit 1, stdout 0 bytes, stderr
    // 0 bytes, in every mode including `--doctor` — the command whose whole job is to say what broke.
    const { stderr } = describeDefect(new Error('Expected pattern to be a non-empty string'), [])

    expect(stderr).toContain('falsestart')
    expect(stderr).toContain('Expected pattern to be a non-empty string')
  })

  it('names it a bug in falsestart, not a fault in the repository', () => {
    // The reader has to know which of the two it is. Every other message this program prints is
    // about their rules, their config or their payload; this one never is.
    expect(describeDefect(new Error('boom'), []).stderr).toContain('please report')
  })

  it('falls back to the message when an Error carries no stack', () => {
    // `Error.stack` is not in the language spec and a runtime may omit it, or a rethrow may strip
    // it. The message is the part worth printing either way.
    // Built rather than mutated: `exactOptionalPropertyTypes` refuses assigning `undefined` to
    // `stack`, and the runtime shape being modelled is an Error that simply never had one.
    const stackless: Error = Object.create(Error.prototype, {
      message: { value: 'no stack here' },
    })

    expect(describeDefect(stackless, []).stderr).toContain('no stack here')
  })

  it('prints the message of an Error from another realm, which fails instanceof', () => {
    // A worker thread or a native module throws something Error-shaped that `instanceof` rejects.
    // The one field worth quoting is still there.
    expect(describeDefect({ message: 'from a worker' }, []).stderr).toContain('from a worker')
  })

  it('names the type when there is no message to quote', () => {
    // Deliberately not a serialised blob: a value with no message has nothing to say, and
    // `JSON.stringify` is refused here by this repo's own `no-json-global` rule.
    expect(describeDefect({ code: 'ENOENT' }, []).stderr).toContain('a thrown object carrying no message')
    expect(describeDefect(42, []).stderr).toContain('a thrown number carrying no message')
  })

  it('survives a defect that is not an Error', () => {
    expect(describeDefect('a bare string', []).stderr).toContain('a bare string')
    expect(describeDefect(undefined, []).stderr).toContain('falsestart')
  })

  it('exits 1 under Claude Code, which reads that as a non-blocking notice', () => {
    expect(describeDefect(new Error('boom'), []).exitCode).toBe(1)
  })

  it('exits 0 under copilot, where any non-zero denies the tool call', () => {
    // The law `docs/reference.md` states: a failure falsestart REPORTS must never be able to block
    // a write. Under Copilot every non-zero exit other than 2 denies, so the only non-blocking code
    // left is 0 — and a defect is the one case that had been exiting 1 there, denying every call.
    for (const args of [['--agent', 'copilot'], ['--agent=copilot']]) {
      expect(describeDefect(new Error('boom'), args).exitCode).toBe(0)
    }
  })

  it('uses scan-s broken code, because a shell reads 1 as findings', () => {
    expect(describeDefect(new Error('boom'), ['scan', 'a.ts']).exitCode).toBe(2)
  })
})
