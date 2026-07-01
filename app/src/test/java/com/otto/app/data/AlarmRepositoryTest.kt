package com.otto.app.data

import com.otto.app.core.Clock
import com.otto.app.core.ReportTrigger
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
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

    /** Records the order of event inserts and upserts; snooze only touches getById/insertEvent/upsert. */
    private class RecordingDao(private val existing: AlarmEntity?) : AlarmDao {
        val events = mutableListOf<AlarmEventEntity>()
        val upserts = mutableListOf<AlarmEntity>()

        override suspend fun upsert(alarm: AlarmEntity) { upserts += alarm }
        override suspend fun getById(alarmId: String): AlarmEntity? = existing
        override suspend fun insertEvent(event: AlarmEventEntity) { events += event }

        override fun observeAll(): Flow<List<AlarmEntity>> = throw NotImplementedError()
        override suspend fun getByState(state: AlarmState): List<AlarmEntity> = throw NotImplementedError()
        override suspend fun getNextInState(state: AlarmState, nowMillis: Long): AlarmEntity? =
            throw NotImplementedError()
        override suspend fun updateState(alarmId: String, state: AlarmState, updatedAtMillis: Long): Int =
            throw NotImplementedError()
        override suspend fun deleteById(alarmId: String) = throw NotImplementedError()
        override suspend fun nextRequestCode(): Int = throw NotImplementedError()
        override suspend fun getPendingEvents(): List<AlarmEventEntity> = throw NotImplementedError()
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
    fun snooze_unknownAlarm_returnsNullAndEmitsNothing() = runTest {
        val dao = RecordingDao(existing = null)
        val repo = AlarmRepository(dao, FakeClock(), ReportTrigger {})

        val result = repo.snooze("missing", newTriggerAtMillis = 1L)

        assertNull(result)
        assertTrue(dao.events.isEmpty())
    }
}
