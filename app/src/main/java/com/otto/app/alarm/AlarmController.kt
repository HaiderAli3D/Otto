package com.otto.app.alarm

import com.otto.app.core.Clock
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmEntity
import com.otto.app.data.AlarmRepository
import com.otto.app.data.AlarmState
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Orchestrates persistence (source of truth) and the OS scheduler (derived state) for every
 * arm/cancel/re-arm path — FCM commands, the test button, and boot recovery all funnel
 * through here so behaviour and idempotency are identical regardless of trigger.
 */
@Singleton
class AlarmController @Inject constructor(
    private val repository: AlarmRepository,
    private val scheduler: AlarmScheduler,
    private val clock: Clock,
) {

    /**
     * Arm (or replace) an alarm. Returns the timing decision taken. Idempotent on [alarmId].
     */
    suspend fun arm(
        alarmId: String,
        triggerAtMillis: Long,
        label: String,
        allowWhileIdle: Boolean,
    ): FireDecision {
        val decision = AlarmTiming.classify(triggerAtMillis, clock.nowMillis())
        val entity = repository.upsertArmed(alarmId, triggerAtMillis, label, allowWhileIdle)
        when (decision) {
            // A past-but-within-grace trigger is handled by the OS firing immediately.
            FireDecision.ARM, FireDecision.FIRE_NOW -> registerWithOs(entity)
            FireDecision.MISSED -> {
                repository.markState(alarmId, AlarmState.MISSED)
                OttoLog.i("Alarm $alarmId older than grace window; marked MISSED, not ringing")
            }
        }
        OttoLog.i("Armed $alarmId -> $decision")
        return decision
    }

    /** Snooze: re-arm the alarm at now + the fixed snooze interval (spec §13). */
    suspend fun snooze(alarmId: String): Boolean {
        val entity = repository.snooze(alarmId, clock.nowMillis() + OttoConstants.SNOOZE_INTERVAL_MILLIS)
        if (entity == null) {
            OttoLog.w("Cannot snooze $alarmId; not found")
            return false
        }
        registerWithOs(entity)
        OttoLog.i("Snoozed $alarmId to ${entity.triggerAtMillis} (count ${entity.snoozeCount})")
        return true
    }

    /** Cancel an alarm and record the outcome (no-op on the OS side if not registered). */
    suspend fun cancel(alarmId: String) {
        // Room first (source of truth): if we crash before scheduler.cancel(), a stale OS
        // alarm that still fires is ignored by AlarmReceiver's terminal-state guard. The
        // reverse order would let reArmAll() resurrect a cancelled alarm on the next boot.
        val existing = repository.getById(alarmId)
        if (existing != null && !existing.state.isTerminal) {
            repository.markState(alarmId, AlarmState.CANCELLED)
        }
        scheduler.cancel(alarmId)
        OttoLog.i("Cancelled $alarmId")
    }

    /**
     * Re-arm everything after a reboot or app update. Future ARMED alarms are re-registered;
     * ARMED alarms whose time already passed (while powered off) are marked MISSED.
     */
    suspend fun reArmAll() {
        if (!scheduler.canScheduleExact()) {
            OttoLog.w("Exact alarms not permitted; cannot re-arm")
            return
        }
        val now = clock.nowMillis()
        val armed = repository.getAllArmed()
        var reArmed = 0
        for (alarm in armed) {
            if (alarm.triggerAtMillis > now) {
                scheduler.arm(alarm)
                reArmed++
            } else {
                repository.markState(alarm.alarmId, AlarmState.MISSED)
            }
        }
        OttoLog.i("Re-armed $reArmed of ${armed.size} stored alarm(s)")
    }

    private fun registerWithOs(entity: AlarmEntity) {
        if (!scheduler.canScheduleExact()) {
            // Leave it ARMED in Room so boot re-arm can register it once the exact-alarm
            // permission is granted; the permissions panel surfaces the missing grant. We do
            // not pretend it is scheduled beyond that (spec §9).
            OttoLog.w("Exact alarms not permitted; ${entity.alarmId} recorded but not registered")
            return
        }
        try {
            scheduler.arm(entity)
        } catch (se: SecurityException) {
            OttoLog.e("Exact alarm denied while arming ${entity.alarmId}", se)
        }
    }
}
