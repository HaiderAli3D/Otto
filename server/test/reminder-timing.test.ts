import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { eq } from 'drizzle-orm'
import { DateTime } from 'luxon'
import { db, ensureSchema } from '../src/db/client.js'
import { reminders } from '../src/db/schema.js'
import { DEFAULT_NAG_POLICY, tableFor } from '../src/lib/rungPlan.js'
import { dueJobs } from '../src/services/jobs.js'
import {
  completeReminder,
  createReminder,
  getReminder,
  leadCountFor,
  onReminderAlarmEvent,
  resolvedPlanFor,
  updateReminder,
} from '../src/services/reminders.js'
import { updateSettings } from '../src/services/settings.js'
import { makeDevice } from './helpers.js'

/**
 * Timing kinds and `update_reminder` at the service level — the half of the ladder work that only
 * shows up once a real row, a real job queue and a real rented alarm are involved.
 */

beforeEach(() => ensureSchema())

const inHours = (h: number): number => Date.now() + h * 3_600_000

describe('timing kinds', () => {
  it('defaults a DATED reminder to deadline, so the first word arrives before the time, not after', async () => {
    // The owner's complaint, pinned. `trigger` has no lead rungs at any intensity, so while it was
    // the default an unclassified "by four" said nothing at all until four had already gone — the
    // one moment at which a reminder to finish something is worthless.
    //
    // 48 hours out, like the explicit-deadline test below it, and for the same reason that file's
    // header warns about: the suite runs at whatever the wall clock says, and a run-up measured in
    // hours can be entirely inside the default 22:00-07:00 window, where every lead is pruned for
    // landing past its own deadline. Two days out always leaves one standing.
    const device = makeDevice('dev_t1')
    const due = inHours(48)
    const r = await createReminder(device, { title: 'call Teal', dueAtMillis: due })
    expect(r.timingKind).toBe('deadline')
    expect(leadCountFor(device, r)).toBeGreaterThan(0)
    expect(r.nextNagAtMillis).toBeLessThan(due)
  })

  it('files an UNDATED reminder as a deadline waiting for a time', async () => {
    // The kind is inert while there is no due time — nothing to lead, nothing to be late for — so
    // this is about what happens the DAY IT GETS ONE. "Sort the loft out, actually by Sunday" should
    // start warning through the run-up, not go silent until Sunday has been and gone.
    const device = makeDevice('dev_t1b')
    const r = await createReminder(device, { title: 'sort the loft out' })
    expect(r.timingKind).toBe('deadline')
    expect(r.dueAtMillis).toBeNull()
  })

  it('keeps trigger exactly as it was when it is asked for by name', async () => {
    // "remind me AT four" is still one word away, and still says nothing beforehand. The default
    // moved; the kind did not.
    const device = makeDevice('dev_t1c')
    const due = inHours(4)
    const r = await createReminder(device, { title: 'call Teal', dueAtMillis: due, timing: 'trigger' })
    expect(r.timingKind).toBe('trigger')
    // Rung 0 IS the due instant: a trigger says nothing beforehand.
    expect(r.nextNagAtMillis).toBe(due)
    expect(leadCountFor(device, r)).toBe(0)
  })

  it('starts a deadline in its run-up rather than at the deadline', async () => {
    const device = makeDevice('dev_t2')
    const due = inHours(48)
    const r = await createReminder(device, { title: 'file the tax return', dueAtMillis: due, timing: 'deadline' })
    expect(r.timingKind).toBe('deadline')
    expect(r.nextNagAtMillis).toBeLessThan(due)
    expect(leadCountFor(device, r)).toBeGreaterThan(0)
  })

  it('warns before an appointment and stops chasing shortly after it', async () => {
    // Quiet hours off explicitly. The suite runs at whatever the wall clock happens to be, and the
    // default 22:00–07:00 window covers a third of the day — without this the lead rungs of a
    // 6-hour-out appointment are legitimately dropped (see the next test) and this one would fail
    // for a third of every day while testing nothing about timing kinds.
    const device = makeDevice('dev_t3')
    updateSettings(device.deviceId, { quietHours: 'off' })
    const due = inHours(6)
    const r = await createReminder(device, { title: 'the dentist', dueAtMillis: due, timing: 'appointment' })
    expect(r.nextNagAtMillis).toBeLessThan(due)
    // An appointment an hour gone is the past; a daily tail there is what `deadline` is for.
    expect(resolvedPlanFor(device, r)!.tail).toBe('stop')
  })

  it('drops a warning that quiet hours would push past the thing it warns about', async () => {
    // "Heads up, the dentist is in two hours" arriving four hours AFTER the dentist is worse than
    // no warning at all: it reads as a mistake and teaches the owner that the warnings are noise.
    // So the rung is dropped at plan time rather than delivered late.
    const device = makeDevice('dev_t8')
    const now = Date.now()
    // A window that certainly swallows every lead rung of an appointment two hours out.
    const start = DateTime.fromMillis(now, { zone: 'UTC' }).minus({ hours: 1 })
    const end = DateTime.fromMillis(now, { zone: 'UTC' }).plus({ hours: 6 })
    updateSettings(device.deviceId, { quietHours: `${start.toFormat('HH:mm')}-${end.toFormat('HH:mm')}` })

    const due = inHours(2)
    const r = await createReminder(device, { title: 'the dentist', dueAtMillis: due, timing: 'appointment' })

    expect(leadCountFor(device, r)).toBe(0)
    // Rung 0 is then the due instant itself — which the owner chose, so it still stands.
    expect(r.nextNagAtMillis).toBe(due)
  })

  it('gives a deadline set minutes beforehand no run-up at all, starting at the due instant', async () => {
    const device = makeDevice('dev_t4')
    const due = Date.now() + 5 * 60_000
    const r = await createReminder(device, { title: 'move the car', dueAtMillis: due, timing: 'deadline' })
    expect(leadCountFor(device, r)).toBe(0)
    expect(r.nextNagAtMillis).toBe(due)
  })

  it('defaults to hard — the owner asked to be warned several times, not twice', async () => {
    const device = makeDevice('dev_t5')
    const r = await createReminder(device, { title: 'x', dueAtMillis: inHours(1) })
    expect(r.nagPolicy).toBe('hard')
    // Pinned to the constant as well as to the literal: the literal is what the owner asked for,
    // and the constant is what stops the code and the prompt drifting apart about it.
    expect(r.nagPolicy).toBe(DEFAULT_NAG_POLICY)
  })

  it('re-anchors a recurring deadline so the new occurrence gets real warnings', async () => {
    // The plannedAtMillis-vs-createdAt bug: a recurrence rewrites dueAtMillis while createdAt stays
    // where it was, so pruning the new lead rungs against createdAt would leave every one of them
    // in the plan AND in the past — and the ladder would go silent until the due instant.
    const device = makeDevice('dev_t6')
    const r = await createReminder(device, {
      title: 'weekly report',
      dueAtMillis: inHours(2),
      timing: 'deadline',
      recurrence: 'FREQ=WEEKLY',
    })
    const res = await completeReminder(device, r.reminderId)
    expect(res.rolledTo).toBeDefined()

    const rolled = getReminder(r.reminderId)!
    expect(rolled.state).toBe('OPEN')
    expect(rolled.plannedAtMillis).toBeGreaterThanOrEqual(r.plannedAtMillis!)
    expect(leadCountFor(device, rolled)).toBeGreaterThan(0)
    // Every rung of the new occurrence is ahead of us, not stranded behind the roll-forward.
    expect(rolled.nextNagAtMillis).toBeGreaterThan(Date.now())
    expect(rolled.nextNagAtMillis).toBeLessThan(res.rolledTo!)
  })

  it('resumes a rented alarm at a rung ahead of us, not back in the run-up', async () => {
    // The ring IS the rung that lands on the due instant. Sending a deadline whose warnings already
    // went out back to warning number two would read as Otto losing its place.
    const device = makeDevice('dev_t7')
    const r = await createReminder(device, {
      title: 'submit the form',
      dueAtMillis: inHours(30),
      timing: 'deadline',
      ring: true,
    })
    expect(leadCountFor(device, r)).toBeGreaterThan(0)

    onReminderAlarmEvent(r.alarmId!, 'DISMISSED', device)
    const after = getReminder(r.reminderId)!
    expect(after.nextNagAtMillis).toBeGreaterThan(Date.now())
  })
})

