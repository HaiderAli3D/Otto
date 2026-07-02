import { describe, expect, it } from 'vitest'
import { consumeOAuthState, issueOAuthState } from '../src/services/oauthState.js'

describe('oauth state nonce', () => {
  it('round-trips a fresh state to its deviceId exactly once', () => {
    const now = 1_000_000
    const state = issueOAuthState('dev_o1', now)
    expect(state).toMatch(/^[0-9a-f]{48}$/)
    expect(consumeOAuthState(state, now)).toBe('dev_o1')
    // Single-use: a replay is rejected.
    expect(consumeOAuthState(state, now)).toBeNull()
  })

  it('rejects an unknown state (forgery attempt with a raw deviceId)', () => {
    expect(consumeOAuthState('dev_owner', 1_000_000)).toBeNull()
  })

  it('rejects an expired state', () => {
    const now = 1_000_000
    const state = issueOAuthState('dev_o2', now)
    expect(consumeOAuthState(state, now + 11 * 60_000)).toBeNull()
  })
})
