package com.otto.app.alarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

class AlarmRequestCodesTest {

    @Test
    fun sameId_yieldsStableCode() {
        assertEquals(
            AlarmRequestCodes.forAlarm("alm_8f2c"),
            AlarmRequestCodes.forAlarm("alm_8f2c"),
        )
    }

    @Test
    fun differentIds_yieldDifferentCodes() {
        assertNotEquals(
            AlarmRequestCodes.forAlarm("alm_8f2c"),
            AlarmRequestCodes.forAlarm("alm_9a01"),
        )
    }

    @Test
    fun notificationId_matchesRequestCode() {
        assertEquals(
            AlarmRequestCodes.forAlarm("alm_8f2c"),
            AlarmRequestCodes.notificationId("alm_8f2c"),
        )
    }
}
