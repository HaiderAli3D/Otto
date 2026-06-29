package com.otto.app.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmRepository
import com.otto.app.data.AlarmState
import com.otto.app.ring.AlarmNotifications
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Receives the alarm broadcast at trigger time. Marks the alarm RANG in Room and posts the
 * full-screen-intent notification that brings up [com.otto.app.ring.RingActivity].
 *
 * Hilt injects the fields via the generated base class, so super.onReceive() must run
 * first. DB work is moved off the main thread under goAsync() (≤10s budget) on an
 * application-scoped coroutine, since the receiver instance itself is short-lived.
 */
@AndroidEntryPoint
class AlarmReceiver : BroadcastReceiver() {

    @Inject lateinit var repository: AlarmRepository
    @Inject lateinit var notifications: AlarmNotifications
    @Inject lateinit var appScope: CoroutineScope

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)

        val alarmId = intent.getStringExtra(OttoConstants.EXTRA_ALARM_ID)
        if (alarmId == null) {
            OttoLog.w("AlarmReceiver fired with no alarmId")
            return
        }

        val pending = goAsync()
        appScope.launch(Dispatchers.IO) {
            try {
                val alarm = repository.getById(alarmId)
                when {
                    alarm == null ->
                        OttoLog.w("Alarm $alarmId fired but is not in the store")
                    alarm.state.isTerminal ->
                        OttoLog.i("Alarm $alarmId already ${alarm.state}; ignoring fire")
                    else -> {
                        repository.markState(alarmId, AlarmState.RANG)
                        notifications.postRinging(alarmId, alarm.label)
                        OttoLog.i("Alarm $alarmId ringing")
                    }
                }
            } catch (t: Throwable) {
                OttoLog.e("Failed handling fire for $alarmId", t)
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_ALARM_FIRE = "com.otto.app.action.ALARM_FIRE"
    }
}
