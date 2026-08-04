/**
 * The exported TYPE surface, pinned the way `index.test.ts` pins the runtime one.
 *
 * Only the runtime half was pinned, so only the type half drifted: `docs/reference.md` listed
 * `Options` and `Preset` — which live in `cli/` and are deliberately not re-exported — while
 * `Diagnosis` and `DiagnoseOptions`, which are, appeared nowhere. A consumer following that list got
 * `TS2305: has no exported member 'Options'`.
 *
 * This file is type-checked, never run: an import of a type that stops existing fails `pnpm
 * typecheck`, which is the drift that actually happened.
 */
import type {
  CaseResult,
  Config,
  DecideOptions,
  Decision,
  DiagnoseOptions,
  Diagnosis,
  FalsestartConfig,
  FileScope,
  FileUnderCheck,
  Finding,
  HookResponse,
  Identified,
  Language,
  RespondOptions,
  Rule,
  RuleConstraint,
  RuleExpectation,
  ScopeOverride,
  Severity,
  ShippedRuleId,
  Violation,
} from './index.ts'

/** Referencing each one keeps the imports load-bearing rather than decoration. */
export type Exported = [
  CaseResult,
  Config,
  DecideOptions,
  Decision,
  DiagnoseOptions,
  Diagnosis,
  FalsestartConfig,
  FileScope,
  FileUnderCheck,
  Finding,
  HookResponse,
  Identified,
  Language,
  RespondOptions,
  Rule,
  RuleConstraint,
  RuleExpectation,
  ScopeOverride,
  Severity,
  ShippedRuleId,
  Violation,
]
