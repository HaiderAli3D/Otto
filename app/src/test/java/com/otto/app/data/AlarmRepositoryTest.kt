package com.otto.app.data

import com.otto.app.core.Clock
import com.otto.app.core.ReportTrigger
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the fix #2 invariant that a current-state reporting model cannot satisfy: a snooze emits
 * a SNOOZED outbox event *before* the re-ARM overwrites the row, so the server always learns of
 * the snooze. Runs in plain JVM thanks to the [ReportTrigger] seam (no WorkManager/Room).
 */
class AlarmRepositoryTest {

    private class FakeClock(var now: Long = 10_000L) : Clock {
        override fun nowMillis(): Long = now
    }

    /**
     * Records event inserts and upserts. upsertPreservingIdentity is deliberately NOT overridden:
     * the inherited default body runs against this fake, so its preserve-or-assign logic is
     * exercised here in plain JVM (the @Transaction envelope itself is Room's contract).
     */
    private class RecordingDao(private val existing: AlarmEntity?) : AlarmDao {
        val events = mutableListOf<AlarmEventEntity>()
        val upserts = mutableListOf<AlarmEntity>()
        var nextCode = 42

        override suspend fun upsert(alarm: AlarmEntity) { upserts += alarm }
        override suspend fun getById(alarmId: String): AlarmEntity? = existing
        override suspend fun insertEvent(event: AlarmEventEntity) { events += event }
        override suspend fun nextRequestCode(): Int = nextCode

        // The @Transaction bundlers (updateStateWithEvent, upsertArmedWithEvent, snoozeWithEvents,
        // dismissIfRingingWithEvent) are interface default methods, so the fake inherits them and
        // they delegate to these recorded primitives — ordering assertions still hold (AF6).
        // dismissIfRinging honours the RANG guard against the fixed `existing` row (AF1).
        override suspend fun dismissIfRinging(alarmId: String, updatedAtMillis: Long): Int =
            if (existing?.state == AlarmState.RANG) 1 else 0

        override fun observeAll(): Flow<List<AlarmEntity>> = throw NotImplementedError()
        override suspend fun getByState(state: AlarmState): List<AlarmEntity> = throw NotImplementedError()
        override suspend fun getAll(): List<AlarmEntity> = throw NotImplementedError()
        override suspend fun getNextInState(state: AlarmState, nowMillis: Long): AlarmEntity? =
            throw NotImplementedError()
        override suspend fun updateState(alarmId: String, state: AlarmState, updatedAtMillis: Long): Int =
            throw NotImplementedError()
        override suspend fun deleteById(alarmId: String) = throw NotImplementedError()
        override suspend fun getPendingEvents(): List<AlarmEventEntity> = throw NotImplementedError()
        override suspend fun getPendingEventAlarmIds(): List<String> = throw NotImplementedError()
        override suspend fun deleteEvent(id: Long) = throw NotImplementedError()
    }

    private fun ringing(id: String) = AlarmEntity(
        alarmId = id,
        triggerAtMillis = 5_000L,
        label = "L",
        state = AlarmState.RANG,
        createdAtMillis = 0L,
        updatedAtMillis = 0L,
        requestCode = 7,
    )

    @Test
    fun snooze_emitsSnoozedStrictlyBeforeReArm() = runTest {
        val dao = RecordingDao(ringing("a"))
        val repo = AlarmRepository(dao, FakeClock(now = 20_000L), ReportTrigger {})

        val updated = repo.snooze("a", newTriggerAtMillis = 20_000L + 540_000L)

        // The whole point of fix #2: SNOOZED is recorded before the re-ARM overwrites the row.
        assertEquals(listOf("SNOOZED", "ARMED"), dao.events.map { it.event })
        assertTrue("both events stamped at the same now", dao.events.all { it.atMillis == 20_000L })
        // Re-armed with snoozeCount bumped and the stable requestCode preserved.
        assertEquals(AlarmState.ARMED, updated!!.state)
        assertEquals(1, updated.snoozeCount)
        assertEquals(7, updated.requestCode)
    }

