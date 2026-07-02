package com.otto.app.push

import org.junit.Assert.assertEquals
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
}
