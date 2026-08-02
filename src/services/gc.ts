import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { alarmEvents, facts, outbox, processedMessages, sessions } from '../db/schema.js'
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
