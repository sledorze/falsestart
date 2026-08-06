/**
 * Entry point for freezing: what a git ref committed, and what that licenses.
 *
 * Knows git's plumbing output formats and nothing about processes — `cli.ts` performs the spawns and
 * hands the answers here, which is what lets every arm of the decision be reached by a test. Why the
 * areas are drawn this way is explained in `docs/architecture.md`.
 */
export type { AnchorResolution, RulesPath, RulesPathOptions } from './anchor.ts'
export { MAX_ANCHOR_WALK, resolveAnchor, resolveRulesPath } from './anchor.ts'
export type {
  Anchor,
  ClassifyConfigOptions,
  ClassifyRulesOptions,
  ConfigSource,
  Divergence,
  FreezeEvidence,
  FreezeInput,
  FreezeMode,
  FreezeOutcome,
  Frozen,
  GitAnswer,
} from './freeze.ts'
export { classifyConfig, classifyRules, containedPath, divergence, freeze, FREEZE_MODES } from './freeze.ts'
export type { Absent, TreeEntry } from './listing.ts'
export { isAbsent, parseBatchObjects, parseTreeListing } from './listing.ts'
