import { describe, expect, it } from 'vitest'
import { computeSig } from '../src/fcm/signer.js'

describe('computeSig — cross-language HMAC contract', () => {
  it('reproduces the exact Android/Kotlin golden vector', () => {
    // This vector is pinned in the app's HmacVerifierTest.kt and cross-checked with node + openssl.
    // If this ever diverges, signed pushes would be silently dropped by the paired phone.
    const data = {
      v: '1',
      type: 'ARM_ALARM',
      alarmId: 'alm_demo',
      triggerAtMillis: 'FIXED',
      label: 'Email Teal',
      allowWhileIdle: 'true',
    }
    expect(computeSig(data, 's3cr3t')).toBe(
      '22ad59bfda272fb03eebb637ec7a20535f562fdde59e7e0c05e28c72afd901a2',
    )
  })

  it('excludes `sig` and is order-independent (keys sorted)', () => {
    const withSig = { b: '2', a: '1', sig: 'anything' }
    const noSig = { a: '1', b: '2' }
    expect(computeSig(withSig, 'k')).toBe(computeSig(noSig, 'k'))
  })
})
