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
 * Handles a button pressed on a nudge notification.
 *
 * A **broadcast** receiver, and the choice is not incidental:
 *
 * - not an Activity PendingIntent, because that forces an unlock before anything happens and the
 *   entire point is resolving a nudge from the lockscreen;
 * - not a service, because background service starts are restricted on API 26+ and notification
 *   trampolines are banned outright on API 31+ — both of which bite exactly when the app has been
 *   idle, which is always.
 *
 * Dependencies come from the Hilt graph via [EntryPointAccessors] rather than field injection, for
 * the same reason [com.otto.app.alarm.AlarmReceiver] does it: a Kotlin `BroadcastReceiver` cannot
 * call the abstract `super.onReceive()`, so `@AndroidEntryPoint` has no hook to inject through.
 *
 * The work is one Room transaction, a notification cancel and a WorkManager nudge — comfortably
 * inside `goAsync()`'s ~10 second budget.
 */
class NudgeActionReceiver : BroadcastReceiver() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        // Named `nudgeController`, not `controller`: Hilt generates ONE method per name+signature on
        // the singleton component, so a getter called `controller()` here would clash with
        // AlarmReceiver's, which returns an AlarmController.
        fun nudgeController(): NudgeController
        fun appScope(): CoroutineScope
    }

    override fun onReceive(context: Context, intent: Intent) {
        val nudgeId = intent.getStringExtra(OttoConstants.EXTRA_NUDGE_ID)
        if (nudgeId == null) {
            OttoLog.w("NudgeActionReceiver fired with no nudgeId")
            return
        }

        val deps = EntryPointAccessors.fromApplication(context.applicationContext, Deps::class.java)
        val pending = goAsync()
        deps.appScope().launch(Dispatchers.IO) {
            try {
                when (intent.action) {
                    NudgeNotifications.ACTION_NUDGE_DONE -> deps.nudgeController().act(nudgeId, NudgeAction.DONE)
                    NudgeNotifications.ACTION_NUDGE_SNOOZE -> deps.nudgeController().act(nudgeId, NudgeAction.SNOOZE)
                    NudgeNotifications.ACTION_NUDGE_LATER -> deps.nudgeController().act(nudgeId, NudgeAction.LATER)
                    NudgeNotifications.ACTION_NUDGE_DISMISSED -> deps.nudgeController().dismissed(nudgeId)
                    else -> OttoLog.w("NudgeActionReceiver got an unknown action ${intent.action}")
                }
            } catch (t: Throwable) {
                OttoLog.e("Failed handling nudge action for $nudgeId", t)
            } finally {
                pending.finish()
            }
        }
    }
}
