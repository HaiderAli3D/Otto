import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Signed-request auth for the device endpoints, mirroring the app's fail-closed-once-paired
 * HmacGate: a device that has never authenticated may call unsigned (bootstrap — the app has no
 * secret until the owner pairs), but once one valid signature is seen the device row latches and
 * every later call must be signed.
 *
 * Canonical form (must match the app's net/RequestSigner.kt exactly):
 *   METHOD \n path[?query] \n tsMillis \n sha256hex(bodyBytes)
 * HMAC-SHA256 with the device's pairing secret as a UTF-8 string key, lowercase hex output.
 * Requires the server to be mounted at the origin root (see SETUP.md "Hardening").
 */

export const AUTH_WINDOW_MS = 300_000 // ±5 min replay/skew window

export function bodySha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex')
}

export function canonicalRequest(method: string, pathWithQuery: string, ts: string, bodyHashHex: string): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${ts}\n${bodyHashHex}`
}

export function computeRequestSig(
  secret: string,
  method: string,
  pathWithQuery: string,
  ts: string,
  body: Buffer,
): string {
  return createHmac('sha256', secret).update(canonicalRequest(method, pathWithQuery, ts, bodySha256Hex(body))).digest('hex')
}

export function verifyRequestSig(params: {
  secret: string
  method: string
  pathWithQuery: string
  tsHeader: string | undefined
  sigHeader: string | undefined
  body: Buffer
  nowMillis: number
}): boolean {
  if (!params.tsHeader || !params.sigHeader) return false
  const ts = Number(params.tsHeader)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(params.nowMillis - ts) > AUTH_WINDOW_MS) return false
  const expected = computeRequestSig(params.secret, params.method, params.pathWithQuery, params.tsHeader, params.body)
  const expectedBuf = Buffer.from(expected, 'utf8')
  const actualBuf = Buffer.from(params.sigHeader, 'utf8')
  if (expectedBuf.length !== actualBuf.length) return false
  return timingSafeEqual(expectedBuf, actualBuf)
}
