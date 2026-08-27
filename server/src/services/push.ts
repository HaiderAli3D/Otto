import { cancelNudgeData, nudgeData } from '../fcm/commands.js'
import { sendData } from '../fcm/sender.js'
import { log } from '../lib/log.js'
import type { Device } from './devices.js'
import type { OutboxKind } from './outbox.js'

/**
 * Delivering what Otto has to say as a phone notification instead of a WhatsApp message.
 *
 * This is the second transport for the SAME outbox, deliberately not a second producer. The outbox
 * is already the only thing that knows what Otto said, when, in what state, with dedupe, TTLs and
 * collapse; a parallel path would make "how much has Otto said today?" unanswerable again, one
 * layer deeper, with two dedupe regimes and a budget that could only see half the traffic.
 *
 * What it buys is the removal of a hard wall. Meta only permits a free-form message inside 24 hours
 * of the owner's last inbound, so before this a shut window meant everything queued and waited —
 * and with no approved template configured, `shouldKnock` could never fire either. A push has no
 * window, costs nothing, carries the real text, and can be withdrawn later.
 *
 * It also makes the template plan unnecessary rather than merely deferred: a template costs money,
 * has a six-hour cooldown, carries one short variable, cannot be retracted, and is the most-blocked
 * message type there is.
 */

/**
 * How stale a device's heartbeat may be before we stop believing it can receive a push.
 *
 * Generous on purpose. The failure this guards against is spending the day's message budget on
 * pushes that reach nobody — an app force-stopped, uninstalled, or with a token that rotated while
 * the phone was off. Being too eager to declare a phone dead is the worse error: it would route
 * everything to WhatsApp and reintroduce the wall.
 */
const HEARTBEAT_STALE_MS = 3 * 24 * 60 * 60 * 1000

/**
 * The first app build that understands `NUDGE`. Older ones must never be pushed to.
 *
 * This gate is the difference between a delayed message and a lost one. The app's parser drops an
 * unrecognised `type` silently — by design, so a future schema cannot crash it — and a build
 * predating the nudge tier has no way to report the drop either. So without this check the server
 * would send a chase, get a successful FCM response, mark the outbox row SENT, and the owner would
 * simply never see it. That is the exact failure this whole feature exists to remove, reintroduced
 * one layer down.
 *
 * It also makes deployment order a non-issue: the server can ship before the app, and push
 * delivery switches itself on the first time the phone heartbeats with a new enough version.
 */
const MIN_NUDGE_APP_VERSION = '1.1.0'

/**
 * The first app build that understands `REQUEST_LOCATION`.
 *
 * Same mechanism as the nudge gate above, and MORE important rather than merely analogous. That
 * comment says the gate "makes deployment order a non-issue: the server can ship before the app" —
 * true for a nudge BECAUSE a nudge has a second transport and falls back to WhatsApp. A location
 * request has none. Sent to a phone that cannot parse it, the command is dropped silently, the
 * agent waits out its timeout for an answer that was never coming, and the only trace on this side
 * is a log line: `routes/device.ts` does not persist the PUSH/REJECTED the phone dutifully reports.
 *
 * So this gate is not an optimisation, it is the thing that keeps a stalled app release a no-op
 * instead of a broken conversation. Correct deploy order: app 1.2.0 first, confirm via heartbeat
 * that `devices.appVersion` reads 1.2.0, then the server.
 */
const MIN_LOCATION_APP_VERSION = '1.2.0'

/**
 * Dotted-numeric version compare, tolerant of anything that is not one.
 *
 * Returns false for a null, empty or unparseable `appVersion` — refusing to push is always the
 * safe direction here, because the cost of a false negative is a message going over WhatsApp
 * instead, and the cost of a false positive is a message going nowhere at all.
 */
