package com.otto.app.boot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.otto.app.alarm.AlarmController
import com.otto.app.core.OttoLog
import com.otto.app.nudge.NudgeController
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * A reboot forgets everything derived: AlarmManager loses every registration, and the system
 * notification shade is emptied. On BOOT_COMPLETED (and after an app update, MY_PACKAGE_REPLACED)
 * both are rebuilt from Room — the source of truth for alarms and for nudges alike.
 *
 * Dependencies come from the Hilt graph via [EntryPointAccessors] (see [com.otto.app.alarm.AlarmReceiver]
 * for why a Kotlin BroadcastReceiver avoids @AndroidEntryPoint here).
 */
class BootReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun controller(): AlarmController
        fun nudgeController(): NudgeController
        fun appScope(): CoroutineScope
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        OttoLog.i("Rebuilding alarms and nudges after $action")
        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        val pending = goAsync()
        deps.appScope().launch(Dispatchers.IO) {
            // Alarms FIRST, and in their own try/catch. The ordering and the separate catch are both
            // deliberate: a nudge is a notification and an alarm is the thing the owner is relying
            // on to wake up, so a failure restoring the new surface must not be able to abort
            // recovery of the old one.
            try {
                deps.controller().reArmAll()
            } catch (t: Throwable) {
                OttoLog.e("Re-arm after $action failed", t)
            }
            try {
                deps.nudgeController().restoreAll()
            } catch (t: Throwable) {
                OttoLog.e("Nudge restore after $action failed", t)
            }
            pending.finish()
        }
    }
}
