package com.otto.app.data

import com.otto.app.core.Clock
import com.otto.app.core.ReportTrigger
import com.otto.app.nudge.NudgeAction
import com.otto.app.nudge.NudgeLevel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The nudge outbox's invariants, in plain JVM via the [ReportTrigger] seam (no WorkManager, no
 * Room). Mirrors [AlarmRepositoryTest], including its use of a hand-written recording DAO rather
 * than a mocking library.
 */
class NudgeRepositoryTest {

    private class FakeClock(var now: Long = 10_000L) : Clock {
        override fun nowMillis(): Long = now
    }

    /**
     * Records writes. The `@Transaction` bundlers are interface default methods, so the fake
     * inherits them and their preserve-or-assign logic is exercised here for real — only Room's
     * transaction envelope is missing, and that is Room's contract to keep.
     */
    private class RecordingDao(private var existing: NudgeEntity? = null) : NudgeDao {
        val events = mutableListOf<DeviceEventEntity>()
        val upserts = mutableListOf<NudgeEntity>()
        var nextId = 42
        var liveUpdateAccepted = true

        override suspend fun upsert(nudge: NudgeEntity) {
            upserts += nudge
            existing = nudge
        }

        override suspend fun getById(nudgeId: String): NudgeEntity? = existing
        override suspend fun nextNotificationId(): Int = nextId
        override suspend fun insertEvent(event: DeviceEventEntity) { events += event }

        override suspend fun updateStateIfLive(nudgeId: String, state: NudgeState, updatedAtMillis: Long): Int =
            if (liveUpdateAccepted) 1 else 0

        override suspend fun snoozeIfLive(nudgeId: String, showAtMillis: Long, updatedAtMillis: Long): Int =
            if (liveUpdateAccepted) 1 else 0

        override suspend fun getLive(): List<NudgeEntity> = listOfNotNull(existing)
        override suspend fun getActive(): List<NudgeEntity> = listOfNotNull(existing)
        override fun observeLive(): Flow<List<NudgeEntity>> = throw UnsupportedOperationException()
        override suspend fun deleteTerminalBefore(cutoffMillis: Long) = Unit
        override suspend fun getPendingEvents(): List<DeviceEventEntity> = events.toList()
        override suspend fun deleteEvent(id: Long) = Unit
    }

    private fun repo(dao: NudgeDao, clock: Clock = FakeClock()) =
        NudgeRepository(dao, clock, ReportTrigger { })

    private suspend fun NudgeRepository.showTest(nudgeId: String = "rem_1", snoozeMinutes: Int = 30) =
        show(
            nudgeId = nudgeId,
            title = "Email Teal",
            body = "Still open",
            level = NudgeLevel.NORMAL,
            actions = listOf(NudgeAction.DONE, NudgeAction.SNOOZE),
            snoozeMinutes = snoozeMinutes,
            expiresAtMillis = null,
            ongoing = false,
        )

    @Test
    fun show_assignsANotificationIdAndEmitsExactlyOneShownEvent() = runTest {
        val dao = RecordingDao()
        val entity = repo(dao).showTest()

        assertEquals(42, entity.notificationId)
        assertEquals(1, dao.events.size)
        assertEquals(DeviceEvents.NUDGE_SHOWN, dao.events.single().event)
        assertEquals(DeviceEvents.KIND_NUDGE, dao.events.single().kind)
    }

    @Test
    fun show_preservesTheNotificationIdWhenReplacingAnExistingNudge() = runTest {
        // A chase ladder pushes the same id repeatedly. Renumbering on replace would orphan the
        // buttons on the notification the owner is already looking at.
        val dao = RecordingDao()
        val first = repo(dao).showTest()
        dao.nextId = 99
        val second = repo(dao).showTest()

        assertEquals(first.notificationId, second.notificationId)
        assertEquals(first.createdAtMillis, second.createdAtMillis)
    }

    @Test
    fun resolve_flipsStateAndEmitsItsEvent() = runTest {
        val dao = RecordingDao()
        val r = repo(dao)
        r.showTest()
        dao.events.clear()

        assertTrue(r.resolve("rem_1", NudgeState.RESOLVED, DeviceEvents.NUDGE_DONE))
        assertEquals(DeviceEvents.NUDGE_DONE, dao.events.single().event)
    }

    @Test
    fun resolve_onAnAlreadyTerminalNudgeIsANoOpThatEmitsNothing() = runTest {
        // The AF1 analogue, and the reason the guard is SQL-side. A "Done" tapped on a notification
        // the server cancelled minutes ago must not resurrect the nudge — and must not tell the
        // server the owner finished something they were never asked about. The lockscreen is
        // exactly where a stale notification lives longest.
        val dao = RecordingDao()
        val r = repo(dao)
        r.showTest()
        dao.events.clear()
        dao.liveUpdateAccepted = false

        assertFalse(r.resolve("rem_1", NudgeState.RESOLVED, DeviceEvents.NUDGE_DONE))
        assertTrue("a rejected transition must write no event", dao.events.isEmpty())
    }

    @Test
    fun snooze_recordsWhenTheOwnerAskedToSeeItAgain() = runTest {
        val dao = RecordingDao()
        val r = repo(dao)
        r.showTest()
        dao.events.clear()

        assertTrue(r.snooze("rem_1", 99_000L))
        val event = dao.events.single()
        assertEquals(DeviceEvents.NUDGE_SNOOZED, event.event)
        assertEquals(99_000L, event.untilMillis)
    }

    @Test
    fun snooze_onATerminalNudgeWritesNothing() = runTest {
        val dao = RecordingDao()
        val r = repo(dao)
        r.showTest()
        dao.events.clear()
        dao.liveUpdateAccepted = false

        assertFalse(r.snooze("rem_1", 99_000L))
        assertTrue(dao.events.isEmpty())
    }

    @Test
    fun pushRejections_bucketByTheHourSoAServerBugCannotFloodTheQueue() = runTest {
        // ReportWorker drains in order and stops at the first failure, so a flood here is a
        // blockage rather than merely noise. The unique index does the limiting; this pins that the
        // key it is given actually collapses.
        val clock = FakeClock(now = 0L)
        val dao = RecordingDao()
        val r = repo(dao, clock)

        r.recordPushRejection("LAUNCH_ROCKET", "unknown type")
        clock.now = 59 * 60_000L
        r.recordPushRejection("LAUNCH_ROCKET", "unknown type")
        val withinTheHour = dao.events.map { it.dedupeKey }.distinct()
        assertEquals("two rejections inside one hour share a key", 1, withinTheHour.size)

        clock.now = 61 * 60_000L
        r.recordPushRejection("LAUNCH_ROCKET", "unknown type")
        assertEquals("the next hour gets its own key", 2, dao.events.map { it.dedupeKey }.distinct().size)
    }

    @Test
    fun pushRejections_ofDifferentTypesAreCountedSeparately() = runTest {
        val dao = RecordingDao()
        val r = repo(dao)
        r.recordPushRejection("LAUNCH_ROCKET", "unknown type")
        r.recordPushRejection("?", "missing type")
        assertEquals(2, dao.events.map { it.dedupeKey }.distinct().size)
    }
}
