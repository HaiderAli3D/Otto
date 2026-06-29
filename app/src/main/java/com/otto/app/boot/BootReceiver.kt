package com.otto.app.boot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.otto.app.alarm.AlarmController
import com.otto.app.core.OttoLog
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * AlarmManager forgets all alarms on reboot, so on BOOT_COMPLETED (and after an app update,
 * MY_PACKAGE_REPLACED) we rebuild the OS alarms from Room — the source of truth. Future
 * ARMED alarms are re-registered; ones whose time passed while powered off are marked MISSED.
 */
@AndroidEntryPoint
class BootReceiver : BroadcastReceiver() {

    @Inject lateinit var controller: AlarmController
    @Inject lateinit var appScope: CoroutineScope

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)

        val action = intent.action
        if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        OttoLog.i("Re-arming alarms after $action")
        val pending = goAsync()
        appScope.launch(Dispatchers.IO) {
            try {
                controller.reArmAll()
            } catch (t: Throwable) {
                OttoLog.e("Re-arm after $action failed", t)
            } finally {
                pending.finish()
            }
        }
    }
}