export function versionAtLeast(actual: string | null, minimum: string): boolean {
  if (!actual) return false
  const parse = (v: string): number[] => v.split('.').map((p) => Number.parseInt(p, 10))
  const a = parse(actual)
  const b = parse(minimum)
  if (a.some(Number.isNaN)) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/**
 * How loudly each kind arrives on the phone.
 *
 * The briefs and the weekly review are SILENT because they are scheduled, expected, and nothing in
 * them is time-critical — a summary that buzzes has stopped being a summary. `missed_alarm` and
 * `system_warning` are URGENT because they are the two classes of thing only Otto knows went
 * wrong. A `nudge` sits in between: it is a chase, and a chase the owner does not notice is not a
 * chase, but it is also not an emergency.
 */
/**
 * DORMANT. Nothing in this server calls `pushOutboxRow` any more.
 *
 * Everything Otto SAYS goes over WhatsApp; the Android app is an alarm device and carries nothing
 * else (AGENTS.md rule 7). The tables below, and the transport under them, are kept complete and
 * tested because that decision is worth being able to reverse in one line — but read them as a
 * description of a road not taken, not of what happens today. `pushArm` and the location request
 * further down ARE live: those are an alarm and a location fix, not things Otto says.
 */
const LEVEL_BY_KIND: Record<OutboxKind, 'SILENT' | 'NORMAL' | 'URGENT'> = {
  nudge: 'NORMAL',
  digest: 'SILENT',
  brief: 'SILENT',
  weekly: 'SILENT',
  missed_alarm: 'URGENT',
  system_warning: 'URGENT',
  wake_check: 'URGENT',
  // Answering them, which they are waiting for. It makes a sound and it is not an alarm.
  reply: 'NORMAL',
}

/** How long a notification is worth showing before it becomes noise, by kind. */
const TTL_BY_KIND_MS: Record<OutboxKind, number> = {
  nudge: 6 * 60 * 60 * 1000,
  digest: 12 * 60 * 60 * 1000,
  brief: 8 * 60 * 60 * 1000,
  weekly: 24 * 60 * 60 * 1000,
  missed_alarm: 12 * 60 * 60 * 1000,
  system_warning: 24 * 60 * 60 * 1000,
  wake_check: 45 * 60 * 1000,
  // Short: an answer nobody read within the hour has been overtaken by the conversation.
  reply: 60 * 60 * 1000,
}

/** Can this device receive a nudge right now, as far as we can tell? */
export function pushReachable(device: Device, nowMillis: number = Date.now()): boolean {
  if (!device.fcmToken) return false
  if (!device.hmacSecret) return false
  // An app too old to understand NUDGE would drop it without a word — see MIN_NUDGE_APP_VERSION.
  if (!versionAtLeast(device.appVersion, MIN_NUDGE_APP_VERSION)) return false
  if (device.lastHeartbeatAt === null) return false
  return nowMillis - device.lastHeartbeatAt < HEARTBEAT_STALE_MS
}

/**
 * Can this device be ASKED where its owner is?
 *
 * Deliberately a separate predicate from `pushReachable` rather than a flag on it: the two gate
 * different capabilities behind different minimum versions, and collapsing them would mean a device
 * that can take a nudge but not a location request is treated as one that can do neither, or worse,
 * as one that can do both.
 */
export function locationCapable(device: Device, nowMillis: number = Date.now()): boolean {
  if (!device.fcmToken) return false
  if (!device.hmacSecret) return false
  if (!versionAtLeast(device.appVersion, MIN_LOCATION_APP_VERSION)) return false
  if (device.lastHeartbeatAt === null) return false
  return nowMillis - device.lastHeartbeatAt < HEARTBEAT_STALE_MS
}

/**
 * Send one outbox row to the phone as a notification.
 *
 * Returns false rather than throwing on any failure, so the caller can leave the row PENDING and
 * try again — identical posture to `sendText`, because a transport that throws would take down
 * whichever flush touched it.
 *
 * A `nudge` carrying a reminder id gets Done and Snooze buttons; everything else gets none. That is
 * not a styling choice — the buttons map onto `completeReminder` and `snoozeReminder`, so offering
 * them on a brief would promise an action with nothing behind it.
 */
export async function pushOutboxRow(
  device: Device,
  row: { id: number; kind: string; body: string; reminderId: string | null },
  nowMillis: number = Date.now(),
): Promise<boolean> {
  if (!pushReachable(device, nowMillis)) return false
  const kind = row.kind as OutboxKind
  const level = LEVEL_BY_KIND[kind] ?? 'NORMAL'
  const ttl = TTL_BY_KIND_MS[kind] ?? 6 * 60 * 60 * 1000
  const actionable = kind === 'nudge' && row.reminderId !== null

  // First line as the title, the rest as the body — Otto writes WhatsApp-shaped prose, which has no
  // subject line, and a notification with the same text in both slots reads as a bug.
  const [firstLine, ...rest] = row.body.split('\n')
  const title = firstLine?.trim() || 'Otto'
  const body = rest.join('\n').trim() || row.body

  const data = nudgeData({
    // Reminder-scoped so a chase ladder REPLACES its own notification in place. Falling back to the
    // row id for everything else, which is unique per message and therefore never collapses two
    // different things into one line.
    nudgeId: row.reminderId ?? `out_${row.id}`,
    title,
    body,
    level,
    actions: actionable ? ['DONE', 'SNOOZE'] : [],
    expiresAtMillis: nowMillis + ttl,
    secret: device.hmacSecret!,
  })

  const res = await sendData(device.fcmToken!, data)
  if (!res.ok) {
    log.warn({ deviceId: device.deviceId, kind: row.kind }, 'push delivery failed; leaving the row queued')
    return false
  }
  log.info({ deviceId: device.deviceId, kind: row.kind, level }, 'delivered over push')
  return true
}

/**
 * Clear a nudge from the phone because the reminder behind it is finished with.
 *
 * One of the three cheap mechanisms that keep the phone's mirror from drifting (the others being
 * the nudge's own expiry and the app's sweep of terminal rows). Without it, completing something
 * over WhatsApp would leave a notification on the lockscreen still asking about it — and a stale
 * chase the owner has already dealt with is exactly what teaches them to ignore the channel.
 *
 * Fire-and-forget by contract: never throws, and the caller does not wait on it. A cancel that does
 * not arrive costs a stale notification the app will expire on its own; making a completion wait on
 * FCM would be the worse trade.
 */
export async function withdrawNudge(device: Device, reminderId: string): Promise<void> {
  if (!pushReachable(device)) return
  try {
    await sendData(device.fcmToken!, cancelNudgeData(reminderId, device.hmacSecret!))
  } catch (err) {
    log.warn({ err, deviceId: device.deviceId, reminderId }, 'could not withdraw a nudge from the phone')
  }
}
