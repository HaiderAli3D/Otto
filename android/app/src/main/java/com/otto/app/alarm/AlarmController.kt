package com.otto.app.alarm

import android.content.Context
import com.otto.app.core.Clock
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmEntity
import com.otto.app.data.AlarmRepository
import com.otto.app.data.AlarmState
import com.otto.app.ring.RingService
import dagger.hilt.android.qualifiers.ApplicationContext
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
    @ApplicationContext private val context: Context,
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
        // Capture a mid-ring re-arm (agent reschedule via ARM_ALARM, or SYNC) BEFORE the upsert
        // overwrites the RANG row, so we can silence the now-orphaned ring afterwards (AF1).
        val wasRinging = repository.getById(alarmId)?.state == AlarmState.RANG
        val entity = repository.upsertArmed(alarmId, triggerAtMillis, label, allowWhileIdle)
        when (decision) {
            // A past-but-within-grace trigger is handled by the OS firing immediately.
            FireDecision.ARM, FireDecision.FIRE_NOW -> registerWithOs(entity)
            FireDecision.MISSED -> {
                repository.markState(alarmId, AlarmState.MISSED)
                OttoLog.i("Alarm $alarmId older than grace window; marked MISSED, not ringing")
            }
        }
        // The row is no longer RANG; tell the ring service to re-check Room and stop the sound the
        // previous ring left playing (mirrors cancel()'s wasRinging refresh, bug_003 / AF1).
        if (wasRinging) RingService.refresh(context)
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
        val wasRinging = existing?.state == AlarmState.RANG
        if (existing != null && !existing.state.isTerminal) {
            repository.markState(alarmId, AlarmState.CANCELLED)
        }
        // Cancel the OS alarm using the same stable requestCode it was armed with (fix #4).
        // Nothing to cancel if we never persisted it (we only arm alarms we stored).
        if (existing != null) scheduler.cancel(existing.requestCode)
        // If it was mid-ring, tell the foreground ring service to re-check Room and stop the
        // sound/vibration/notification — otherwise a remote CANCEL_ALARM leaves it blaring until
        // the user manually dismisses (bug_003). Mirrors RingActivity.dismiss()'s refresh call.
        if (wasRinging) RingService.refresh(context)
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
            // Guard each alarm separately: setAlarmClock() can throw (SecurityException on a
            // permission flip after the check above, quota IllegalStateException), and one bad
            // alarm must not silently drop the rest of the batch — or the stuck-RANG cleanup
            // below. Mirrors registerWithOs()'s posture for the single-alarm path.
            try {
                // Honor the same grace window as arm(): a within-grace trigger that elapsed while
                // the phone was off (e.g. a reboot straddling the alarm time) still fires now.
                if (AlarmTiming.shouldReArm(alarm.triggerAtMillis, now)) {
                    scheduler.arm(alarm)
                    reArmed++
                } else {
                    repository.markState(alarm.alarmId, AlarmState.MISSED)
                }
            } catch (t: Throwable) {
                OttoLog.e("Failed to re-arm ${alarm.alarmId}; continuing with remaining alarms", t)
            }
        }
        // A process killed mid-ring leaves the alarm RANG forever (AlarmReceiver marks RANG before
        // the ring UI runs). Reclassify such stale RANG alarms as MISSED — but ONLY when no ring is
        // actually sounding in this process. reArmAll() also runs on every app open and on time
        // changes (not just cold boot), so without this guard a genuinely long-ringing alarm would
        // be flipped to a terminal MISSED, corrupting state and defeating cancel()'s wasRinging
        // check (bug_003). RingService.isActive() is false after a cold start/force-stop, which is
        // precisely when a RANG row means "killed mid-ring".
        var missedRinging = 0
        if (!RingService.isActive()) {
            for (ringing in repository.getRinging()) {
                if (AlarmTiming.isStuckRinging(ringing.triggerAtMillis, now)) {
                    repository.markState(ringing.alarmId, AlarmState.MISSED)
                    missedRinging++
                }
            }
        }
        OttoLog.i("Re-armed $reArmed of ${armed.size} alarm(s); reclassified $missedRinging stuck-RANG as MISSED")
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
