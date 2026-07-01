import { createHmac } from 'node:crypto'

/**
 * Canonical HMAC — MUST be byte-identical to the Android client
 * (`push/HmacVerifier.kt`) and `tools/send-push/send-push.mjs`:
 * take the data map, drop `sig`, sort keys ascending, join `key=value` with `&`
 * (raw values, no url-encoding), HMAC-SHA256 with the shared secret, lowercase hex.
 *
 * Pinned by test/signer.test.ts against the same golden vector the Kotlin unit test uses.
 */
export function computeSig(data: Record<string, string>, secret: string): string {
  const canonical = Object.keys(data)
    .filter((k) => k !== 'sig')
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('&')
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
}
