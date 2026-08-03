import { describe, expect, it } from 'vitest'
import * as falsestart from './index.ts'

describe('library surface', () => {
  it('exposes the pipeline as separable steps', () => {
    // Named individually rather than snapshotted: removing one of these is a breaking change for
    // a consumer, and it should have to be spelled out here before it can happen.
    expect(Object.keys(falsestart).toSorted()).toEqual([
      'ConfigError',
      'DEFAULT_CONFIG_CANDIDATES',
      'MatchError',
      'RuleLoadError',
      'RuleParseError',
      'SEVERITIES',
      'SHIPPED_RULE_IDS',
      'SUPPORTED_LANGUAGES',
      'WRITE_TOOLS',
      'appliesTo',
      'applyScopeOverrides',
      'assessRule',
      'checkFile',
      'decide',
      'findUntestedRules',
      'findViolations',
      'judgesPayload',
      'loadConfigFile',
      'loadDefaultConfig',
      'loadRules',
      'makeConfig',
      'makeConfigUnsafe',
      'parseConfig',
      'parseRule',
      'respond',
      'toScopingPath',
      'validateConfig',
    ])
  })
})
