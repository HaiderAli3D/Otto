package com.otto.app.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.otto.app.core.OttoLog
import com.otto.app.net.HeartbeatWorker
import com.otto.app.net.SyncWorker
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Re-validates armed alarms when the user changes the clock or timezone (spec §10). Alarms are
 * absolute epoch ms, but a manual clock change shifts when those instants occur in real time,
 * so we re-arm all stored alarms against Room (future re-registered, already-past → MISSED).
 * On a timezone change we also trigger a SYNC plus a heartbeat (which reports the new zone),
 * since the meaning of a wall-clock time is the server's concern.
 *
 * Deps come from the Hilt graph via [EntryPointAccessors] (a Kotlin BroadcastReceiver can't
 * call super.onReceive()); DB work runs under goAsync() on the application scope.
 */
class TimeChangeReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun controller(): AlarmController
        fun appScope(): CoroutineScope
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_TIME_CHANGED && action != Intent.ACTION_TIMEZONE_CHANGED) return

        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        val pending = goAsync()
        deps.appScope().launch(Dispatchers.IO) {
            try {
                deps.controller().reArmAll()
                if (action == Intent.ACTION_TIMEZONE_CHANGED) {
                    SyncWorker.enqueue(context.applicationContext)
                    // Heartbeat carries the device timezone, so the server learns the new zone
                    // promptly instead of at the next scheduled ping.
                    HeartbeatWorker.enqueue(context.applicationContext)
                }
                OttoLog.i("Re-validated alarms after $action")
            } catch (t: Throwable) {
                OttoLog.e("Failed to re-validate alarms after $action", t)
            } finally {
                pending.finish()
            }
        }
    }
}
