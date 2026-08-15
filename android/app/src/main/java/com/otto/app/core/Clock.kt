package com.otto.app.core

import javax.inject.Inject

/**
 * Wall-clock time, injected wherever "now" is read so scheduling logic can be unit-tested
 * against a fake clock instead of real elapsed time.
 */
interface Clock {
    /** Current wall-clock time in epoch milliseconds (UTC). */
    fun nowMillis(): Long
}

class SystemClock @Inject constructor() : Clock {
    override fun nowMillis(): Long = System.currentTimeMillis()
}
