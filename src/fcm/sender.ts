import { GoogleAuth } from 'google-auth-library'
import { config } from '../config.js'
import { log } from '../lib/log.js'

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const auth = new GoogleAuth({ credentials: config.firebase.serviceAccount, scopes: [FCM_SCOPE] })

export type FcmSendResult =
  | { ok: true }
  | { ok: false; status: number; unregistered: boolean; body: string }

/**
 * Send a DATA-ONLY, high-priority message to a device token (FCM HTTP v1). Every value in
 * `data` must already be a string, and `data.sig` must be set — see fcm/commands.ts. No
 * `notification` block, so the app's onMessageReceived always runs.
 */
export async function sendData(token: string, data: Record<string, string>): Promise<FcmSendResult> {
  try {
    const accessToken = await auth.getAccessToken()
    const message = { message: { token, android: { priority: 'high' as const }, data } }
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${config.firebase.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      },
    )
    const body = await res.text()
    if (res.ok) return { ok: true }
    // 404 / UNREGISTERED / INVALID_ARGUMENT ⇒ the token is dead; the caller should clear it so the
    // app re-registers on next open (OttoFcmService.onNewToken).
    const unregistered = res.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/i.test(body)
    log.warn({ status: res.status, unregistered }, 'FCM send failed')
    return { ok: false, status: res.status, unregistered, body }
  } catch (err) {
    // Auth/network failure must never crash the caller's request or agent turn.
    log.error({ err }, 'FCM send threw')
    return { ok: false, status: 0, unregistered: false, body: err instanceof Error ? err.message : String(err) }
  }
}
