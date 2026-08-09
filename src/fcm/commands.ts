import { computeSig } from './signer.js'

const V = '1'

/**
 * Build the exact string `data` maps the app's CommandParser expects, then attach `sig`. All
 * values are strings (FCM constraint); ARM includes triggerAtMillis/label/allowWhileIdle, CANCEL
 * carries only alarmId, SYNC/PING carry no fields. The sig is computed over the map WITHOUT sig.
 */
export function armData(params: {
  alarmId: string
  triggerAtMillis: number
  label: string
  allowWhileIdle: boolean
  secret: string
}): Record<string, string> {
  const data: Record<string, string> = {
    v: V,
    type: 'ARM_ALARM',
    alarmId: params.alarmId,
    triggerAtMillis: String(params.triggerAtMillis),
    label: params.label,
    allowWhileIdle: params.allowWhileIdle ? 'true' : 'false',
  }
  data.sig = computeSig(data, params.secret)
  return data
}

export function cancelData(alarmId: string, secret: string): Record<string, string> {
  const data: Record<string, string> = { v: V, type: 'CANCEL_ALARM', alarmId }
  data.sig = computeSig(data, secret)
  return data
}

export function syncData(secret: string): Record<string, string> {
  const data: Record<string, string> = { v: V, type: 'SYNC' }
  data.sig = computeSig(data, secret)
  return data
}

export function pingData(secret: string): Record<string, string> {
  const data: Record<string, string> = { v: V, type: 'PING' }
  data.sig = computeSig(data, secret)
  return data
}

/**
 * Render limits, applied HERE — before the signature is computed.
 *
 * Not a nicety. FCM caps a `data` payload at 4KB, and `fcm/sender.ts` deliberately does not treat
 * `INVALID_ARGUMENT` as a dead token (it also fires for request problems, and clearing a working
 * token there would kill all future delivery). So an oversize nudge fails SILENTLY: the send
 * returns an error nobody acts on, the server records a successful chase, and the owner is never
 * told anything. Truncating before signing is what makes that unreachable.
 *
 * The app clamps again on render; two clamps because this one protects delivery and that one
 * protects the phone from a server bug.
 */
const MAX_TITLE_CHARS = 80
const MAX_BODY_CHARS = 500

/**
 * A nudge: notification text for the phone, with no ringing involved.
 *
 * `nudgeId` is the reminder's own id. That identity is what lets a chase ladder update ONE
 * notification in place instead of stacking a dozen, and what lets a "Done" tapped on the
 * lockscreen come back naming the reminder it belongs to.
 *
 * `level` and `actions` are omitted from the map entirely when they are the defaults rather than
 * sent as empty strings — the app distinguishes an absent `actions` (use the default pair) from an
 * explicitly empty one (a plain notification with no buttons), and sending `""` for "I have no
 * opinion" would silently mean the opposite.
 */
export function nudgeData(params: {
  nudgeId: string
  title: string
  body: string
  level?: 'SILENT' | 'NORMAL' | 'URGENT'
  actions?: string[]
  snoozeMinutes?: number
  expiresAtMillis?: number | null
  ongoing?: boolean
  secret: string
}): Record<string, string> {
  const data: Record<string, string> = {
    v: V,
    type: 'NUDGE',
    nudgeId: params.nudgeId,
    title: params.title.slice(0, MAX_TITLE_CHARS),
    body: params.body.slice(0, MAX_BODY_CHARS),
  }
  if (params.level !== undefined) data.level = params.level
  if (params.actions !== undefined) data.actions = params.actions.join(',')
  if (params.snoozeMinutes !== undefined) data.snoozeMinutes = String(params.snoozeMinutes)
  if (params.expiresAtMillis != null) data.expiresAtMillis = String(params.expiresAtMillis)
  if (params.ongoing !== undefined) data.ongoing = params.ongoing ? 'true' : 'false'
  data.sig = computeSig(data, params.secret)
  return data
}

/** Withdraw a nudge — the reminder was completed or cancelled somewhere else. */
export function cancelNudgeData(nudgeId: string, secret: string): Record<string, string> {
  const data: Record<string, string> = { v: V, type: 'CANCEL_NUDGE', nudgeId }
  data.sig = computeSig(data, secret)
  return data
}

/** The reason is shown to the owner on their phone, so it is clamped like a title rather than a body. */
const MAX_REASON_CHARS = 120

/**
 * Ask the phone where the owner is, once.
 *
 * Not tracking, and the shape of this payload is the argument: there is a `requestId` because the
 * phone answers exactly ONCE per question, and deliberately no interval, no duration and no
 * stop counterpart. There is nothing here to leave running.
 *
 * `reason` is not decoration. The phone must post a visible notification to take a fix at all, and
 * this string is what turns that notice from "Otto checked your location" into "Otto checked your
 * location, to work out when to leave for the dentist". It is the difference between the feature
 * being transparent and feeling covert, and it costs one field.
 *
 * ⚠️ Never send this without checking `locationCapable(device)` first. An app older than
 * MIN_LOCATION_APP_VERSION drops an unrecognised type, and unlike a nudge — which falls back to
 * WhatsApp — a location request has NO second transport. The agent would simply wait for an answer
 * that was never coming.
 */
export function requestLocationData(params: {
  requestId: string
  maxAgeSeconds?: number
  expiresAtMillis?: number | null
  highAccuracy?: boolean
  reason?: string | null
  secret: string
}): Record<string, string> {
  const data: Record<string, string> = { v: V, type: 'REQUEST_LOCATION', requestId: params.requestId }
  if (params.maxAgeSeconds !== undefined) data.maxAgeSeconds = String(params.maxAgeSeconds)
  if (params.expiresAtMillis != null) data.expiresAtMillis = String(params.expiresAtMillis)
  if (params.highAccuracy !== undefined) data.highAccuracy = params.highAccuracy ? 'true' : 'false'
  if (params.reason) data.reason = params.reason.slice(0, MAX_REASON_CHARS)
  data.sig = computeSig(data, params.secret)
  return data
}
