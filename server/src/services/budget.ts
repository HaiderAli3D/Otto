import { DateTime } from 'luxon'
import { db } from '../db/client.js'
import { outbox } from '../db/schema.js'
import { and, eq, gte, inArray, sql } from 'drizzle-orm'
import type { Device } from './devices.js'
import type { OutboxKind } from './outbox.js'
import { getSettings } from './settings.js'

/**
 * A runaway backstop on how much Otto says in a day. NOT a volume policy.
 *
 * The owner asked to be chased hard and the ladders are built to oblige, so the default ceiling is
 * deliberately far above anything a sane day produces. What this exists for is the failure mode the
 * dense ladders newly make possible: a `relentless` reminder whose rungs are minutes apart, several
 * of them at once, against a phone that is asleep. Before this there was no single place in the
 * system that could answer "how much has Otto said today?" at all — frequency was an emergent
 * property of five independent producers.
 *
 * Derived from the outbox on every read rather than kept in a counter column. A counter would
 * disagree with reality the first time a process died between the send and the increment, and the
 * disagreement would be invisible.
 */

/**
 * Kinds that are never held, however much has gone out.
 *
 * Each is something only Otto knows went wrong, or a bounded ladder that ends by ringing anyway.
 * `nudge`, `brief`, `weekly` and `digest` all count and can all be held — a budget the brief could
 * step around would be a budget on nudges wearing a more general name.
 */
export const BUDGET_EXEMPT_KINDS: readonly OutboxKind[] = ['wake_check', 'system_warning', 'missed_alarm']

/**
 * Listed here rather than imported from outbox.ts to avoid an import cycle — outbox.ts consults the
 * budget at flush time. Pinned against the real union by a test.
 */
const OUTBOX_KINDS: OutboxKind[] = ['nudge', 'digest', 'missed_alarm', 'system_warning', 'brief', 'weekly', 'wake_check']

/** The kinds a day's ceiling actually applies to. */
const BUDGETED_KINDS: string[] = OUTBOX_KINDS.filter((k) => !BUDGET_EXEMPT_KINDS.includes(k))

export type BudgetState = {
  /** 0 means unlimited. */
  limit: number
  spent: number
  remaining: number
  exhausted: boolean
}

/** Start of the current local day in the device's zone. */
function dayStart(nowMillis: number, zone: string): number {
  return DateTime.fromMillis(nowMillis, { zone }).startOf('day').toMillis()
}

/**
 * Budgeted messages delivered (or in flight) to this device since local midnight.
 *
 * `SENDING` counts alongside `SENT`: a row claimed by an in-flight flush is about to interrupt the
 * owner, and not counting it would let a burst slip through in the window between claim and send.
 */
export function messagesSentToday(deviceId: string, zone: string, nowMillis: number): number {
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(outbox)
    .where(
      and(
        eq(outbox.deviceId, deviceId),
        inArray(outbox.state, ['SENT', 'SENDING']),
        inArray(outbox.kind, BUDGETED_KINDS),
        gte(outbox.sentAtMillis, dayStart(nowMillis, zone)),
      ),
    )
    .get()
  return row?.n ?? 0
}

export function budgetState(device: Device, nowMillis: number = Date.now()): BudgetState {
  const limit = getSettings(device.deviceId).dailyMessageBudget
  if (limit <= 0) return { limit: 0, spent: 0, remaining: Number.POSITIVE_INFINITY, exhausted: false }
  const spent = messagesSentToday(device.deviceId, device.timezone, nowMillis)
  return { limit, spent, remaining: Math.max(0, limit - spent), exhausted: spent >= limit }
}

/**
 * May this message go out?
 *
 * `escalating` is the per-item override, and it beats the global ceiling for the same reason
 * `nagQuietHours` lets `escalateWithAlarm` past quiet hours: a reminder the owner explicitly marked
 * as one that WILL wake them cannot be the one thing a general default silences.
 */
export function budgetAllows(
  device: Device,
  kind: OutboxKind,
  opts: { escalating?: boolean } = {},
  nowMillis: number = Date.now(),
): boolean {
  if (BUDGET_EXEMPT_KINDS.includes(kind)) return true
  if (opts.escalating === true) return true
  return !budgetState(device, nowMillis).exhausted
}

/** The instant the budget refills — the next local midnight. */
export function budgetResetsAt(zone: string, nowMillis: number): number {
  return DateTime.fromMillis(nowMillis, { zone }).plus({ days: 1 }).startOf('day').toMillis()
}

/**
 * One line for the volatile prompt tail, or null when there is nothing worth saying.
 *
 * Rendered only near the ceiling, for two reasons. It costs tokens on every turn, and — more
 * importantly — Otto must not start narrating a budget that is nowhere near binding, which would
 * read as excuse-making. But when it IS binding Otto has to know: promising "I'll chase you at 6"
 * and then being silently held is exactly the kind of lie the accountability prompt forbids.
 */
export function describeBudget(device: Device, nowMillis: number = Date.now()): string | null {
  const b = budgetState(device, nowMillis)
  if (b.limit === 0) return null
  if (b.exhausted) {
    return (
      `You have sent the owner ${b.spent} messages today and are at your daily ceiling of ${b.limit}. ` +
      'Anything else you were going to raise on your own waits until after midnight. Replying to them ' +
      'is unaffected, and so is tacking one thing onto a reply — that spends no message, because it ' +
      'cancels one you were going to send. Do not promise a chase you cannot make tonight.'
    )
  }
  if (b.spent >= Math.ceil(b.limit * 0.8)) {
    return `You have sent the owner ${b.spent} of your ${b.limit} messages for today. Spend what is left on what matters.`
  }
  return null
}
