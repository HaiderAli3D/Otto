package com.otto.app.ring

/**
 * Plays/stops the alarm sound. Kept behind an interface so a richer ring (volume ramp,
 * vibration pattern, custom audio) can replace [SimpleRinger] in a later milestone without
 * touching the ring screen.
 */
interface AlarmRinger {
    fun start()
    fun stop()
}
