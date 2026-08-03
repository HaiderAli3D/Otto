import { DateTime } from 'luxon'
import type { DeviceSettings } from '../services/settings.js'
import { nextLocalTimeAt } from '../services/time.js'

/**
 * When the daily brief runs, as pure arithmetic over the owner's settings.
 *
 * No database, no config, no logging — the settings TYPE only, so this can be reasoned about and
 * tested without a device row, a schema, or a clock that anyone has to mock. The scheduler side of
 * the feature lives in services/handlers/brief.ts; everything about *which instant* is here.
 */

/** Which of the two daily boundaries a scheduled instant belongs to. */
export type BriefSlot = 'morning' | 'evening'

/**
 * The next instant this device should be briefed at: the earlier of its next enabled morning and
 * evening boundary, STRICTLY after `nowMillis`.
 *
 * Wall-clock via `nextLocalTimeAt`, never "now + 24h". A fixed millisecond offset drifts by an hour
 * twice a year, so a 07:00 brief would start landing at 06:00 or 08:00 after a DST change — and the
 * two mornings a year when the clocks move are exactly the mornings a brief is worth having.
 *
 * With BOTH slots disabled this still returns a real future instant rather than null. The job row IS
 * the chain: keeping it alive at the morning boundary costs one row and one no-op wake-up a day,
 * whereas deleting it means the chain has to be re-seeded the moment the owner turns a brief back
 * on, and every path that could forget to do that is a feature that silently never comes back.
 */
export function nextBriefRunAt(s: DeviceSettings, zone: string, nowMillis: number): number {
  const morning = nextLocalTimeAt(nowMillis, zone, s.briefHour, s.briefMinute)
  const evening = nextLocalTimeAt(nowMillis, zone, s.eveningBriefHour, s.eveningBriefMinute)
  const enabled: number[] = []
  if (s.briefEnabled) enabled.push(morning)
  if (s.eveningBriefEnabled) enabled.push(evening)
  if (enabled.length === 0) return morning
  return Math.min(...enabled)
}

/**
 * Which slot a scheduled instant is, or null if it is neither.
 *
 * The handler needs no payload and there is exactly ONE brief row per device: the row's own
 * `runAtMillis` carries the slot, because the local wall-clock time it lands at is by construction
 * one of the two configured boundaries. Storing the slot in the payload instead would let the row
 * and the settings disagree the first time the owner moved their brief.
 *
 * Reading null is normal, not an error: the owner changed the time (so the pending row now points at
 * an instant that is no longer a boundary) or turned that slot off. Both mean "say nothing today",
 * and the handler still advances the chain to the new boundary afterwards.
 *
 * Morning is tested first, so two slots configured for the same minute resolve as morning — an
 * evening brief about tomorrow at 07:00 would be the wrong one of the two to keep.
 */
export function slotForRunAt(s: DeviceSettings, zone: string, runAtMillis: number): BriefSlot | null {
  const at = DateTime.fromMillis(runAtMillis, { zone })
  const minuteOfDay = at.hour * 60 + at.minute
  if (s.briefEnabled && minuteOfDay === s.briefHour * 60 + s.briefMinute) return 'morning'
  if (s.eveningBriefEnabled && minuteOfDay === s.eveningBriefHour * 60 + s.eveningBriefMinute) return 'evening'
  return null
}
