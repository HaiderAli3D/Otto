package com.otto.app.alarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AlarmTimingTest {

    private val now = 1_000_000_000L
    private val grace = 60_000L

    @Test
    fun futureTrigger_isArmed() {
        assertEquals(FireDecision.ARM, AlarmTiming.classify(now + 1, now, grace))
    }

    @Test
    fun triggerExactlyNow_firesNow() {
        assertEquals(FireDecision.FIRE_NOW, AlarmTiming.classify(now, now, grace))
    }

    @Test
    fun withinGraceWindow_firesNow() {
        assertEquals(FireDecision.FIRE_NOW, AlarmTiming.classify(now - 30_000, now, grace))
    }

    @Test
    fun exactlyAtGraceBoundary_firesNow() {
        assertEquals(FireDecision.FIRE_NOW, AlarmTiming.classify(now - grace, now, grace))
    }

    @Test
    fun justPastGraceBoundary_isMissed() {
        assertEquals(FireDecision.MISSED, AlarmTiming.classify(now - grace - 1, now, grace))
    }

    @Test
    fun usesDefaultGraceWindowOf60s() {
        // 59s late with the default grace window still fires.
        assertEquals(FireDecision.FIRE_NOW, AlarmTiming.classify(now - 59_000, now))
        // 61s late with the default grace window is missed.
        assertEquals(FireDecision.MISSED, AlarmTiming.classify(now - 61_000, now))
    }

    // shouldReArm: boot/time-change/force-stop recovery must honor the SAME grace window as
    // arm(), so an alarm whose time passed while the phone was off/rebooting still fires rather
    // than being silently dropped as MISSED (bug_002).

    @Test
    fun shouldReArm_futureTrigger_isReArmed() {
        assertTrue(AlarmTiming.shouldReArm(now + 1, now, grace))
    }

    @Test
    fun shouldReArm_withinGraceWindow_isReArmed() {
        // Regression guard: a reboot straddling the alarm time (30s late) must still fire.
        assertTrue(AlarmTiming.shouldReArm(now - 30_000, now, grace))
    }

    @Test
    fun shouldReArm_exactlyAtGraceBoundary_isReArmed() {
        assertTrue(AlarmTiming.shouldReArm(now - grace, now, grace))
    }

    @Test
    fun shouldReArm_pastGraceWindow_isMissed() {
        assertFalse(AlarmTiming.shouldReArm(now - grace - 1, now, grace))
    }

    @Test
    fun shouldReArm_usesDefaultGraceWindowOf60s() {
        assertTrue(AlarmTiming.shouldReArm(now - 59_000, now))
        assertFalse(AlarmTiming.shouldReArm(now - 61_000, now))
    }

    // isStuckRinging: a still-RANG alarm found during recovery whose trigger is well in the past
    // was killed mid-ring and must be reclassified MISSED (fix #5). A recent trigger is left alone.

    private val stuck = 5 * 60 * 1000L

    @Test
    fun isStuckRinging_longPastTrigger_isStuck() {
        assertTrue(AlarmTiming.isStuckRinging(now - stuck - 1, now, stuck))
    }

    @Test
    fun isStuckRinging_recentTrigger_isNotStuck() {
        // A ring that started 30s ago could still be legitimately in progress.
        assertFalse(AlarmTiming.isStuckRinging(now - 30_000, now, stuck))
    }

    @Test
    fun isStuckRinging_exactlyAtThreshold_isNotStuck() {
        assertFalse(AlarmTiming.isStuckRinging(now - stuck, now, stuck))
    }

    @Test
    fun isStuckRinging_usesDefaultThreshold() {
        assertTrue(AlarmTiming.isStuckRinging(now - (6 * 60 * 1000L), now))
        assertFalse(AlarmTiming.isStuckRinging(now - (4 * 60 * 1000L), now))
    }
}
