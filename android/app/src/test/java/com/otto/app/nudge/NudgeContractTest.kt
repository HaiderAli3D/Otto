package com.otto.app.nudge

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The wire contract for a nudge, in isolation from Android.
 *
 * Everything here is about degrading rather than dropping. A nudge exists because the server
 * decided the owner should hear about something; a payload this build only half understands should
 * still reach them, because the alternative is a send the server logs as successful and the owner
 * never sees.
 */
class NudgeContractTest {

    @Test
    fun `known level tokens parse, whatever the casing`() {
        assertEquals(NudgeLevel.SILENT, NudgeLevel.fromToken("SILENT"))
        assertEquals(NudgeLevel.NORMAL, NudgeLevel.fromToken("normal"))
        assertEquals(NudgeLevel.URGENT, NudgeLevel.fromToken(" Urgent "))
    }

    @Test
    fun `an unknown level degrades to NORMAL rather than dropping the nudge`() {
        // A CRITICAL from a server newer than this build must still arrive. Dropping would make the
        // schema drift invisible on both sides.
        assertEquals(NudgeLevel.NORMAL, NudgeLevel.fromToken("CRITICAL"))
        assertEquals(NudgeLevel.NORMAL, NudgeLevel.fromToken(""))
        assertEquals(NudgeLevel.NORMAL, NudgeLevel.fromToken(null))
    }

    @Test
    fun `an absent actions field gets the default pair`() {
        assertEquals(listOf(NudgeAction.DONE, NudgeAction.SNOOZE), NudgeAction.parseCsv(null))
    }

    @Test
    fun `an explicitly empty actions field means a pure FYI with no buttons`() {
        // The distinction between absent and empty is what lets `level=SILENT, actions=""` be a
        // plain notification without needing a second command type for it.
        assertEquals(emptyList<NudgeAction>(), NudgeAction.parseCsv(""))
        assertEquals(emptyList<NudgeAction>(), NudgeAction.parseCsv("   "))
    }

    @Test
    fun `unknown action tokens are dropped and the known ones survive`() {
        assertEquals(
            listOf(NudgeAction.DONE, NudgeAction.LATER),
            NudgeAction.parseCsv("DONE,TELEPORT,LATER"),
        )
    }

    @Test
    fun `actions are capped at what Android will actually render`() {
        // A fourth action is silently dropped by the platform, which would make the contract quietly
        // untrue rather than visibly wrong.
        val parsed = NudgeAction.parseCsv("DONE,SNOOZE,LATER,OPEN")
        assertEquals(NudgeAction.MAX_ACTIONS, parsed.size)
    }

    @Test
    fun `duplicate action tokens collapse`() {
        assertEquals(listOf(NudgeAction.DONE), NudgeAction.parseCsv("DONE,done,DONE"))
    }

    @Test
    fun `every level maps to a nudge channel and never to the alarm channel`() {
        // The single most important invariant in the package. An alarm arrives as ARM_ALARM and
        // nothing else; a chase that reached the alarm channel would ring at full volume, bypass
        // Do Not Disturb, and take the lockscreen — and the owner would mute the one channel that
        // has to survive.
        for (level in NudgeLevel.entries) {
            val channel = channelIdFor(level)
            assertTrue(
                "level $level must not reach the alarm channel",
                channel != com.otto.app.core.OttoConstants.ALARM_CHANNEL_ID,
            )
            assertTrue("level $level must map to a real nudge channel", channel.isNotBlank())
        }
    }

    @Test
    fun `each level gets its own channel, so the owner can silence one without the others`() {
        val channels = NudgeLevel.entries.map { channelIdFor(it) }
        assertEquals(NudgeLevel.entries.size, channels.distinct().size)
    }
}
