package com.otto.app.nudge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Re-shows a snoozed nudge when its moment comes round.
 *
 * A separate receiver from [com.otto.app.alarm.AlarmReceiver], with a separate intent action, so a
 * nudge registration and an alarm registration can never match each other's PendingIntent — and so
 * that nothing in the alarm path has to grow a branch for nudges.
 */
class NudgeAlarmReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        // See NudgeActionReceiver.Deps for why this is not called `controller`.
        fun nudgeController(): NudgeController
        fun appScope(): CoroutineScope
    }

    override fun onReceive(context: Context, intent: Intent) {
        val notificationId = intent.getIntExtra(OttoConstants.EXTRA_NUDGE_NOTIFICATION_ID, -1)
        if (notificationId < 0) {
            OttoLog.w("NudgeAlarmReceiver fired with no notification id")
            return
        }

        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        val pending = goAsync()
        deps.appScope().launch(Dispatchers.IO) {
            try {
                deps.nudgeController().reshow(notificationId)
            } catch (t: Throwable) {
                OttoLog.e("Failed re-showing nudge $notificationId", t)
            } finally {
                pending.finish()
            }
        }
    }
}
