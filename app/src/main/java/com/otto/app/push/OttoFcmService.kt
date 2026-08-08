package com.otto.app.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.otto.app.alarm.AlarmController
import com.otto.app.core.OttoLog
import com.otto.app.data.NudgeRepository
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.data.prefs.SecretStore
import com.otto.app.nudge.NudgeController
import com.otto.app.net.HeartbeatWorker
import com.otto.app.net.RegistrationWorker
import com.otto.app.net.SyncWorker
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.runBlocking
import javax.inject.Inject

/**
 * Receives high-priority data messages. Because the payload carries no `notification` block,
 * [onMessageReceived] runs in every app state (foreground, background, Doze).
 */
@AndroidEntryPoint
class OttoFcmService : FirebaseMessagingService() {

    @Inject lateinit var controller: AlarmController
    @Inject lateinit var nudgeController: NudgeController
    @Inject lateinit var nudgeRepository: NudgeRepository
    @Inject lateinit var preferences: OttoPreferences
    @Inject lateinit var secretStore: SecretStore

    /**
     * Done synchronously and on purpose: `onMessageReceived` holds the FCM wakelock only until it
     * returns, so a Dozing device that this push just woke could re-idle before a background
     * coroutine ran `setAlarmClock()` — dropping the alarm. The work is a fast DB upsert plus a
     * schedule, and we are already on a Firebase background thread (not main). The same reasoning
     * applies to a nudge: a deferred nudge is a late nudge.
     */
    override fun onMessageReceived(message: RemoteMessage) = runBlocking {
        OttoLog.d("FCM data message received: keys=${message.data.keys}")

        // VERIFY BEFORE PARSE. Deliberate, and a security requirement rather than a tidy-up: the
        // rejection path below emits an authenticated HTTPS request to the server, so parsing an
        // unverified payload first would let anyone holding the FCM token turn this device into a
        // probing and amplification oracle. Nothing may be reported about a push that failed the
        // gate — not even that it was rejected.
        val data = message.data
        val secret = secretStore.getSecret()
        val sigValid = secret != null && HmacVerifier.verify(data, secret)
        if (!HmacGate.shouldExecute(
                hasSecret = secret != null,
                sigValid = sigValid,
                hasEverPaired = preferences.getHasEverPaired(),
            )
        ) {
            OttoLog.w(
                if (secret != null) "Dropping command — HMAC verification failed"
                else "Dropping unsigned command — device is paired (no usable secret)",
            )
            return@runBlocking
        }
        if (secret == null) {
            OttoLog.w("No HMAC secret provisioned; accepting command unverified (pair to enable)")
        }

        when (val result = CommandParser.parse(data)) {
            is ParseResult.Parsed -> execute(result.command)
            // Reported, not merely logged. A contract mismatch is otherwise invisible on BOTH
            // sides — the server records a successful send, the phone records a drop, and nobody
            // correlates them. With six command types and a dozen fields that is the likeliest
            // failure in the system, and an unsupported-version rejection in particular tells the
            // server "this device is too old for that payload, stop sending it".
            is ParseResult.Ignored -> {
                OttoLog.i("Ignoring FCM command: ${result.reason}")
                reportRejection(data, result.reason)
            }
            is ParseResult.Invalid -> {
                OttoLog.w("Invalid FCM command: ${result.reason}")
                reportRejection(data, result.reason)
            }
        }
    }

    private suspend fun execute(command: FcmCommand) {
        try {
            when (command) {
                is FcmCommand.ArmAlarm -> controller.arm(
                    alarmId = command.alarmId,
                    triggerAtMillis = command.triggerAtMillis,
                    label = command.label,
                    allowWhileIdle = command.allowWhileIdle,
                )
                is FcmCommand.CancelAlarm -> controller.cancel(command.alarmId)
                is FcmCommand.Nudge -> nudgeController.show(command)
                is FcmCommand.CancelNudge -> nudgeController.cancel(command.nudgeId)
                // Network-bound; hand to workers that outlive the FCM wakelock and retry.
                FcmCommand.Sync -> SyncWorker.enqueue(applicationContext)
                FcmCommand.Ping -> HeartbeatWorker.enqueue(applicationContext)
            }
        } catch (t: Throwable) {
            OttoLog.e("Failed to execute FCM command", t)
        }
    }

    /**
     * Tell the server this device could not act on a push.
     *
     * Rate-limited structurally by the outbox's unique dedupe key — one row per rejected `type` per
     * hour, however many arrive — so a server bug looping a malformed payload cannot flood the
     * queue. That matters more than it sounds: `ReportWorker` drains in order and stops at the
     * first failure, so a flood is a blockage rather than just noise.
     */
    private suspend fun reportRejection(data: Map<String, String>, reason: String) {
        try {
            nudgeRepository.recordPushRejection(data["type"]?.takeIf { it.isNotBlank() } ?: "?", reason)
        } catch (t: Throwable) {
            OttoLog.e("Failed to record a push rejection", t)
        }
    }

    override fun onNewToken(token: String) {
        super.onNewToken(token)
        OttoLog.i("New FCM token ${OttoLog.redact(token)}")
        // Persist before enqueueing so the worker can't observe a stale/absent token.
        runBlocking { preferences.setFcmToken(token) }
        RegistrationWorker.enqueue(applicationContext)
    }
}
