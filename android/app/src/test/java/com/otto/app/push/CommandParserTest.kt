package com.otto.app.push

import com.otto.app.core.OttoConstants
import com.otto.app.nudge.NudgeAction
import com.otto.app.nudge.NudgeLevel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CommandParserTest {

    @Test
    fun validArm_parses() {
        val result = CommandParser.parse(
            mapOf(
                "v" to "1",
                "type" to "ARM_ALARM",
                "alarmId" to "alm_8f2c",
                "triggerAtMillis" to "1751200000000",
                "label" to "Email Teal",
                "allowWhileIdle" to "true",
            ),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.ArmAlarm
        assertEquals("alm_8f2c", command.alarmId)
        assertEquals(1751200000000L, command.triggerAtMillis)
        assertEquals("Email Teal", command.label)
        assertTrue(command.allowWhileIdle)
    }

    @Test
    fun arm_defaultsLabelAndAllowWhileIdle() {
        val result = CommandParser.parse(
            mapOf("type" to "ARM_ALARM", "alarmId" to "alm_1", "triggerAtMillis" to "100"),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.ArmAlarm
        assertEquals("Alarm", command.label)
        assertTrue(command.allowWhileIdle)
    }

    @Test
    fun validRequestLocation_parses() {
        val result = CommandParser.parse(
            mapOf(
                "v" to "1",
                "type" to "REQUEST_LOCATION",
                "requestId" to "loc_9f",
                "maxAgeSeconds" to "120",
                "expiresAtMillis" to "1751200000000",
                "highAccuracy" to "true",
                "reason" to "work out when to leave for the dentist",
            ),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.RequestLocation
        assertEquals("loc_9f", command.requestId)
        assertEquals(120_000L, command.maxAgeMillis)
        assertEquals(1751200000000L, command.expiresAtMillis)
        assertTrue(command.highAccuracy)
        assertEquals("work out when to leave for the dentist", command.reason)
    }

    @Test
    fun requestLocation_withoutRequestId_isInvalid() {
        // Stricter than a nudge on purpose. A nudge missing a field is still worth showing; an
        // answer the server cannot match to its own question is worth nothing at all — and Invalid
        // goes back as a PUSH/REJECTED device event rather than vanishing.
        val result = CommandParser.parse(mapOf("type" to "REQUEST_LOCATION"))
        assertTrue(result is ParseResult.Invalid)
    }

    @Test
    fun requestLocation_clampsAnAbsurdMaxAge() {
        // A server asking for a six-hour-old fix would be indistinguishable, on the wire, from one
        // asking for a current one, and "current location" would quietly stop meaning anything.
        val result = CommandParser.parse(
            mapOf("type" to "REQUEST_LOCATION", "requestId" to "loc_1", "maxAgeSeconds" to "999999"),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.RequestLocation
        assertEquals(OttoConstants.MAX_LOCATION_AGE_SECONDS * 1_000L, command.maxAgeMillis)
    }

    @Test
    fun requestLocation_defaultsEverythingOptional() {
        val result = CommandParser.parse(mapOf("type" to "REQUEST_LOCATION", "requestId" to "loc_1"))
        val command = (result as ParseResult.Parsed).command as FcmCommand.RequestLocation
        assertEquals(OttoConstants.DEFAULT_LOCATION_MAX_AGE_MILLIS, command.maxAgeMillis)
        assertNull(command.expiresAtMillis)
        assertFalse(command.highAccuracy)
        assertNull(command.reason)
    }

    @Test
    fun requestLocation_clampsAnOversizedReason() {
        val result = CommandParser.parse(
            mapOf("type" to "REQUEST_LOCATION", "requestId" to "loc_1", "reason" to "x".repeat(500)),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.RequestLocation
        assertEquals(OttoConstants.MAX_LOCATION_REASON_CHARS, command.reason!!.length)
    }

    @Test
    fun validCancel_parses() {
        val result = CommandParser.parse(mapOf("type" to "CANCEL_ALARM", "alarmId" to "alm_1"))
        assertEquals(FcmCommand.CancelAlarm("alm_1"), (result as ParseResult.Parsed).command)
    }

    @Test
    fun arm_missingAlarmId_isInvalid() {
        val result = CommandParser.parse(mapOf("type" to "ARM_ALARM", "triggerAtMillis" to "100"))
        assertTrue(result is ParseResult.Invalid)
    }

    @Test
    fun arm_nonNumericTrigger_isInvalid() {
        val result = CommandParser.parse(
            mapOf("type" to "ARM_ALARM", "alarmId" to "alm_1", "triggerAtMillis" to "soon"),
        )
        assertTrue(result is ParseResult.Invalid)
    }

    @Test
    fun missingType_isInvalid() {
        assertTrue(CommandParser.parse(mapOf("alarmId" to "alm_1")) is ParseResult.Invalid)
    }

    @Test
    fun sync_parses() {
        val result = CommandParser.parse(mapOf("type" to "SYNC"))
        assertEquals(FcmCommand.Sync, (result as ParseResult.Parsed).command)
    }

    @Test
    fun ping_parses() {
        val result = CommandParser.parse(mapOf("type" to "PING"))
        assertEquals(FcmCommand.Ping, (result as ParseResult.Parsed).command)
    }

    @Test
    fun unknownType_isIgnored() {
        assertTrue(CommandParser.parse(mapOf("type" to "LAUNCH_ROCKET")) is ParseResult.Ignored)
    }

    @Test
    fun unsupportedVersion_isIgnored() {
        val result = CommandParser.parse(
            mapOf("v" to "2", "type" to "ARM_ALARM", "alarmId" to "alm_1", "triggerAtMillis" to "100"),
        )
        assertTrue(result is ParseResult.Ignored)
        assertTrue((result as ParseResult.Ignored).reason.contains("version"))
    }

    @Test
    fun missingVersion_stillParses() {
        // Back-compat: early payloads omitted `v`; they must keep working.
        val result = CommandParser.parse(
            mapOf("type" to "ARM_ALARM", "alarmId" to "alm_1", "triggerAtMillis" to "100"),
        )
        assertTrue(result is ParseResult.Parsed)
    }

    @Test
    fun unknownFields_areTolerated() {
        val result = CommandParser.parse(
            mapOf(
                "type" to "ARM_ALARM",
                "alarmId" to "alm_1",
                "triggerAtMillis" to "100",
                "sig" to "deadbeef",
                "futureField" to "whatever",
            ),
        )
        assertTrue(result is ParseResult.Parsed)
    }

    // --- NUDGE / CANCEL_NUDGE ---

    @Test
    fun nudge_parsesWithEveryFieldSupplied() {
        val result = CommandParser.parse(
            mapOf(
                "v" to "1",
                "type" to "NUDGE",
                "nudgeId" to "rem_01J8",
                "title" to "Email Teal",
                "body" to "Still open",
                "level" to "URGENT",
                "actions" to "DONE,SNOOZE",
                "snoozeMinutes" to "45",
                "expiresAtMillis" to "1751200000000",
                "ongoing" to "true",
            ),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.Nudge
        assertEquals("rem_01J8", command.nudgeId)
        assertEquals(NudgeLevel.URGENT, command.level)
        assertEquals(listOf(NudgeAction.DONE, NudgeAction.SNOOZE), command.actions)
        assertEquals(45, command.snoozeMinutes)
        assertEquals(1751200000000L, command.expiresAtMillis)
        assertTrue(command.ongoing)
    }

    @Test
    fun nudge_needsOnlyIdTitleAndBody() {
        // Everything else degrades to a default rather than rejecting the payload: a nudge that
        // arrives slightly wrong beats one that does not arrive, because the server has already
        // decided the owner should hear about this.
        val result = CommandParser.parse(
            mapOf("type" to "NUDGE", "nudgeId" to "rem_1", "title" to "T", "body" to "B"),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.Nudge
        assertEquals(NudgeLevel.NORMAL, command.level)
        assertEquals(NudgeAction.DEFAULT, command.actions)
        assertEquals(OttoConstants.DEFAULT_SNOOZE_MINUTES, command.snoozeMinutes)
        assertNull(command.expiresAtMillis)
        assertFalse(command.ongoing)
    }

    @Test
    fun nudge_withoutTheThreeRequiredFieldsIsInvalid() {
        for (missing in listOf("nudgeId", "title", "body")) {
            val data = mutableMapOf(
                "type" to "NUDGE",
                "nudgeId" to "rem_1",
                "title" to "T",
                "body" to "B",
            )
            data.remove(missing)
            assertTrue("missing $missing must be Invalid", CommandParser.parse(data) is ParseResult.Invalid)
        }
    }

    @Test
    fun nudge_clampsAnOversizeTitleAndBodyRatherThanThrowingOnRender() {
        // The server truncates before signing so the payload clears FCM's 4KB cap; this is the
        // backstop that keeps a server bug from becoming a RemoteServiceException on the phone.
        val result = CommandParser.parse(
            mapOf(
                "type" to "NUDGE",
                "nudgeId" to "rem_1",
                "title" to "t".repeat(500),
                "body" to "b".repeat(5_000),
            ),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.Nudge
        assertEquals(OttoConstants.MAX_NUDGE_TITLE_CHARS, command.title.length)
        assertEquals(OttoConstants.MAX_NUDGE_BODY_CHARS, command.body.length)
    }

    @Test
    fun nudge_withAnExplicitlyEmptyActionsListIsAPlainNotification() {
        val result = CommandParser.parse(
            mapOf(
                "type" to "NUDGE",
                "nudgeId" to "rem_1",
                "title" to "T",
                "body" to "B",
                "level" to "SILENT",
                "actions" to "",
            ),
        )
        val command = (result as ParseResult.Parsed).command as FcmCommand.Nudge
        assertEquals(NudgeLevel.SILENT, command.level)
        assertTrue(command.actions.isEmpty())
    }

    @Test
    fun cancelNudge_parses() {
        val result = CommandParser.parse(mapOf("type" to "CANCEL_NUDGE", "nudgeId" to "rem_1"))
        assertEquals("rem_1", ((result as ParseResult.Parsed).command as FcmCommand.CancelNudge).nudgeId)
    }

    @Test
    fun cancelNudge_withoutAnIdIsInvalid() {
        assertTrue(CommandParser.parse(mapOf("type" to "CANCEL_NUDGE")) is ParseResult.Invalid)
    }
}
