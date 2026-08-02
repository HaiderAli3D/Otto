import { sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import {
  getSettings,
  markBriefSent,
  markWeeklyReviewSent,
  nagQuietHours,
  quietHoursFor,
  quietNow,
  updateSettings,
} from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

beforeEach(() => ensureSchema())

/** The window QUIET_HOURS_DEFAULT carries in the test environment (nothing overrides it). */
const DEFAULT_WINDOW = { startMinute: 22 * 60, endMinute: 7 * 60 }

describe('getSettings never has a missing-row case', () => {
  it('returns full defaults for a device that has never been configured', () => {
    // The guarantee every scheduler path depends on: no row, no throw, no undefined, no branch.
    const s = getSettings('dev_never_seen')
    expect(s.deviceId).toBe('dev_never_seen')
    expect(s.briefEnabled).toBe(true)
    expect(s.briefHour).toBe(7)
    expect(s.briefMinute).toBe(0)
    expect(s.eveningBriefEnabled).toBe(false)
    expect(s.eveningBriefHour).toBe(21)
    expect(s.quietHours).toBeNull()
    expect(s.weeklyReviewAt).toBeNull()
    expect(s.autoWakeAlarm).toBe(false)
    expect(s.autoLeaveByAlarm).toBe(false)
    expect(s.defaultTravelMinutes).toBe(30)
    expect(s.getReadyMinutes).toBe(45)
    // A synthesised row must not claim it was just written.
    expect(s.updatedAt).toBe(0)
  })

  it('agrees with what SQLite fills in for a bare row', () => {
    // The real target here is db/client.ts: every device_settings column except device_id/updated_at
    // arrives through an ensureColumn ADD COLUMN ... DEFAULT, and a synthesised default that drifts
    // from the DDL would make a fresh device behave differently from a configured one. Raw SQL on
    // purpose — it names only the two columns the CREATE TABLE has, so SQLite must supply the rest.
    db.run(sql`INSERT INTO device_settings (device_id, updated_at) VALUES ('dev_s0', 5)`)
    expect(getSettings('dev_s0')).toEqual({ ...getSettings('dev_unwritten'), deviceId: 'dev_s0', updatedAt: 5 })
  })
})

describe('updateSettings', () => {
  it('creates the row on first write and updates it on the second', () => {
    updateSettings('dev_s1', { briefHour: 6, briefMinute: 45 })
    expect(getSettings('dev_s1').briefHour).toBe(6)
    expect(getSettings('dev_s1').briefMinute).toBe(45)

    updateSettings('dev_s1', { briefHour: 8 })
    const after = getSettings('dev_s1')
    expect(after.briefHour).toBe(8)
    // A patch is a patch: the field it didn't mention survives.
    expect(after.briefMinute).toBe(45)
    expect(after.updatedAt).toBeGreaterThan(0)
  })

  it('writes booleans and nullable text through unchanged', () => {
    updateSettings('dev_s2', { autoWakeAlarm: true, quietHours: '23:30-06:15' })
    const s = getSettings('dev_s2')
    expect(s.autoWakeAlarm).toBe(true)
    expect(s.quietHours).toBe('23:30-06:15')
  })

  it('ignores an explicit undefined rather than nulling a NOT NULL column', () => {
    updateSettings('dev_s3', { getReadyMinutes: 20 })
    updateSettings('dev_s3', { getReadyMinutes: undefined, briefHour: 9 })
    expect(getSettings('dev_s3').getReadyMinutes).toBe(20)
    expect(getSettings('dev_s3').briefHour).toBe(9)
  })
})

describe('send markers', () => {
  it('keeps the morning and evening brief markers apart', () => {
    markBriefSent('dev_s4', 'morning', 1_000)
    expect(getSettings('dev_s4').lastBriefAt).toBe(1_000)
    expect(getSettings('dev_s4').lastEveningBriefAt).toBeNull()

    markBriefSent('dev_s4', 'evening', 2_000)
    const s = getSettings('dev_s4')
    // If these shared a column, an evening brief would satisfy the next morning's once-a-day guard.
    expect(s.lastBriefAt).toBe(1_000)
    expect(s.lastEveningBriefAt).toBe(2_000)
  })

  it('stamps the weekly review', () => {
    markWeeklyReviewSent('dev_s5', 3_000)
    expect(getSettings('dev_s5').lastWeeklyReviewAt).toBe(3_000)
  })
})

describe('quietHoursFor', () => {
  it('falls back to the configured default when the column was never set', () => {
    const device = makeDevice('dev_s6', null)
    expect(config.quietHoursDefault).toBe('22:00-07:00')
    expect(quietHoursFor(device)).toEqual(DEFAULT_WINDOW)
  })

  it('honours an explicit "off" instead of falling back', () => {
    // The fallback is keyed on the column being ABSENT, not on the parse returning null — otherwise
    // turning quiet hours off would silently reinstate the default and be impossible to switch off.
    const device = makeDevice('dev_s7', null)
    updateSettings(device.deviceId, { quietHours: 'off' })
    expect(quietHoursFor(device)).toBeNull()
  })

  it('uses the device window when one is set', () => {
    const device = makeDevice('dev_s8', null)
    updateSettings(device.deviceId, { quietHours: '23:00-06:30' })
    expect(quietHoursFor(device)).toEqual({ startMinute: 23 * 60, endMinute: 6 * 60 + 30 })
  })

  it('degrades a garbage column to no quiet hours rather than throwing', () => {
    const device = makeDevice('dev_s9', null)
    updateSettings(device.deviceId, { quietHours: 'whenever-ish' })
    expect(quietHoursFor(device)).toBeNull()
  })
})

describe('nagQuietHours', () => {
  it('returns null when the reminder opted in to escalation', () => {
    // escalateWithAlarm is documented as "this WILL wake them" and is opt-in per reminder. A global
    // default must never silently override the one item the owner explicitly asked to break through.
    const device = makeDevice('dev_s10', null)
    expect(quietHoursFor(device)).toEqual(DEFAULT_WINDOW)
    expect(nagQuietHours(device, true)).toBeNull()
  })

  it('is just the device window for an ordinary nag', () => {
    const device = makeDevice('dev_s11', null)
    updateSettings(device.deviceId, { quietHours: '21:00-08:00' })
    expect(nagQuietHours(device, false)).toEqual({ startMinute: 21 * 60, endMinute: 8 * 60 })
  })
})

describe('quietNow', () => {
  // makeDevice inherits config.defaultTimezone, which is UTC in the test environment.
  const at = (hour: number, minute = 0): number => Date.UTC(2026, 7, 3, hour, minute)

  it('is true inside the default window, on both sides of midnight', () => {
    const device = makeDevice('dev_s12', null)
    expect(device.timezone).toBe('UTC')
    expect(quietNow(device, at(23))).toBe(true)
    expect(quietNow(device, at(3))).toBe(true)
  })

  it('is false in the middle of the day, and at the exclusive end of the window', () => {
    const device = makeDevice('dev_s13', null)
    expect(quietNow(device, at(12))).toBe(false)
    // 07:00 is the end, and the end is exclusive — that is what makes deferral idempotent.
    expect(quietNow(device, at(7))).toBe(false)
    expect(quietNow(device, at(6, 59))).toBe(true)
  })

  it('is never true once the owner switches quiet hours off', () => {
    const device = makeDevice('dev_s14', null)
    updateSettings(device.deviceId, { quietHours: 'off' })
    expect(quietNow(device, at(3))).toBe(false)
  })
})
