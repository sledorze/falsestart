import { describe, expect, it } from 'vitest'
import * as falsestart from './index.ts'

describe('library surface', () => {
  it('exposes the pipeline as separable steps', () => {
    // Named individually rather than snapshotted: removing one of these is a breaking change for
    // a consumer, and it should have to be spelled out here before it can happen.
    expect(Object.keys(falsestart).toSorted()).toEqual([
      'ConfigError',
      'DEFAULT_CONFIG_CANDIDATES',
      'DEFAULT_EXCLUSIONS',
      'JAVASCRIPT_EXTENSIONS',
      'MatchError',
      'RuleLoadError',
      'RuleParseError',
      'SEVERITIES',
      'SHIPPED_RULE_IDS',
      'SOURCE_EXTENSIONS',
      'SUPPORTED_LANGUAGES',
      'ScanError',
      'ScanExit',
      'TYPESCRIPT_EXTENSIONS',
      'WRITE_TOOLS',
      'appliesTo',
      'applyScopeOverrides',
      'assessRule',
      'checkFile',
      'decide',
      'diagnose',
      'extensionGlobGroup',
      'findDefaultConfigs',
      'findNarrowedScopes',
      'findUntestedRules',
      'findViolations',
      'fingerprint',
      'judgesPayload',
      'loadConfigFile',
      'loadDefaultConfig',
      'loadRules',
      'makeConfig',
      'makeConfigUnsafe',
      'parseConfig',
      'parseRule',
      'partitionPaths',
      'render',
      'respond',
      'samplePath',
      'scan',
      'toScopingPath',
      'validateConfig',
    ])
  })
})
