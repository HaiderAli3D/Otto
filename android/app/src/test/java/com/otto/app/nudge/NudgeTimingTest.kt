package com.otto.app.nudge

import com.otto.app.nudge.NudgeTiming.ShowDecision
import org.junit.Assert.assertEquals
import org.junit.Test

/** Pure timing for a nudge — the sibling of AlarmTimingTest, and deliberately just as boring. */
class NudgeTimingTest {

    private val now = 1_800_000_000_000L

    @Test
    fun `a nudge whose time has come shows now`() {
        assertEquals(ShowDecision.SHOW_NOW, NudgeTiming.classify(now, null, now))
        assertEquals(ShowDecision.SHOW_NOW, NudgeTiming.classify(now - 60_000, null, now))
    }

    @Test
    fun `a nudge still in the future is scheduled`() {
        assertEquals(ShowDecision.SCHEDULE, NudgeTiming.classify(now + 60_000, null, now))
    }

    @Test
    fun `expiry beats everything, including a nudge that is otherwise due`() {
        // Posting a nudge four hours after its window closed is the phone-side twin of firing a
        // stale backlog on boot: the worst failure mode of a queue is delivering all of it at once
        // when the machine comes back.
        assertEquals(ShowDecision.EXPIRED, NudgeTiming.classify(now - 60_000, now - 1, now))
        assertEquals(ShowDecision.EXPIRED, NudgeTiming.classify(now + 60_000, now - 1, now))
    }

    @Test
    fun `expiry exactly now counts as expired`() {
        assertEquals(ShowDecision.EXPIRED, NudgeTiming.classify(now, now, now))
    }

    @Test
    fun `a nudge with no expiry never expires`() {
        assertEquals(ShowDecision.SHOW_NOW, NudgeTiming.classify(now - 86_400_000, null, now))
    }

    @Test
    fun `snooze uses the server's minutes`() {
        assertEquals(now + 30 * 60_000L, NudgeTiming.snoozeUntil(now, 30))
    }

    @Test
    fun `a zero or negative snooze is clamped, not obeyed`() {
        // It arrives as a string in an FCM payload. A zero would re-post the notification in the
        // same instant the owner dismissed it — a loop they cannot break from the lockscreen.
        assertEquals(now + NudgeTiming.MIN_SNOOZE_MINUTES * 60_000L, NudgeTiming.snoozeUntil(now, 0))
        assertEquals(now + NudgeTiming.MIN_SNOOZE_MINUTES * 60_000L, NudgeTiming.snoozeUntil(now, -99))
    }

    @Test
    fun `an absurd snooze is clamped to a day`() {
        assertEquals(now + NudgeTiming.MAX_SNOOZE_MINUTES * 60_000L, NudgeTiming.snoozeUntil(now, 999_999))
    }
}
