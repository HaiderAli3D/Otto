package com.otto.app.nudge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Whether a replacement notification is allowed to make a sound.
 *
 * Every rung of a chase re-posts onto the same notification id — that is what makes a ladder usable
 * rather than six notifications to clear — and Android suppresses sound and vibration for an update
 * to a notification that is still showing. `setOnlyAlertOnce(true)` was hardcoded, so it suppressed
 * them for EVERY rung after the first: Otto escalated six or seven times through a day, the phone
 * buzzed once at the earliest and least urgent rung, and the server logged seven deliveries.
 *
 * The decision lives in [NudgeTiming] precisely so it can be tested here. `NudgeNotifications`
 * touches `NotificationCompat` and cannot run on the JVM at all — there is no Robolectric in this
 * build — so it stays a dumb applier of this boolean.
 */
class NudgeReAlertTest {

    @Test
    fun `the first time anyone sees it, it makes a sound`() {
        assertTrue(NudgeTiming.shouldReAlert(null, null, "Still need to call the dentist?", "NORMAL"))
    }

    @Test
    fun `a rung that says something new makes a sound`() {
        assertTrue(
            NudgeTiming.shouldReAlert(
                previousBody = "Call the dentist.",
                previousLevel = "NORMAL",
                body = "Still need to call the dentist? Say done when it's sorted.",
                level = "NORMAL",
            ),
        )
    }

    @Test
    fun `an escalation makes a sound even when the words are identical`() {
        assertTrue(
            NudgeTiming.shouldReAlert(
                previousBody = "Call the dentist.",
                previousLevel = "NORMAL",
                body = "Call the dentist.",
                level = "URGENT",
            ),
        )
    }

    @Test
    fun `re-posting the same words at the same level stays silent`() {
        // A boot restore, or the summary being refreshed underneath them. They have read this.
        assertFalse(
            NudgeTiming.shouldReAlert(
                previousBody = "Call the dentist.",
                previousLevel = "NORMAL",
                body = "Call the dentist.",
                level = "NORMAL",
            ),
        )
    }

    @Test
    fun `a level that goes DOWN does not re-alert`() {
        // Only an escalation is worth interrupting for a second time. Going quieter is not.
        val loud = NudgeLevel.entries.last().name
        val quiet = NudgeLevel.entries.first().name
        assertFalse(NudgeTiming.shouldReAlert("same words", loud, "same words", quiet))
    }
}