    @Test
    fun upsertArmed_newAlarm_assignsNextRequestCode() = runTest {
        val dao = RecordingDao(existing = null)
        val repo = AlarmRepository(dao, FakeClock(now = 20_000L), ReportTrigger {})

        val entity = repo.upsertArmed("new", triggerAtMillis = 99_000L, label = "L", allowWhileIdle = true)

        assertEquals(42, entity.requestCode)
        assertEquals(AlarmState.ARMED, entity.state)
        assertEquals(20_000L, entity.createdAtMillis)
        // The row persisted is exactly the row returned (the caller arms the OS with it).
        assertEquals(entity, dao.upserts.single())
        assertEquals(listOf("ARMED"), dao.events.map { it.event })
    }

    @Test
    fun upsertArmed_existingAlarm_preservesIdentityFields() = runTest {
        val existing = ringing("a").copy(state = AlarmState.ARMED, snoozeCount = 3, createdAtMillis = 1_000L)
        val dao = RecordingDao(existing)
        val repo = AlarmRepository(dao, FakeClock(now = 20_000L), ReportTrigger {})

        val updated = repo.upsertArmed("a", triggerAtMillis = 50_000L, label = "New", allowWhileIdle = false)

        // Identity fields survive the re-arm (fix #4): requestCode 7 from the existing row, not
        // the counter's 42; createdAt/snoozeCount kept; time and label refreshed.
        assertEquals(7, updated.requestCode)
        assertEquals(1_000L, updated.createdAtMillis)
        assertEquals(3, updated.snoozeCount)
        assertEquals(50_000L, updated.triggerAtMillis)
        assertEquals("New", updated.label)
        assertEquals(20_000L, updated.updatedAtMillis)
    }

    @Test
    fun snooze_unknownAlarm_returnsNullAndEmitsNothing() = runTest {
        val dao = RecordingDao(existing = null)
        val repo = AlarmRepository(dao, FakeClock(), ReportTrigger {})

        val result = repo.snooze("missing", newTriggerAtMillis = 1L)

        assertNull(result)
        assertTrue(dao.events.isEmpty())
    }

    @Test
    fun snooze_nonRingingAlarm_returnsNullAndEmitsNothing() = runTest {
        // AF1: a snooze from a stale ring screen must not resurrect an alarm the agent has since
        // re-armed (ARMED) or cancelled — only a still-RANG alarm may snooze.
        val armed = ringing("a").copy(state = AlarmState.ARMED)
        val dao = RecordingDao(armed)
        val repo = AlarmRepository(dao, FakeClock(now = 20_000L), ReportTrigger {})

        val result = repo.snooze("a", newTriggerAtMillis = 999_000L)

        assertNull(result)
        assertTrue(dao.events.isEmpty())
        assertTrue(dao.upserts.isEmpty())
    }

    @Test
    fun markDismissedIfRinging_nonRingingAlarm_noOpsAndEmitsNothing() = runTest {
        // AF1: dismissing a re-armed/cancelled alarm from a stale ring screen is a no-op.
        val armed = ringing("a").copy(state = AlarmState.ARMED)
        val dao = RecordingDao(armed)
        val repo = AlarmRepository(dao, FakeClock(now = 20_000L), ReportTrigger {})

        val changed = repo.markDismissedIfRinging("a")

        assertFalse(changed)
        assertTrue(dao.events.isEmpty())
    }

    @Test
    fun markDismissedIfRinging_ringingAlarm_dismissesAndEmitsDismissed() = runTest {
        val dao = RecordingDao(ringing("a"))
        val repo = AlarmRepository(dao, FakeClock(now = 20_000L), ReportTrigger {})

        val changed = repo.markDismissedIfRinging("a")

        assertTrue(changed)
        assertEquals(listOf("DISMISSED"), dao.events.map { it.event })
        assertEquals(20_000L, dao.events.single().atMillis)
    }
}
