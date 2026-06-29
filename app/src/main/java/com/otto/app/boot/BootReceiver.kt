package com.otto.app.boot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.otto.app.alarm.AlarmController
import com.otto.app.core.OttoLog
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * AlarmManager forgets all alarms on reboot, so on BOOT_COMPLETED (and after an app update,
 * MY_PACKAGE_REPLACED) we rebuild the OS alarms from Room — the source of truth.
 *
 * Dependencies come from the Hilt graph via [EntryPointAccessors] (see [com.otto.app.alarm.AlarmReceiver]
 * for why a Kotlin BroadcastReceiver avoids @AndroidEntryPoint here).
 */
class BootReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun controller(): AlarmController
        fun appScope(): CoroutineScope
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        OttoLog.i("Re-arming alarms after $action")
        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        val pending = goAsync()
        deps.appScope().launch(Dispatchers.IO) {
            try {
                deps.controller().reArmAll()
            } catch (t: Throwable) {
                OttoLog.e("Re-arm after $action failed", t)
            } finally {
                pending.finish()
            }
        }
    }
}
