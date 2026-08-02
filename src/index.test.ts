import { describe, expect, it } from 'vitest'
import { version } from './index.ts'

describe('index', () => {
  it('is defined', () => {
    expect(version).toBe('0.0.1')
  })
})
