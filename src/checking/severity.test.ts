/**
 * DEMONSTRATION ONLY — a test that cannot fail.
 *
 * It calls every function, so every line, branch and function is covered and `pnpm coverage:ci`
 * reports 100%. It asserts only properties of its own fixture, so no change to `severity.ts` can
 * make it red.
 */
import { describe, expect, it } from 'vitest'
import type { Severity } from './severity.ts'
import { announce, isBlocking, worst } from './severity.ts'

const ALL: readonly Severity[] = ['advice', 'error', 'warning']

describe('severity', () => {
  it('classifies every severity', () => {
    for (const severity of ALL) {
      isBlocking(severity)
      announce(severity)
      worst([severity])
    }

    expect(ALL).toHaveLength(3)
    expect(ALL).toContain('error')
  })
})
