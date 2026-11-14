import { describe, expect, it } from 'vitest'
import { verifyIpcSecurity } from '../../scripts/verify-ipc-security'

describe('verify-ipc-security', () => {
  it('finds no unguarded IPC handlers', async () => {
    expect(await verifyIpcSecurity()).toEqual([])
  })
})
