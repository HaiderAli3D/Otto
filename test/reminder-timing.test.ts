import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/fcm/sender.js', () => ({
  sendData: vi.fn(async () => ({ ok: true as const })),
}))

import { eq } from 'drizzle-orm'
import { db, ensureSchema } from '../src/db/client.js'
import { reminders } from '../src/db/schema.js'
import { tableFor } from '../src/lib/rungPlan.js'
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
import { makeDevice } from './helpers.js'

/**
 * Timing kinds and `update_reminder` at the service level — the half of the ladder work that only
 * shows up once a real row, a real job queue and a real rented alarm are involved.
 */

beforeEach(() => ensureSchema())

const inHours = (h: number): number => Date.now() + h * 3_600_000

describe('timing kinds', () => {
  it('defaults to trigger, which is what keeps every pre-timing reminder on its old ladder', async () => {
    const device = makeDevice('dev_t1')
    const due = inHours(4)
    const r = await createReminder(device, { title: 'call Teal', dueAtMillis: due })
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
    const device = makeDevice('dev_t3')
    const due = inHours(6)
    const r = await createReminder(device, { title: 'the dentist', dueAtMillis: due, timing: 'appointment' })
    expect(r.nextNagAtMillis).toBeLessThan(due)
    // An appointment an hour gone is the past; a daily tail there is what `deadline` is for.
    expect(resolvedPlanFor(device, r)!.tail).toBe('stop')
  })

  it('gives a deadline set minutes beforehand no run-up at all, starting at the due instant', async () => {
    const device = makeDevice('dev_t4')
    const due = Date.now() + 5 * 60_000
    const r = await createReminder(device, { title: 'move the car', dueAtMillis: due, timing: 'deadline' })
    expect(leadCountFor(device, r)).toBe(0)
    expect(r.nextNagAtMillis).toBe(due)
  })

  it('defaults to persistent rather than gentle — the owner asked to be chased properly', async () => {
    const device = makeDevice('dev_t5')
    const r = await createReminder(device, { title: 'x', dueAtMillis: inHours(1) })
    expect(r.nagPolicy).toBe('persistent')
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
    const r = await createReminder(device, { title: 'the essay', dueAtMillis: inHours(48) })
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
    const r = await createReminder(device, { title: 'the form', dueAtMillis: inHours(24 * 10), timing: 'deadline' })
    await updateReminder(device, r.reminderId, { nagPlan: { leadMinutes: [1440, 60] } })
    expect(leadCountFor(device, getReminder(r.reminderId)!)).toBe(2)

    await updateReminder(device, r.reminderId, { nagPlan: null })
    expect(getReminder(r.reminderId)!.nagPlan).toBeNull()
    expect(leadCountFor(device, getReminder(r.reminderId)!)).toBe(tableFor('deadline', 'persistent').lead.length)
  })
})
