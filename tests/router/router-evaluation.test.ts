import { describe, expect, it } from 'vitest'
import { ROUTER_GOLDEN_CASES, evaluateRouterPolicy } from '../../src/main/router/router-evaluation'

describe('Router delegation golden set', () => {
  it('meets the initial routing contract across representative requests', () => {
    const result = evaluateRouterPolicy()
    expect(result.total).toBe(ROUTER_GOLDEN_CASES.length)
    expect(result.mismatches).toEqual([])
    expect(result.accuracy).toBe(1)
  })
})
