import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({ sendData: vi.fn(async () => ({ ok: true as const })) }))

import { and, eq } from 'drizzle-orm'
import { runTool } from '../src/agent/tools.js'
import { config } from '../src/config.js'
import { db, ensureSchema } from '../src/db/client.js'
import { jobs } from '../src/db/schema.js'
import { scheduleBriefChain } from '../src/services/brief.js'
import type { Device } from '../src/services/devices.js'
import { seedWeeklyReview } from '../src/services/handlers/weeklyReview.js'
import { getSettings, updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

/** Monday 3 August 2026, 05:00 — before the default 07:00 brief, so "next" is still today. */
const NOW = Date.UTC(2026, 7, 3, 5, 0, 0)

beforeEach(() => {
  ensureSchema()
  db.delete(jobs).run()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

/** The tool is reached the way the agent reaches it, through the one dispatch table. */
const setPrefs = async (device: Device, input: Record<string, unknown>): Promise<Record<string, unknown>> =>
  (await runTool(device, 'set_preferences', input)) as Record<string, unknown>

const briefJob = (deviceId: string) =>
  db.select().from(jobs).where(and(eq(jobs.kind, 'brief'), eq(jobs.deviceId, deviceId))).all()

const weeklyJob = (deviceId: string) =>
  db.select().from(jobs).where(and(eq(jobs.kind, 'weekly_review'), eq(jobs.deviceId, deviceId))).all()

describe('set_preferences returns the EFFECTIVE settings', () => {
  it('reports the server default for a device that has never configured quiet hours', async () => {
    // Otto confirms from what comes back, so "quiet hours are off" must only ever be said when they
    // are genuinely off — not when the column is merely unset and the server default applies.
    const device = makeDevice('dev_t1')
    expect(getSettings(device.deviceId).quietHours).toBeNull()
    expect(config.quietHoursDefault).toBe('22:00-07:00')

    const res = await setPrefs(device, {})

    expect(res.quietHours).toBe('22:00–07:00')
    expect(res.weeklyReview).toBe('Sun 18:00')
    expect(res.briefAt).toBe('07:00')
    expect(res.briefEnabled).toBe(true)
    expect(res.eveningBriefEnabled).toBe(false)
  })

  it('moves the brief and hands back the real new time', async () => {
    const device = makeDevice('dev_t2')

    const res = await setPrefs(device, { briefHour: 6, briefMinute: 30 })

    expect(res.briefAt).toBe('06:30')
    expect(res.nextBriefLocal).toBe('Mon, 3 Aug 2026, 06:30')
    expect(getSettings(device.deviceId).briefHour).toBe(6)
  })

  it('honours an explicit "off" rather than falling back to the default', async () => {
    // The fallback is keyed on the column being ABSENT. Storing NULL for "off" would silently
    // reinstate the server window and make quiet hours impossible to switch off at all.
    const device = makeDevice('dev_t3')

    const res = await setPrefs(device, { quietHours: 'off', weeklyReview: 'off' })

    expect(res.quietHours).toBe('off')
    expect(res.weeklyReview).toBe('off')
    expect(getSettings(device.deviceId).quietHours).toBe('off')
    expect(getSettings(device.deviceId).weeklyReviewAt).toBe('off')
  })

  it('writes windows, weekly slots and flags through', async () => {
    const device = makeDevice('dev_t4')

    const res = await setPrefs(device, {
      quietHours: '23:30-06:15',
      weeklyReview: 'fri:09:00',
      eveningBriefEnabled: true,
      eveningBriefHour: 20,
      eveningBriefMinute: 45,
      autoWakeAlarm: true,
      autoLeaveByAlarm: true,
    })

    expect(res.quietHours).toBe('23:30–06:15')
    expect(res.weeklyReview).toBe('Fri 09:00')
    expect(res.eveningBriefAt).toBe('20:45')
    expect(res.autoWakeAlarm).toBe(true)
    expect(res.autoLeaveByAlarm).toBe(true)
    // Normalised on the way in, so the column and the server default read the same.
    expect(getSettings(device.deviceId).weeklyReviewAt).toBe('FRI:09:00')
  })

  it('leaves untouched fields alone', async () => {
    const device = makeDevice('dev_t5')
    await setPrefs(device, { briefHour: 8, briefMinute: 15 })

    const res = await setPrefs(device, { autoWakeAlarm: true })

    expect(res.briefAt).toBe('08:15')
    expect(res.autoWakeAlarm).toBe(true)
  })
})

describe('validation', () => {
  it('rejects an out-of-range clock instead of writing it', async () => {
    const device = makeDevice('dev_t6')

    const res = await setPrefs(device, { briefHour: 25 })

    expect(res.error).toContain('briefHour')
    expect(getSettings(device.deviceId).briefHour).toBe(7)
  })

  it('rejects a value of the wrong type rather than coercing it', async () => {
    // The input is a bag of unknowns from a language model. `Number("half seven")` is NaN, and NaN
    // in a NOT NULL integer column is a failure at 07:00 the next morning on a path nobody watches.
    const device = makeDevice('dev_t7')

    expect((await setPrefs(device, { briefHour: 'half seven' })).error).toContain('briefHour')
    expect((await setPrefs(device, { briefEnabled: 'yes' })).error).toContain('briefEnabled')
    expect((await setPrefs(device, { quietHours: 22 })).error).toContain('quietHours')
    expect(getSettings(device.deviceId).briefHour).toBe(7)
    expect(getSettings(device.deviceId).briefEnabled).toBe(true)
  })

  it('rejects a garbled window or weekly slot, and says which', async () => {
    const device = makeDevice('dev_t8')

    expect((await setPrefs(device, { quietHours: 'ten-ish till whenever' })).error).toContain('quietHours')
    expect((await setPrefs(device, { weeklyReview: 'Sunday evening' })).error).toContain('weeklyReview')
    expect(getSettings(device.deviceId).quietHours).toBeNull()
    expect(getSettings(device.deviceId).weeklyReviewAt).toBeNull()
  })

  it('rejects the WHOLE patch when one field is bad', async () => {
    // Half-applying leaves the owner told about a change that only partly happened, and the half
    // that silently failed is the half they find out about at 04:00.
    const device = makeDevice('dev_t9')

    const res = await setPrefs(device, { briefHour: 6, quietHours: 'nonsense' })

    expect(res.error).toBeDefined()
    expect(getSettings(device.deviceId).briefHour).toBe(7)
  })

  it('refuses to put both briefs at the same minute, rather than confirming one that cannot fire', async () => {
    // slotForRunAt resolves a clash to morning by design, so an evening brief sharing the morning's
    // minute has no instant it can ever be read off. Accepting it would hand back
    // `eveningBriefEnabled: true` with a time — and the prompt tells Otto to confirm from exactly
    // those values, so he would promise a brief that can never arrive.
    const device = makeDevice('dev_t14')

    const res = await setPrefs(device, { eveningBriefEnabled: true, eveningBriefHour: 7, eveningBriefMinute: 0 })

    expect(res.error).toContain('07:00')
    expect(getSettings(device.deviceId).eveningBriefEnabled).toBe(false)
  })

  it('catches the clash from the other direction too, against the settings already on disk', async () => {
    // The check is on the MERGED state, not on the patch: moving the morning brief onto an evening
    // slot that was configured weeks ago is the same collision seen from the other side.
    const device = makeDevice('dev_t15')
    await setPrefs(device, { eveningBriefEnabled: true, eveningBriefHour: 21, eveningBriefMinute: 0 })

    const res = await setPrefs(device, { briefHour: 21, briefMinute: 0 })

    expect(res.error).toBeDefined()
    expect(getSettings(device.deviceId).briefHour).toBe(7)
  })

  it('allows the same minute when only one of the two slots is on', async () => {
    // Not a clash: with the morning off there is exactly one boundary at 21:00 and slotForRunAt
    // reads it as the evening one. Rejecting this would block a legitimate "just the evening one".
    const device = makeDevice('dev_t16')
    await setPrefs(device, { eveningBriefEnabled: true, eveningBriefHour: 21, eveningBriefMinute: 0 })

    const res = await setPrefs(device, { briefEnabled: false, briefHour: 21, briefMinute: 0 })

    expect(res.error).toBeUndefined()
    expect(res.eveningBriefAt).toBe('21:00')
    expect(res.briefEnabled).toBe(false)
  })

  it('reports every problem at once rather than one per round-trip', async () => {
    const device = makeDevice('dev_t10')

    const res = await setPrefs(device, { briefHour: 99, briefMinute: 99 })

    expect(res.error).toContain('briefHour')
    expect(res.error).toContain('briefMinute')
  })
})

describe('the brief chain follows the setting', () => {
  it('moves the pending job row immediately, not a day later', async () => {
    // ensureSingletonJob deliberately leaves an existing row alone, so without an explicit reschedule
    // "move my brief to 6:30" would do nothing tomorrow and only take effect the day after.
    const device = makeDevice('dev_t11')
    scheduleBriefChain(device, NOW)
    expect(briefJob(device.deviceId)).toHaveLength(1)
    expect(briefJob(device.deviceId)[0]!.runAtMillis).toBe(Date.UTC(2026, 7, 3, 7, 0, 0))

    await setPrefs(device, { briefHour: 6, briefMinute: 30 })

    const after = briefJob(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.runAtMillis).toBe(Date.UTC(2026, 7, 3, 6, 30, 0))
  })

  it('leaves the chain alone when nothing about the timing changed', async () => {
    const device = makeDevice('dev_t12')
    scheduleBriefChain(device, NOW)
    const before = briefJob(device.deviceId)[0]!

    await setPrefs(device, { autoWakeAlarm: true, quietHours: '22:00-08:00' })

    const after = briefJob(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(before.id)
    expect(after[0]!.runAtMillis).toBe(before.runAtMillis)
  })

  it('keeps exactly one row when the brief is switched off and back on', async () => {
    // Switching off must not delete the chain: the row IS the chain, and turning the brief back on
    // has no other path to re-create it.
    const device = makeDevice('dev_t13')
    updateSettings(device.deviceId, { eveningBriefEnabled: false })
    scheduleBriefChain(device, NOW)

    await setPrefs(device, { briefEnabled: false })
    expect(briefJob(device.deviceId)).toHaveLength(1)

    await setPrefs(device, { briefEnabled: true, briefHour: 9 })
    const after = briefJob(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.runAtMillis).toBe(Date.UTC(2026, 7, 3, 9, 0, 0))
  })
})

/**
 * The weekly review needed the same hook and never got one.
 *
 * `preferences.ts` is the file the brief branch and the accountability branch could not see each
 * other in: the brief added `rescheduleBriefChain` there for exactly this reason, and
 * `weeklyReviewAt` was left out of the change detection. Both directions were wrong, and both are
 * things Otto has already confirmed to the owner by the time they bite.
 */
describe('the weekly review chain follows the setting too', () => {
  it('drops the queued review the moment the owner switches it off', async () => {
    // Sunday 17:00: "drop the weekly thing". Otto is handed `weeklyReview: 'off'` and says so. The
    // pending row for 18:00 was untouched, and `seedWeeklyReview` — boot, or a gc pass up to six
    // hours out — was the only thing that would ever have cleared it.
    const device = makeDevice('dev_t14')
    seedWeeklyReview(device, NOW)
    expect(weeklyJob(device.deviceId)).toHaveLength(1)

    const res = await setPrefs(device, { weeklyReview: 'off' })

    expect(res.weeklyReview).toBe('off')
    expect(weeklyJob(device.deviceId)).toHaveLength(0)
  })

  it('moves the row to the new slot rather than firing on the old one first', async () => {
    // "Move it to Wednesday" on a Sunday afternoon still fired that same Sunday evening, and the
    // six-day cooldown then pushed the first Wednesday review out another ten days.
    const device = makeDevice('dev_t15')
    seedWeeklyReview(device, NOW)
    // Monday 3 August 2026 05:00 UTC ⇒ the default SUN:18:00 is Sunday the 9th.
    expect(weeklyJob(device.deviceId)[0]!.runAtMillis).toBe(Date.UTC(2026, 7, 9, 18, 0, 0))

    await setPrefs(device, { weeklyReview: 'WED:09:00' })

    const after = weeklyJob(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.runAtMillis).toBe(Date.UTC(2026, 7, 5, 9, 0, 0))
  })

  it('seeds a chain again when the owner turns reviews back on', async () => {
    // The other direction, and the quieter of the two: with the chain already gone, nothing seeded
    // a new one until the next gc pass. Land that pass after the slot and `nextWeeklyReviewAt` can
    // only offer the FOLLOWING week — Otto said "on, Sundays at 6" and nothing arrives for eight days.
    const device = makeDevice('dev_t16')
    await setPrefs(device, { weeklyReview: 'off' })
    expect(weeklyJob(device.deviceId)).toHaveLength(0)

    await setPrefs(device, { weeklyReview: 'SUN:18:00' })

    const after = weeklyJob(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.runAtMillis).toBe(Date.UTC(2026, 7, 9, 18, 0, 0))
  })

  it('leaves the chain alone when the slot did not change', async () => {
    const device = makeDevice('dev_t17')
    seedWeeklyReview(device, NOW)
    const before = weeklyJob(device.deviceId)[0]!

    await setPrefs(device, { briefHour: 8 })

    const after = weeklyJob(device.deviceId)
    expect(after).toHaveLength(1)
    expect(after[0]!.id).toBe(before.id)
  })
})

/**
 * Stating when you sleep, and what it moves.
 *
 * There was NO test anywhere exercising bedWindow/wakeWindow through set_preferences before this —
 * the brief auto-move had been shipped untested — so these cover the whole path, not just the part
 * that is new.
 */
describe('stating a routine moves everything that hangs off their morning', () => {
  it('settles the day start, the brief and the quiet window in one call', async () => {
    // The single sentence the owner actually types: "I'm up at noon and I go to bed around two."
    const device = makeDevice('dev_r1')
    scheduleBriefChain(device, Date.now())
    const before = briefJob(device.deviceId)[0]!

    const out = await setPrefs(device, { bedWindow: '01:00-02:00', wakeWindow: '11:00-12:00' })

    // The brief opens their day, so it lands at the START of the wake range. It used to take the
    // END — the same edge `dayStartHour` reads — and briefing someone at noon who said they are up
    // from eleven is two hours into a morning the brief was meant to start.
    expect(out.briefAt).toBe('11:00')
    // Quiet hours end on that same edge, so the brief is never inside its own window.
    expect(out.quietHours).toBe('02:00–11:00')
    expect(getSettings(device.deviceId).quietHours).toBe('02:00-11:00')
    // The day start — the hour Otto picks for ITSELF — still reads the end. Three anchors, and only
    // two of them share an edge.
    expect(out.dayStartsAt).toBe('12:00')
    // The pending job row held an instant computed from the OLD 07:00, and ensureSingletonJob
    // deliberately leaves an existing row alone — so without the reschedule this would silently do
    // nothing tomorrow and only take effect the day after.
    expect(briefJob(device.deviceId)[0]!.runAtMillis).not.toBe(before.runAtMillis)
  })

  it('re-derives the window when they change their hours again', async () => {
    // The naive "only when the column is null" gate breaks here: after the first call the column
    // holds a real string, so a second routine change would move the brief and leave quiet hours
    // anchored to the hours they no longer keep.
    const device = makeDevice('dev_r2')
    await setPrefs(device, { bedWindow: '01:00-02:00', wakeWindow: '11:00-12:00' })
    expect(getSettings(device.deviceId).quietHours).toBe('02:00-11:00')

    const out = await setPrefs(device, { wakeWindow: '09:00-10:00' })

    expect(out.quietHours).toBe('02:00–09:00')
    expect(out.briefAt).toBe('09:00')
  })

  it('never overwrites a window the owner typed themselves', async () => {
    // "Leave me alone until one" must survive every later change to their sleeping hours. The
    // stored value no longer matches what we would have derived, so we know we did not write it.
    const device = makeDevice('dev_r3')
    await setPrefs(device, { quietHours: '02:00-13:00' })

    const out = await setPrefs(device, { bedWindow: '01:00-02:00', wakeWindow: '11:00-12:00' })

    expect(out.quietHours).toBe('02:00–13:00')
    // The brief is at 13:00 rather than the 11:00 the routine implies, and that is the clamp doing
    // its job in the FIRST call, not the routine failing to move it in the second: a 07:00 brief
    // under an owner-typed 02:00-13:00 window would have expired six hours before the window lifted,
    // so it was moved to the first minute it could actually be delivered. Once moved for a concrete
    // reason it is no longer ours to move again.
    expect(out.briefAt).toBe('13:00')
  })

  it('leaves quiet hours off for good once they have been turned off', async () => {
    // Literal "off" can never equal a derivation, so this is permanent by construction rather than
    // by a special case — the same property quietHoursFor is careful to preserve at the other end.
    const device = makeDevice('dev_r4')
    await setPrefs(device, { quietHours: 'off' })

    const out = await setPrefs(device, { bedWindow: '01:00-02:00', wakeWindow: '11:00-12:00' })

    expect(out.quietHours).toBe('off')
  })

  it('lets a window stated in the same breath win', async () => {
    const device = makeDevice('dev_r5')
    const out = await setPrefs(device, {
      bedWindow: '01:00-02:00',
      wakeWindow: '11:00-12:00',
      quietHours: '03:00-11:00',
    })

    expect(out.quietHours).toBe('03:00–11:00')
  })

  it('lets a brief time stated in the same breath win, and still sets the window', async () => {
    const device = makeDevice('dev_r6')
    const out = await setPrefs(device, {
      bedWindow: '01:00-02:00',
      wakeWindow: '11:00-12:00',
      briefHour: 13,
      briefMinute: 30,
    })

    expect(out.briefAt).toBe('13:30')
    expect(out.quietHours).toBe('02:00–11:00')
  })

  it('derives nothing from a bed window on its own', async () => {
    // A bed window alone says nothing about when their day starts, which is the only thing anything
    // downstream reads out of a routine. This half stays all-or-nothing.
    const device = makeDevice('dev_r7')

    const out = await setPrefs(device, { bedWindow: '01:00-02:00' })

    expect(out.quietHours).toBe(config.quietHoursDefault.replace('-', '–'))
    expect(getSettings(device.deviceId).quietHours).toBeNull()
    expect(out.dayStartsAt).toBe('not set')
  })

  it('takes a wake window on its own, and silences nothing on the strength of it', async () => {
    // "I get up at 7" used to be write-only: stored, confirmed, and read by nothing, because
    // parseRoutine refused half a routine and the prompt line was then omitted entirely — so Otto
    // could not even recall having been told. The wake half is the half everything reads.
    const device = makeDevice('dev_r9')

    const out = await setPrefs(device, { wakeWindow: '06:45-07:00' })

    expect(out.dayStartsAt).toBe('07:00')
    expect(out.briefAt).toBe('06:45')
    // But no bedtime was given, so nothing is derived from one. The server default still applies.
    expect(out.quietHours).toBe(config.quietHoursDefault.replace('-', '–'))
    expect(getSettings(device.deviceId).quietHours).toBeNull()
  })

  it('derives nothing when the window would be degenerate', async () => {
    // bed.end === wake.start is ambiguous between a zero-length window and a 24-hour one, and nobody
    // means either — so no string is written rather than one every read site would reject.
    const device = makeDevice('dev_r8')

    const out = await setPrefs(device, { bedWindow: '01:00-02:00', wakeWindow: '02:00-04:00' })

    expect(getSettings(device.deviceId).quietHours).toBeNull()
    // The derived anchor would be 02:00, which sits deep inside the 22:00-07:00 server default and
    // would expire five hours before that window lifts — so it is clamped to the window's end. The
    // owner never named a brief time here, so their sentence is adapted rather than refused.
    expect(out.briefAt).toBe('07:00')
  })

  it('never moves a brief time the owner chose, however often they restate their hours', async () => {
    // The regression that prompted this whole branch, and the one six independent audit lanes found.
    // `routineChanged` was a PRESENCE test and `briefTimeStated` looked only at the current call, so
    // any later mention of their sleeping hours — including a bed window, which cannot move the
    // brief anchor at all — overwrote a time set days earlier and moved the pending job with it.
    const device = makeDevice('dev_r10')
    await setPrefs(device, { bedWindow: '01:00-02:00', wakeWindow: '11:00-12:00' })
    expect((await setPrefs(device, { briefHour: 13, briefMinute: 30 })).briefAt).toBe('13:30')

    // A bed-window-only change. `briefAnchorHour` reads the wake half, so the derived value has
    // not even moved — and the owner said nothing about the brief.
    expect((await setPrefs(device, { bedWindow: '02:00-03:00' })).briefAt).toBe('13:30')

    // A wake-window change, which DOES move the derived value. Still theirs, still stands.
    expect((await setPrefs(device, { wakeWindow: '09:00-10:00' })).briefAt).toBe('13:30')

    // And a verbatim re-save of both windows — which the tool description actively encourages.
    const out = await setPrefs(device, { bedWindow: '02:00-03:00', wakeWindow: '09:00-10:00' })
    expect(out.briefAt).toBe('13:30')
  })

  it('takes its derived quiet window back when the routine is turned off', async () => {
    // Both derivation blocks are gated on a routine EXISTING, so turning one off used to leave the
    // derived string behind with nothing that could ever remove it: the pin re-derives from the
    // STORED windows, and this same call erases them, so the machine's own guess became
    // indistinguishable from one the owner typed and survived forever.
    const device = makeDevice('dev_r11')
    await setPrefs(device, { bedWindow: '01:00-02:00', wakeWindow: '11:00-12:00' })
    expect(getSettings(device.deviceId).quietHours).toBe('02:00-11:00')

    const out = await setPrefs(device, { bedWindow: 'off', wakeWindow: 'off' })

    expect(getSettings(device.deviceId).quietHours).toBeNull()
    expect(out.quietHours).toBe(config.quietHoursDefault.replace('-', '–'))
    expect(out.dayStartsAt).toBe('not set')
  })

  it('refuses a setting it does not recognise instead of reporting success', async () => {
    // A misspelled or invented key used to be dropped in silence while the call still returned the
    // full settings object, so "stop messaging me after ten" saved as `quiet_hours` came back
    // looking exactly like a change that had landed. The owner finds out at ten.
    const device = makeDevice('dev_r13')

    const out = await setPrefs(device, { quiet_hours: '22:00-08:00' })

    expect(String(out.error)).toMatch(/unknown setting/)
    expect(String(out.error)).toMatch(/quiet_hours/)
    // All-or-nothing, like a bad value: nothing in the call is applied.
    expect(getSettings(device.deviceId).quietHours).toBeNull()
  })

  it('refuses a brief time that would expire inside quiet hours before it could be sent', async () => {
    // An evening brief at 23:00 under the 22:00-07:00 default waits eight hours against a
    // three-hour fuse — held, expired, and `lastEveningBriefAt` stamped so it never retries. It has
    // never once been delivered, and `effective()` kept reporting the time the owner asked for.
    const device = makeDevice('dev_r12')
    const out = await setPrefs(device, { eveningBriefEnabled: true, eveningBriefHour: 23 })
    expect(String(out.error)).toMatch(/expire before the window lifts/)

    // Half an hour inside the window is fine — it is held and then sent, not expired.
    const ok = await setPrefs(device, { briefHour: 6, briefMinute: 30 })
    expect(ok.briefAt).toBe('06:30')
  })
})
