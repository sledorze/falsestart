/**
 * Entry point for per-repository configuration: which folders each rule applies to here.
 *
 * Separate from `checking/` because a rule's own scope is domain, while a repo's override of it is
 * deployment — and because loading it reaches for the filesystem and the module loader, which
 * nothing in the domain is allowed to do.
 */
export type { Config, Config as FalsestartConfig, NarrowedScope, ScopeOverride } from './config.ts'
export {
  applyScopeOverrides,
  ConfigError,
  findNarrowedScopes,
  findUnappliedOverrides,
  makeConfig,
  makeConfigUnsafe,
  parseConfig,
  validateConfig,
} from './config.ts'
export { DEFAULT_CONFIG_CANDIDATES, findDefaultConfigs, loadConfigFile, loadDefaultConfig } from './config-file.ts'
