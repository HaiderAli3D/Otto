import { config, parseWeeklyReview } from '../config.js'
import { nextBriefRunAt } from '../lib/briefSchedule.js'
import { formatQuietHours, parseQuietHours } from '../lib/quietHours.js'
import { log } from '../lib/log.js'
import { rescheduleBriefChain } from './brief.js'
import type { Device } from './devices.js'
import { getSettings, quietHoursFor, updateSettings, type DeviceSettings } from './settings.js'
import { epochMillisToLocalHuman } from './time.js'

/**
 * The owner's settings as the agent changes them, and as Otto reads them back.
 *
 * Input arrives from a language model, so this module is the trust boundary: it takes
 * `Record<string, unknown>` and does every check itself rather than pretending a cast is validation.
 * A tool that wrote `briefHour: "half seven"` into a NOT NULL integer column would be a runtime
 * error at 07:00 the next morning, on a path nobody is watching.
 */

/** What "deliberately off" looks like, matching config.ts's split between an off-switch and a typo. */
const OFF_SPECS = new Set(['off', 'none', ''])

/** 1 = Monday … 7 = Sunday, matching luxon and `parseWeeklyReview`. */
const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** The brief columns whose value decides WHEN the chain next fires. */
const BRIEF_TIMING_FIELDS = [
  'briefEnabled',
  'briefHour',
  'briefMinute',
  'eveningBriefEnabled',
  'eveningBriefHour',
  'eveningBriefMinute',
] as const

/**
 * Settings as they now stand, resolved — never as they were asked for.
 *
 * `quietHours` and `weeklyReview` are the EFFECTIVE values, with the server default already folded
 * in for a device that has never set one. Otto confirms from this, so "quiet hours are off" must
 * only ever be said when they are actually off.
 */
export type EffectivePreferences = {
  briefEnabled: boolean
  briefAt: string
  eveningBriefEnabled: boolean
  eveningBriefAt: string
  quietHours: string
  weeklyReview: string
  autoWakeAlarm: boolean
  autoLeaveByAlarm: boolean
  nextBriefLocal: string
}

function hhmm(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function isOff(value: string): boolean {
  return OFF_SPECS.has(value.trim().toLowerCase())
}

function effective(device: Device, s: DeviceSettings): EffectivePreferences {
  // Both fall back the same way settings.ts does: a NULL column means "never configured" and takes
  // the server default, while an explicit "off" is honoured as off. Read through `quietHoursFor` so
  // this and every scheduler path answer from one implementation of that rule.
  const weekly = parseWeeklyReview(s.weeklyReviewAt === null ? config.weeklyReviewDefault : s.weeklyReviewAt)
  return {
    briefEnabled: s.briefEnabled,
    briefAt: hhmm(s.briefHour, s.briefMinute),
    eveningBriefEnabled: s.eveningBriefEnabled,
    eveningBriefAt: hhmm(s.eveningBriefHour, s.eveningBriefMinute),
    quietHours: formatQuietHours(quietHoursFor(device)),
    weeklyReview: weekly === null ? 'off' : `${WEEKDAY_NAMES[weekly.weekday - 1]} ${hhmm(weekly.hour, weekly.minute)}`,
    autoWakeAlarm: s.autoWakeAlarm,
    autoLeaveByAlarm: s.autoLeaveByAlarm,
    nextBriefLocal: epochMillisToLocalHuman(nextBriefRunAt(s, device.timezone, Date.now()), device.timezone),
  }
}

/**
 * Validate a partial change, apply it, and hand back the settled values.
 *
 * All-or-nothing: one bad field rejects the WHOLE patch. Half-applying "brief at 6:30, quiet hours
 * ten-ish" would leave the owner told about a change that only partly happened, and the half that
 * silently failed is the half they would find out about at 04:00.
 *
 * Returns `{ error }` rather than throwing — the caller is a tool_result the model has to recover
 * from, and an exception there kills the whole turn.
 */
export function setPreferences(device: Device, input: Record<string, unknown>): { error: string } | EffectivePreferences {
  const errors: string[] = []

  const flag = (v: unknown, field: string): boolean | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'boolean') {
      errors.push(`${field} must be true or false`)
      return undefined
    }
    return v
  }
  const clock = (v: unknown, max: number, field: string): number | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) {
      errors.push(`${field} must be a whole number between 0 and ${max}`)
      return undefined
    }
    return v
  }

  const patch: Partial<Omit<DeviceSettings, 'deviceId' | 'updatedAt'>> = {
    briefEnabled: flag(input.briefEnabled, 'briefEnabled'),
    briefHour: clock(input.briefHour, 23, 'briefHour'),
    briefMinute: clock(input.briefMinute, 59, 'briefMinute'),
    eveningBriefEnabled: flag(input.eveningBriefEnabled, 'eveningBriefEnabled'),
    eveningBriefHour: clock(input.eveningBriefHour, 23, 'eveningBriefHour'),
    eveningBriefMinute: clock(input.eveningBriefMinute, 59, 'eveningBriefMinute'),
    autoWakeAlarm: flag(input.autoWakeAlarm, 'autoWakeAlarm'),
    autoLeaveByAlarm: flag(input.autoLeaveByAlarm, 'autoLeaveByAlarm'),
  }

  // Both text settings are stored RAW and parsed at the point of use, exactly like the server-wide
  // defaults in config.ts — so "off" is normalised to the literal string rather than to NULL, which
  // means "never configured" and would silently reinstate the server default.
  if (input.quietHours !== undefined) {
    const raw = typeof input.quietHours === 'string' ? input.quietHours.trim() : null
    if (raw === null) errors.push('quietHours must be a string like "22:00-07:00" or "off"')
    else if (isOff(raw)) patch.quietHours = 'off'
    else if (parseQuietHours(raw) === null) errors.push(`quietHours "${raw}" must be "HH:MM-HH:MM" or "off"`)
    else patch.quietHours = raw
  }
  if (input.weeklyReview !== undefined) {
    const raw = typeof input.weeklyReview === 'string' ? input.weeklyReview.trim() : null
    if (raw === null) errors.push('weeklyReview must be a string like "SUN:18:00" or "off"')
    else if (isOff(raw)) patch.weeklyReviewAt = 'off'
    else if (parseWeeklyReview(raw) === null) errors.push(`weeklyReview "${raw}" must be "DDD:HH:MM" (e.g. SUN:18:00) or "off"`)
    else patch.weeklyReviewAt = raw.toUpperCase()
  }

  if (errors.length > 0) return { error: errors.join('; ') }

  const before = getSettings(device.deviceId)
  const after = updateSettings(device.deviceId, patch)

  // The pending job row already holds an instant computed from the OLD times, and ensureSingletonJob
  // deliberately leaves an existing row alone — so without this, "move my brief to 6:30" would do
  // nothing tomorrow and only take effect the day after.
  if (BRIEF_TIMING_FIELDS.some((k) => before[k] !== after[k])) {
    rescheduleBriefChain(device)
    log.info({ deviceId: device.deviceId }, 'brief timing changed; chain moved')
  }
  return effective(device, after)
}
