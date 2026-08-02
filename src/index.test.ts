import { describe, expect, it } from 'vitest'
import * as falsestart from './index.ts'

describe('library surface', () => {
  it('exposes the pipeline as separable steps', () => {
    // Named individually rather than snapshotted: removing one of these is a breaking change for
    // a consumer, and it should have to be spelled out here before it can happen.
    expect(Object.keys(falsestart).toSorted()).toEqual([
      'MatchError',
      'RuleLoadError',
      'RuleParseError',
      'SEVERITIES',
      'SUPPORTED_LANGUAGES',
      'appliesTo',
      'assessRule',
      'checkFile',
      'decide',
      'findUntestedRules',
      'findViolations',
      'judgesPayload',
      'loadRules',
      'parseRule',
      'respond',
    ])
  })
})
