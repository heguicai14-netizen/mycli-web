import { describe, it, expect } from 'vitest'
import { passThresholdFor } from '../core/scorer'

describe('passThresholdFor — L4', () => {
  it('L1 → 0.7', () => expect(passThresholdFor('L1')).toBe(0.7))
  it('L2 → 0.6', () => expect(passThresholdFor('L2')).toBe(0.6))
  it('L3 → 0.5', () => expect(passThresholdFor('L3')).toBe(0.5))
  it('L4 → 0.45', () => expect(passThresholdFor('L4')).toBe(0.45))
})
