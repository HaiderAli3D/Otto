import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { alarmEvents, deviceLocations, facts, outbox, processedMessages, sessions, travelCalls } from '../db/schema.js'
import { log } from '../lib/log.js'
import { FACT_SOFT_CAP } from './facts.js'
import { PENDING_HARD_TTL_MS } from './outbox.js'

const DAY = 24 * 60 * 60 * 1000

const PROCESSED_MESSAGES_TTL = 7 * DAY
const OUTBOX_TERMINAL_TTL = 30 * DAY
const ALARM_EVENTS_TTL = 90 * DAY
const INFERRED_FACT_TTL = 90 * DAY
/** A conversation untouched for a month is over. See the note in the sweep about what this loses. */
const SESSIONS_TTL = 30 * DAY

/**
 * How long a location fix is kept before its COORDINATES are nulled out.
 *
 * Six hours, and this sweep nulls rather than deletes — deliberately, and the asymmetry is the
 * point. A fix has no value at all past the journey that requested it, so the private half expires
 * fast. The row itself stays, so "when did Otto last check where I was, and what for?" remains
 * answerable indefinitely. Accountability outlives the data it is about.
 */
const LOCATION_FIX_TTL = 6 * 60 * 60 * 1000

/** Billed-call counters older than this are for days nobody will ask about again. */
const TRAVEL_CALLS_TTL = 7 * DAY

/**
 * Housekeeping. Everything here grows forever otherwise, on a 1 GB Fly volume: Meta redelivery
 * ids, the alarm audit trail, retired outbox rows, abandoned transcripts, and low-confidence facts
 * nobody ever uses.
 */
export function collectGarbage(): void {
  const now = Date.now()
  try {
    const messages = db
      .delete(processedMessages)
      .where(lt(processedMessages.receivedAt, now - PROCESSED_MESSAGES_TTL))
      .run()

    const retiredOutbox = db
      .delete(outbox)
      .where(
        and(
          inArray(outbox.state, ['SENT', 'FAILED', 'SUPERSEDED', 'EXPIRED']),
          lt(outbox.createdAt, now - OUTBOX_TERMINAL_TTL),
        ),
      )
      .run()

    // Backstop for PENDING rows nothing will ever send — the window stayed shut for a week, or the
    // number was unlinked. EXPIRED rather than deleted, so the terminal sweep above removes them 30
    // days later and the audit trail survives in between. Without this they are immortal: every
    // other sweep here only looks at rows that already reached a terminal state.
    const strandedOutbox = db
      .update(outbox)
      .set({ state: 'EXPIRED' })
      .where(and(eq(outbox.state, 'PENDING'), lt(outbox.createdAt, now - PENDING_HARD_TTL_MS)))
      .run()

    const events = db.delete(alarmEvents).where(lt(alarmEvents.receivedAt, now - ALARM_EVENTS_TTL)).run()

    // Coordinates NULLED, row kept. A fix is worthless past the journey that asked for it, so the
    // private half expires in hours; the row survives so "when did Otto last check where I was?"
    // stays answerable. Deleting instead would take the accountability away with the data.
    const expiredFixes = db
      .update(deviceLocations)
      .set({ lat: null, lng: null, accuracyMeters: null })
      .where(lt(deviceLocations.receivedAtMillis, now - LOCATION_FIX_TTL))
      .run()

    const oldCallCounts = db
      .delete(travelCalls)
      .where(lt(travelCalls.dayKey, new Date(now - TRAVEL_CALLS_TTL).toISOString().slice(0, 10)))
      .run()

    // Sessions were never swept at all — an abandoned conversation kept its whole transcript (up to
    // MAX_SESSION_BYTES of it) forever. Safe to drop because durable knowledge lives in `facts` and
    // open work lives in `reminders`, both injected into the prompt from the database on every turn:
    // this forgets a month-old chat, not the owner.
    const staleSessions = db.delete(sessions).where(lt(sessions.updatedAt, now - SESSIONS_TTL)).run()

    // Only prune inferred, unpinned, long-unused facts, and only once a device is over the cap —
    // never silently forget something the owner explicitly said.
    let prunedFacts = 0
    const counts = db
      .select({ deviceId: facts.deviceId, n: sql<number>`COUNT(*)` })
      .from(facts)
      .groupBy(facts.deviceId)
      .all()
    for (const { deviceId, n } of counts) {
      if (n <= FACT_SOFT_CAP) continue
      const res = db
        .delete(facts)
        .where(
          and(
            eq(facts.deviceId, deviceId),
            eq(facts.confidence, 'inferred'),
            eq(facts.pinned, false),
            lt(facts.lastUsedAtMillis, now - INFERRED_FACT_TTL),
          ),
        )
        .run()
      prunedFacts += res.changes
    }

    log.info(
      {
        processedMessages: messages.changes,
        outbox: retiredOutbox.changes,
        outboxStranded: strandedOutbox.changes,
        alarmEvents: events.changes,
        sessions: staleSessions.changes,
        facts: prunedFacts,
      },
      'gc complete',
    )
  } catch (err) {
    log.warn({ err }, 'gc failed')
  }
}
