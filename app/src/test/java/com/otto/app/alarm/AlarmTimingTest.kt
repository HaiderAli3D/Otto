package com.otto.app.alarm

import org.junit.Assert.assertEquals
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
}
