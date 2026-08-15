import { log } from '../lib/log.js'

/** One pinned Graph API version for every caller — a mismatch between two of them is a silent bug. */
export const GRAPH_BASE = 'https://graph.facebook.com/v22.0'

/** Byte-identical to the envelope sendText carried alone before three callers needed it. */
export const GRAPH_ATTEMPTS = 3
const RETRY_DELAYS_MS = [500, 1500]

/**
 * Bound every Graph call, mirroring fcm/sender.ts. The bare `fetch` this replaced had no signal at
 * all, so a black-holed socket hung on undici's ~5 minute default — inside an agent turn, or inside
 * a scheduler tick that refuses to start the next one while a job is still running.
 *
 * This is a real behaviour change for sendText: a hung connection now aborts at 15s and, because an
 * abort surfaces as a throw, is classified TRANSIENT and retried, where before it just hung.
 */
const TIMEOUT_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export type GraphResult =
  /** The body is deliberately UNREAD, so the caller picks json/text/arrayBuffer (media is binary). */
  | { ok: true; res: Response; attempts: number }
  /** `attempts` is carried so a caller's outcome log can still say how hard we tried. */
  | { ok: false; permanent: boolean; status: number; body: string; attempts: number }

/**
 * One Graph call with the shared retry envelope. Never throws.
 *
 * Retry classification, unchanged from the original sendText loop: a throw (network, abort), a 429,
 * or a 5xx is transient and retried; ANY other non-2xx is permanent and returned immediately —
 * retrying a 400 just spends three times as long arriving at the same answer.
 *
 * Only the per-attempt retries are logged here. The OUTCOME is the caller's to log, because callers
 * disagree about what it means: an out-of-window 400 is a warn for sendText and would be an error
 * for anyone else.
 */
export async function graphFetch(url: string, init: RequestInit): Promise<GraphResult> {
  for (let attempt = 1; attempt <= GRAPH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (res.ok) return { ok: true, res, attempts: attempt }
      const body = await res.text().catch(() => '')
      if (res.status !== 429 && res.status < 500) {
        return { ok: false, permanent: true, status: res.status, body, attempts: attempt }
      }
      log.warn({ status: res.status, attempt }, 'Graph call failed; retrying')
    } catch (err) {
      log.warn({ err, attempt }, 'Graph call threw; retrying')
    }
    if (attempt < GRAPH_ATTEMPTS) await sleep(RETRY_DELAYS_MS[attempt - 1] ?? 1500)
  }
  return { ok: false, permanent: false, status: 0, body: 'retries exhausted', attempts: GRAPH_ATTEMPTS }
}
