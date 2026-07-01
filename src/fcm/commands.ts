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
