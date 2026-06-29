package com.otto.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.otto.app.alarm.AlarmController
import com.otto.app.core.OttoLog
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.net.RegistrationWorker
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Receives high-priority data messages. Because the payload carries no `notification` block,
 * [onMessageReceived] runs in every app state (foreground, background, Doze). Parsing is
 * pure; the actual arm/cancel work runs on the application scope (the service's own callback
 * window is only a few seconds).
 */
@AndroidEntryPoint
class OttoFcmService : FirebaseMessagingService() {

    @Inject lateinit var controller: AlarmController
    @Inject lateinit var preferences: OttoPreferences
    @Inject lateinit var appScope: CoroutineScope

    override fun onMessageReceived(message: RemoteMessage) {
        OttoLog.d("FCM data message received: keys=${message.data.keys}")
        when (val result = CommandParser.parse(message.data)) {
            is ParseResult.Parsed -> execute(result.command)
            is ParseResult.Ignored -> OttoLog.i("Ignoring FCM command: ${result.reason}")
            is ParseResult.Invalid -> OttoLog.w("Invalid FCM command: ${result.reason}")
        }
    }

    private fun execute(command: FcmCommand) {
        appScope.launch {
            try {
                when (command) {
                    is FcmCommand.ArmAlarm -> controller.arm(
                        alarmId = command.alarmId,
                        triggerAtMillis = command.triggerAtMillis,
                        label = command.label,
                        allowWhileIdle = command.allowWhileIdle,
                    )
                    is FcmCommand.CancelAlarm -> controller.cancel(command.alarmId)
                }
            } catch (t: Throwable) {
                OttoLog.e("Failed to execute FCM command", t)
            }
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        OttoLog.i("New FCM token ${OttoLog.redact(token)}")
        appScope.launch { preferences.setFcmToken(token) }
        RegistrationWorker.enqueue(applicationContext)
    }
}
