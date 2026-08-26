import { eq } from 'drizzle-orm'
import { config } from '../config.js'
import { db } from '../db/client.js'
import { deviceSettings } from '../db/schema.js'
import { inQuietHours, parseQuietHours, type QuietHours } from '../lib/quietHours.js'
import { DEFAULT_ROUTINE, parseRoutine, type Routine } from '../lib/routine.js'
import type { Device } from './devices.js'

export type DeviceSettings = typeof deviceSettings.$inferSelect

/**
 * The row a device has before it has ever changed anything. Mirrors the column defaults in
 * schema.ts exactly — they are the same values twice because SQLite applies its defaults only on
 * INSERT, and `getSettings` must answer for devices that have never had a row inserted at all.
 *
 * `updatedAt: 0` rather than `Date.now()`: a synthesised row must not claim it was just written.
 */
/**
 * The morning brief's out-of-the-box time, named rather than repeated.
 *
 * Three places have to agree on it: the column default in schema.ts, the synthesised row below, and
 * `setPreferences`, which treats "still exactly the default" as "the owner has never chosen a brief
 * time" and therefore as safe to move when they state a routine. A fourth literal 7 drifting from
 * the other three would silently turn a brief the owner had chosen into one Otto felt free to move.
 */
export const DEFAULT_BRIEF_HOUR = 7
export const DEFAULT_BRIEF_MINUTE = 0

function defaults(deviceId: string): DeviceSettings {
  return {
    deviceId,
    briefEnabled: true,
    briefHour: DEFAULT_BRIEF_HOUR,
    briefMinute: DEFAULT_BRIEF_MINUTE,
    eveningBriefEnabled: false,
    eveningBriefHour: 21,
    eveningBriefMinute: 0,
    lastBriefAt: null,
    lastEveningBriefAt: null,
    quietHours: null,
    bedWindow: null,
    wakeWindow: null,
    dailyMessageBudget: 60,
    weeklyReviewAt: null,
    lastWeeklyReviewAt: null,
    autoWakeAlarm: false,
    autoLeaveByAlarm: false,
    defaultTravelMinutes: 30,
    getReadyMinutes: 45,
    updatedAt: 0,
  }
}

/**
 * Never returns undefined — a device with no row gets the defaults, so callers have no branch.
 *
 * That is the whole reason this table has no write-on-pair step: settings rows are created lazily by
 * the first `updateSettings`, and every reader before that sees exactly what a fresh row would hold.
 * A scheduler path that had to handle "no settings yet" would get it wrong once and stay wrong.
 */
export function getSettings(deviceId: string): DeviceSettings {
  return db.select().from(deviceSettings).where(eq(deviceSettings.deviceId, deviceId)).get() ?? defaults(deviceId)
}

/**
 * Apply a partial change, creating the row if this is the first one. Returns the settled row.
 *
 * Read-then-write with NO await in between (better-sqlite3 is synchronous): the merged INSERT and
 * the conflict UPDATE are computed from one consistent read, so a concurrent caller cannot land
 * between them and be overwritten with a stale full row.
 */
export function updateSettings(
  deviceId: string,
  patch: Partial<Omit<DeviceSettings, 'deviceId' | 'updatedAt'>>,
): DeviceSettings {
  // Drop explicit `undefined`s: a caller spreading an optional field would otherwise ask drizzle to
  // write undefined into a NOT NULL column, and "leave it alone" is what they meant.
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as typeof patch
  const now = Date.now()
  const next: DeviceSettings = { ...getSettings(deviceId), ...clean, deviceId, updatedAt: now }
  db.insert(deviceSettings)
    .values(next)
    .onConflictDoUpdate({ target: deviceSettings.deviceId, set: { ...clean, updatedAt: now } })
    .run()
  return next
}

/**
 * Stamp a brief as delivered. The two slots share a table but not a marker — an evening brief must
 * never satisfy the next morning's "have I already run today?" check, or the morning silently stops.
 */
export function markBriefSent(deviceId: string, slot: 'morning' | 'evening', atMillis: number): void {
  updateSettings(deviceId, slot === 'morning' ? { lastBriefAt: atMillis } : { lastEveningBriefAt: atMillis })
}

export function markWeeklyReviewSent(deviceId: string, atMillis: number): void {
  updateSettings(deviceId, { lastWeeklyReviewAt: atMillis })
}

/**
 * Parsed quiet hours for this device: its column, else the configured default.
 *
 * `null` column means "never configured" and falls back. An explicit `"off"` parses to a null window
 * and is honoured AS null — the fallback is keyed on the raw column being absent, not on the parse
 * result, because otherwise the owner switching quiet hours off would silently reinstate the server
 * default and the setting would be impossible to turn off at all.
 */
export function quietHoursFor(device: Device): QuietHours {
  const column = getSettings(device.deviceId).quietHours
  if (column === null) return parseQuietHours(config.quietHoursDefault)
  return parseQuietHours(column)
}

/**
 * Quiet hours as they apply to ONE nag.
 *
 * `escalateWithAlarm` short-circuits to null — no quiet hours at all for this item. That flag is
 * documented on the reminders table as "this WILL wake them" and is opt-in per reminder: the owner
 * asked for this specific thing to break through. A server-wide default silently overriding a
 * per-item opt-in has it exactly backwards — the specific instruction beats the general one, or the
 * opt-in is a lie and the one reminder that mattered is the one that stays quiet.
 */
export function nagQuietHours(device: Device, escalateWithAlarm: boolean): QuietHours {
  if (escalateWithAlarm) return null
  return quietHoursFor(device)
}

/** Is the device inside its quiet window right now? Wall-clock, judged in `device.timezone`. */
export function quietNow(device: Device, now: number = Date.now()): boolean {
  return inQuietHours(now, device.timezone, quietHoursFor(device))
}

/**
 * The owner's stated sleep routine, or null if they have never given one.
 *
 * Null rather than `DEFAULT_ROUTINE` on purpose: the callers that want a fallback say so with
 * `?? DEFAULT_ROUTINE`, and the ones that must NOT invent a routine — the prompt tail, which would
 * otherwise tell Otto a confident bedtime the owner never mentioned — can tell the difference.
 *
 * All-or-nothing (see `parseRoutine`): half a routine says nothing about when their day starts,
 * which is the only thing the rest of the system reads out of it.
 */
export function routineFor(device: Device): Routine | null {
  const s = getSettings(device.deviceId)
  return parseRoutine(s.bedWindow, s.wakeWindow)
}

/** The routine to schedule against — the owner's if stated, else the 09:00-day-start default. */
export function schedulingRoutine(device: Device): Routine {
  return routineFor(device) ?? DEFAULT_ROUTINE
}
