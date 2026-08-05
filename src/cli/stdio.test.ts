import { describe, expect, it } from 'vitest'
import { isBrokenPipe } from './stdio.ts'

/** The shape the platform actually fails with, observed on `--list-rules | head -1`. */
const platformFailure = (code: string) => ({
  _tag: 'PlatformError',
  cause: Object.assign(new Error(`write ${code}`), { code, errno: -32, syscall: 'write' }),
  reason: { method: 'stdout', module: 'Stdio' },
})

describe('a write failure that is really a reader leaving', () => {
  it('recognises the broken pipe the platform reports', () => {
    expect(isBrokenPipe(platformFailure('EPIPE'))).toBeTruthy()
  })

  it('calls nothing else a broken pipe', () => {
    // The false direction is the dangerous one: a full disk on `> rules.json` reported as "the
    // reader had enough" would exit 0 on a document that never landed. Every way the value can
    // fail to be a broken pipe is listed, because each is a branch that would otherwise decide
    // this silently.
    for (const failure of [
      platformFailure('ENOSPC'),
      { _tag: 'PlatformError', cause: new Error('write failed') },
      { _tag: 'PlatformError', cause: null },
      { _tag: 'PlatformError', cause: 'EPIPE' },
      { _tag: 'PlatformError' },
      null,
      'EPIPE',
    ]) {
      expect(isBrokenPipe(failure)).toBeFalsy()
    }
  })
})
