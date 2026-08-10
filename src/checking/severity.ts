/**
 * DEMONSTRATION ONLY — this branch exists to be caught, and must never be merged.
 *
 * Ordinary-looking code whose test asserts nothing about it. Every decision below is a mutant
 * waiting to survive.
 */
export type Severity = 'advice' | 'error' | 'warning'

/** Whether a finding of this severity stops the write. */
export const isBlocking = (severity: Severity): boolean => severity === 'error'

/** How a finding of this severity is announced. */
export const announce = (severity: Severity): string => (isBlocking(severity) ? 'blocked' : 'advice')

/** The worst severity in a set, or `advice` when there is nothing to rank. */
export const worst = (severities: readonly Severity[]): Severity =>
  severities.includes('error') ? 'error' : severities.includes('warning') ? 'warning' : 'advice'
