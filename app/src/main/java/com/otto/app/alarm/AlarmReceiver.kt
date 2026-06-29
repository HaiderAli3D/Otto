package com.otto.app.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmRepository
import com.otto.app.data.AlarmState
import com.otto.app.ring.AlarmNotifications
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Receives the alarm broadcast at trigger time. Marks the alarm RANG in Room and posts the
 * full-screen-intent notification that brings up [com.otto.app.ring.RingActivity].
 *
 * Dependencies are pulled from the application's Hilt graph via [EntryPointAccessors] rather
 * than field injection: a Kotlin BroadcastReceiver cannot call super.onReceive() (the base
 * method is abstract), which is how @AndroidEntryPoint would otherwise trigger injection.
 * DB work runs off the main thread under goAsync() (≤10s budget) on the application scope.
 */
class AlarmReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun repository(): AlarmRepository
        fun notifications(): AlarmNotifications
        fun appScope(): CoroutineScope
    }

    override fun onReceive(context: Context, intent: Intent) {
        val alarmId = intent.getStringExtra(OttoConstants.EXTRA_ALARM_ID)
        if (alarmId == null) {
            OttoLog.w("AlarmReceiver fired with no alarmId")
            return
        }

        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        val pending = goAsync()
        deps.appScope().launch(Dispatchers.IO) {
            try {
                val alarm = deps.repository().getById(alarmId)
                when {
                    alarm == null ->
                        OttoLog.w("Alarm $alarmId fired but is not in the store")
                    alarm.state.isTerminal ->
                        OttoLog.i("Alarm $alarmId already ${alarm.state}; ignoring fire")
                    else -> {
                        deps.repository().markState(alarmId, AlarmState.RANG)
                        deps.notifications().postRinging(alarmId, alarm.label)
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