describe('updateReminder', () => {
  it('changes the policy and re-plans, moving the pending job with it', async () => {
    // Without the cancel-and-requeue the row carries the new instant while the job row still holds
    // the old one, and the reminder fires on a schedule nothing in the database describes.
    const device = makeDevice('dev_u1')
    const r = await createReminder(device, { title: 'the bins', dueAtMillis: inHours(3), nagPolicy: 'gentle' })

    const res = await updateReminder(device, r.reminderId, { nagPolicy: 'relentless' })
    expect(res.ok).toBe(true)
    const after = getReminder(r.reminderId)!
    expect(after.nagPolicy).toBe('relentless')

    const queued = dueJobs(inHours(72)).filter((j) => j.kind === 'nudge' && j.reminderId === r.reminderId)
    expect(queued).toHaveLength(1)
    expect(queued[0]!.runAtMillis).toBe(after.nextNagAtMillis)
  })

  it('counts pushing the due time LATER as a deferral, so the record stays honest', async () => {
    // Otherwise this becomes the snooze-laundering path: moving a due time is indistinguishable
    // from snoozing in effect, and the one counter caused purely by the owner's own choices would
    // quietly read zero for someone who had dodged a task six times.
    const device = makeDevice('dev_u2')
    const r = await createReminder(device, { title: 'the gym', dueAtMillis: inHours(2) })
    const res = await updateReminder(device, r.reminderId, { dueAtMillis: inHours(6) })
    expect(res.ok && res.deferred).toBe(true)
    expect(getReminder(r.reminderId)!.deferCount).toBe(1)
  })

  it('does not count pulling the due time EARLIER', async () => {
    const device = makeDevice('dev_u3')
    const r = await createReminder(device, { title: 'the gym', dueAtMillis: inHours(6) })
    const res = await updateReminder(device, r.reminderId, { dueAtMillis: inHours(2) })
    expect(res.ok && res.deferred).toBe(false)
    expect(getReminder(r.reminderId)!.deferCount).toBe(0)
  })

  it('switches a trigger into a deadline and grows a run-up', async () => {
    const device = makeDevice('dev_u4')
    // Explicitly a trigger: this test is about the SWITCH, and a dated reminder now defaults to
    // deadline, which would start it with the run-up it is meant to be growing.
    const r = await createReminder(device, { title: 'the essay', dueAtMillis: inHours(48), timing: 'trigger' })
    expect(leadCountFor(device, r)).toBe(0)

    await updateReminder(device, r.reminderId, { timing: 'deadline', resetChase: true })
    const after = getReminder(r.reminderId)!
    expect(leadCountFor(device, after)).toBeGreaterThan(0)
    expect(after.nextNagAtMillis).toBeLessThan(after.dueAtMillis!)
  })

  it('never silently ends a ladder, even when the new one is shorter than the old', async () => {
    // nagCount indexes into the ladder, so dropping a reminder chased fifteen times down to
    // `gentle` leaves the index past the end of the table and nextNagAt correctly returns null —
    // the reminder would stop being chased at the exact moment the owner was fiddling with how it
    // gets chased. Ending a ladder is what cancel_reminder and nagPolicy 'off' are for.
    const device = makeDevice('dev_u5')
    const r = await createReminder(device, { title: 'the thing', dueAtMillis: inHours(1), nagPolicy: 'relentless' })
    db.update(reminders).set({ nagCount: 15 }).where(eq(reminders.reminderId, r.reminderId)).run()

    const res = await updateReminder(device, r.reminderId, { nagPolicy: 'gentle' })
    expect(res.ok).toBe(true)
    expect(getReminder(r.reminderId)!.nextNagAtMillis).not.toBeNull()
  })

  it('honours nagPolicy off as a genuine stop', async () => {
    const device = makeDevice('dev_u6')
    const r = await createReminder(device, { title: 'the thing', dueAtMillis: inHours(1) })
    await updateReminder(device, r.reminderId, { nagPolicy: 'off' })
    expect(getReminder(r.reminderId)!.nextNagAtMillis).toBeNull()
  })

  it('refuses to touch a reminder that is already done', async () => {
    const device = makeDevice('dev_u7')
    const r = await createReminder(device, { title: 'the thing', dueAtMillis: inHours(1) })
    await completeReminder(device, r.reminderId)
    const res = await updateReminder(device, r.reminderId, { nagPolicy: 'hard' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/DONE/)
  })

  it('applies an explicit lead schedule and drops back to the table on request', async () => {
    // Ten days of run-up so every table lead rung survives the prune — at 48 hours the 3-day
    // warning is already behind us and correctly dropped, which would make the count below a
    // statement about the clock rather than about clearing the plan.
    const device = makeDevice('dev_u8')
    // Pinned to midday local rather than `inHours(24 * 10)`, which inherited the wall clock's time
    // of day and made this test true only during waking hours. The 60-minute lead landed at
    // due−1h, so whenever the suite ran between roughly 23:00 and 08:00 that instant fell inside
    // the default 22:00–07:00 quiet window, was deferred past the due time and correctly dropped —
    // giving 1 lead instead of 2. The table assertion below had the same latent fault: at 05:00 the
    // 4h, 1h and 20min rungs all deferred past due too. Production was right both times.
    //
    // Midday is the safe anchor because quiet hours defer FORWARD to 07:00: any rung pushed out of
    // the window still lands before a midday due time, so nothing is dropped for the wrong reason.
    const due = DateTime.now()
      .setZone(device.timezone)
      .plus({ days: 10 })
      .set({ hour: 12, minute: 0, second: 0, millisecond: 0 })
      .toMillis()
    const r = await createReminder(device, { title: 'the form', dueAtMillis: due, timing: 'deadline' })
    await updateReminder(device, r.reminderId, { nagPlan: { leadMinutes: [1440, 60] } })
    expect(leadCountFor(device, getReminder(r.reminderId)!)).toBe(2)

    await updateReminder(device, r.reminderId, { nagPlan: null })
    expect(getReminder(r.reminderId)!.nagPlan).toBeNull()
    expect(leadCountFor(device, getReminder(r.reminderId)!)).toBe(tableFor('deadline', DEFAULT_NAG_POLICY).lead.length)
  })
})
