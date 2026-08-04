/**
 * Turning a scan into the text a person reads in a terminal, and the code a shell reads.
 *
 * The summary line is the load-bearing part, and it exists because of a specific failure. A bare
 * `0 finding(s)` is printed by a genuinely clean scan, by a scan whose paths matched no rule, by a
 * scan given no paths at all, and by `scan` accidentally wired as the `PreToolUse` command — where
 * exit 0 with non-JSON on stdout reads to the agent runtime as "no decision, allow", silently
 * permitting every write while the hook still shows as registered.
 *
 * That last one is the exact failure this whole area was built to close, reintroduced by the fix
 * for it. Reporting how many files were scanned and how many were IN SCOPE separates all four: a
 * run that examined nothing says so.
 */
import type { Finding } from '../checking/index.ts'
import type { ScanReport } from './scan.ts'

/**
 * Exit codes, which are NOT the hook's.
 *
 * The hook answers a protocol where blocking is exit 0 with JSON on stdout, because exit 2 makes
 * the runtime discard stdout and throw the structured decision away. That vocabulary means nothing
 * to a shell, which reads only the code.
 *
 * `Violations` and `Broken` are deliberately distinct. A git hook that cannot tell "your code has
 * violations" from "the linter is broken" is one that teaches people to reach for `--no-verify`,
 * and a gate that trains people to bypass it is worse than no gate.
 *
 * Note this inverts the hook's fail-open policy on purpose. `hook/decide.ts` argues that a rule
 * which cannot run must not block, because a typo in a rule file must not hold every write in the
 * repo hostage. A gate is the opposite case: one that cannot run must stop, or it passes everything
 * while looking healthy.
 */
export const ScanExit = {
  Broken: 2,
  Clean: 0,
  Violations: 1,
} as const

const describe = (path: string, finding: Finding): string =>
  `${path}:${finding.line}:${finding.column}  ${finding.ruleId}  ${finding.message}`

/** How many findings the baseline absorbed, for the line that tells you the baseline is working. */
const acceptedCount = (report: ScanReport): number =>
  report.scanned.reduce((total, file) => total + file.findings.length, 0) - report.fresh.length

export interface ScanOutcome {
  readonly exitCode: number
  readonly text: string
}

export const render = (report: ScanReport): ScanOutcome => {
  // Identity, not fingerprint: `fresh` holds the very objects `scanned` does, and a Set keeps this
  // from being quadratic on a first push that reports thousands.
  const fresh = new Set(report.fresh)
  const lines = report.scanned.flatMap((file) =>
    file.findings.filter((finding) => fresh.has(finding)).map((finding) => describe(file.path, finding)),
  )

  const accepted = acceptedCount(report)
  const summary = [
    `scanned ${report.scanned.length} file(s)`,
    `${report.inScope} in scope`,
    `${report.fresh.length} finding(s)`,
    ...(accepted === 0 ? [] : [`${accepted} accepted by baseline`]),
    ...(report.missing.length === 0 ? [] : [`${report.missing.length} gone before it could be read`]),
    ...(report.excluded.length === 0 ? [] : [`${report.excluded.length} excluded`]),
  ].join(', ')

  // The hint fires on the case that looks identical to success and is not: something was examined
  // and nothing was even eligible to be judged.
  const inert =
    report.inScope === 0 && report.fresh.length === 0
      ? ['', 'Nothing was in scope. Check the paths and the `files` globs — this run enforced nothing.']
      : []

  return {
    exitCode: report.fresh.length === 0 ? ScanExit.Clean : ScanExit.Violations,
    text: [...lines, summary, ...inert].join('\n'),
  }
}
