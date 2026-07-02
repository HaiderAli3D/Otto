import { randomBytes } from 'node:crypto'

/**
 * CSRF protection for the Google OAuth handshake. The `state` parameter must be an unguessable
 * value WE minted for a specific deviceId, not the raw deviceId — otherwise anyone could drive
 * `/oauth/google/callback?code=<their code>&state=<owner deviceId>` and bind their own Google
 * account to the owner's device. We issue a random nonce at `/start`, remember which deviceId it
 * was for, and only accept a callback whose state matches an outstanding nonce (single-use).
 *
 * In-memory + single-use with a short TTL. The scheduler already requires a single resident
 * process, so a Map is sufficient; an OAuth begun just before a restart simply needs retrying.
 */

const TTL_MS = 10 * 60_000
const pending = new Map<string, { deviceId: string; expiresAt: number }>()

export function issueOAuthState(deviceId: string, nowMillis: number): string {
  const state = randomBytes(24).toString('hex')
  pending.set(state, { deviceId, expiresAt: nowMillis + TTL_MS })
  // Opportunistically evict expired entries so the map can't grow unbounded.
  for (const [key, val] of pending) if (val.expiresAt <= nowMillis) pending.delete(key)
  return state
}

/** Consume a callback state, returning its deviceId once (and only once), or null if invalid. */
export function consumeOAuthState(state: string, nowMillis: number): string | null {
  const entry = pending.get(state)
  if (!entry) return null
  pending.delete(state)
  if (entry.expiresAt <= nowMillis) return null
  return entry.deviceId
}
