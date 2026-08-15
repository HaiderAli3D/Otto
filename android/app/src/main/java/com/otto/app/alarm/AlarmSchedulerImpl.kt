package com.otto.app.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmEntity
import com.otto.app.ui.MainActivity
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Arms alarms with [AlarmManager.setAlarmClock] — the only alarm type exempt from Doze,
 * which also surfaces the system status-bar alarm icon. The `showIntent` opens the app when
 * the user taps that icon; the `operation` broadcasts to [AlarmReceiver] at trigger time.
 *
 * Idempotency comes from a stable request code per alarmId plus FLAG_UPDATE_CURRENT: the
 * same alarmId reuses the same PendingIntent, so re-arming replaces rather than duplicates.
 */
@Singleton
class AlarmSchedulerImpl @Inject constructor(
    @ApplicationContext private val context: Context,
) : AlarmScheduler {

    private val alarmManager: AlarmManager = context.getSystemService(AlarmManager::class.java)

    override fun arm(alarm: AlarmEntity) {
        val requestCode = alarm.requestCode

        val operation = PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, AlarmReceiver::class.java).apply {
                action = AlarmReceiver.ACTION_ALARM_FIRE
                putExtra(OttoConstants.EXTRA_ALARM_ID, alarm.alarmId)
            },
            PI_FLAGS,
        )
        val showIntent = PendingIntent.getActivity(
            context,
            requestCode,
            Intent(context, MainActivity::class.java),
            PI_FLAGS,
        )

        // Note: alarm.allowWhileIdle is informational only — setAlarmClock() is inherently
        // exempt from Doze, so there is no inexact/idle variant to gate here.
        val info = AlarmManager.AlarmClockInfo(alarm.triggerAtMillis, showIntent)
        alarmManager.setAlarmClock(info, operation)
        OttoLog.d("Armed ${alarm.alarmId} @ ${alarm.triggerAtMillis} (rc=$requestCode)")
    }

    override fun cancel(requestCode: Int) {
        // Must rebuild a PendingIntent equal to the armed one (extras are ignored in
        // matching; action + component must match).
        val operation = PendingIntent.getBroadcast(
            context,
            requestCode,
            Intent(context, AlarmReceiver::class.java).apply {
                action = AlarmReceiver.ACTION_ALARM_FIRE
            },
            PI_FLAGS,
        )
        alarmManager.cancel(operation)
        operation.cancel()
        OttoLog.d("Cancelled alarm (rc=$requestCode)")
    }

    override fun canScheduleExact(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            alarmManager.canScheduleExactAlarms()
        } else {
            true
        }

    companion object {
        private const val PI_FLAGS =
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    }
}
