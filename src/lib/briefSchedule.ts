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
 * evening brief about tomorrow at 07:00 would be the wrong one of the two to keep. `set_preferences`
 * refuses to create that clash in the first place; this is the tie-break for a row that predates it.
 *
 * The match is a ROUND TRIP through luxon, not a comparison of hour and minute, and that is the
 * whole DST story. On a spring-forward morning the configured wall clock may not exist: a brief set
 * for 01:00 on 28 March 2027 in London has no instant, so `nextLocalTimeAt` schedules the row at the
 * 02:00 luxon corrects it to. Reading hour and minute back off that row gives 2 and 0, which matches
 * neither boundary, and the brief is skipped for the day — once a year, silently, for any setting in
 * the missing hour. Re-imposing the configured time on the row's own day goes through exactly the
 * same correction, so the two sides agree by construction rather than by coincidence.
 */
export function slotForRunAt(s: DeviceSettings, zone: string, runAtMillis: number): BriefSlot | null {
  // To the minute, because that is the resolution a boundary is configured at. Job rows are always
  // scheduled on the minute by `nextBriefRunAt`, but a stray second must never cost a whole brief.
  const at = DateTime.fromMillis(runAtMillis, { zone }).set({ second: 0, millisecond: 0 })
  const isBoundary = (hour: number, minute: number): boolean => at.set({ hour, minute }).toMillis() === at.toMillis()
  if (s.briefEnabled && isBoundary(s.briefHour, s.briefMinute)) return 'morning'
  if (s.eveningBriefEnabled && isBoundary(s.eveningBriefHour, s.eveningBriefMinute)) return 'evening'
  return null
}
