package com.otto.app.net

import android.app.NotificationManager
import android.app.AlarmManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.otto.app.BuildConfig
import com.otto.app.core.Clock
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.prefs.OttoPreferences
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Posts a liveness heartbeat, on demand (a PING push) and on a standing schedule. No-ops on the
 * placeholder URL.
 *
 * It also carries whether the owner has silenced Otto. Android gives an app no way to UNDO a muted
 * channel — that setting belongs to the owner and rightly so — but a mute the server cannot SEE is
 * a silent failure: it would go on spending the day's message budget on notifications reaching
 * nobody, and Otto would keep confirming chases that never arrived. Knowing lets the server reroute
 * to WhatsApp and say so once.
 */
@HiltWorker
class HeartbeatWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val apiFactory: OttoApiFactory,
    private val preferences: OttoPreferences,
    private val clock: Clock,
) : CoroutineWorker(appContext, params) {

    /** Which of Otto's channels the owner has turned all the way down. */
    /**
     * Can this device still schedule an EXACT alarm?
     *
     * Inline rather than through PermissionsManager, matching `mutedChannels()` directly below: this
     * worker takes only what it needs and the call is one system-service read. Mirrors
     * `AlarmSchedulerImpl.canScheduleExact`, which is the thing that actually refuses.
     */
    private fun exactAlarmsPermitted(): Boolean =
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            true
        } else {
            applicationContext.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
        }

    private fun mutedChannels(): List<String> {
        val manager = applicationContext.getSystemService(NotificationManager::class.java) ?: return emptyList()
        return NUDGE_CHANNELS.filter { id ->
            manager.getNotificationChannel(id)?.importance == NotificationManager.IMPORTANCE_NONE
        }
    }

    override suspend fun doWork(): Result {
        val api = apiFactory.currentApiOrNull() ?: run {
            OttoLog.i("Server URL is the placeholder; skipping heartbeat")
            return Result.success()
        }
        return try {
            val response = api.heartbeat(
                deviceId = preferences.getOrCreateDeviceId(),
                body = HeartbeatRequest(
                    appVersion = BuildConfig.VERSION_NAME,
                    atMillis = clock.nowMillis(),
                    timezone = java.util.TimeZone.getDefault().id,
                    notificationsEnabled = NotificationManagerCompat.from(applicationContext).areNotificationsEnabled(),
                    mutedChannels = mutedChannels(),
                    exactAlarmsPermitted = exactAlarmsPermitted(),
                ),
            )
            if (response.isSuccessful) {
                Result.success()
            } else {
                OttoLog.w("Heartbeat failed: HTTP ${response.code()}")
                Result.retry()
            }
        } catch (io: IOException) {
            OttoLog.w("Heartbeat network error; will retry", io)
            Result.retry()
        } catch (t: Throwable) {
            OttoLog.e("Heartbeat error", t)
            Result.failure()
        }
    }

    companion object {
        private val NUDGE_CHANNELS = listOf(
            OttoConstants.NUDGE_URGENT_CHANNEL_ID,
            OttoConstants.NUDGE_CHANNEL_ID,
            OttoConstants.NUDGE_QUIET_CHANNEL_ID,
            OttoConstants.NUDGE_STATUS_CHANNEL_ID,
            OttoConstants.ALARM_CHANNEL_ID,
        )

        /** Enqueue a heartbeat; KEEP so rapid PINGs don't stack redundant posts. */
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<HeartbeatWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                OttoConstants.WORK_HEARTBEAT,
                ExistingWorkPolicy.KEEP,
                request,
            )
        }

        /**
         * The standing heartbeat. There was none at all before nudges existed.
         *
         * Without it a dead FCM path is invisible to BOTH sides — the server logs a successful send,
         * the phone shows nothing, and nobody notices until the owner mentions it. Alarms could
         * survive that gap because a missed alarm is loud; a missed nudge is silent by design, which
         * is exactly why the channel needs a pulse of its own.
         *
         * KEEP rather than REPLACE, so the chain is not restarted on every process start — this is
         * called from [com.otto.app.OttoApp.onCreate] rather than from an Activity precisely so it
         * re-arms on an FCM-only wake, and REPLACE there would push the next run out indefinitely on
         * a phone that gets woken often.
         */
        fun enqueuePeriodic(context: Context) {
            val request = PeriodicWorkRequestBuilder<HeartbeatWorker>(
                PERIOD_HOURS,
                TimeUnit.HOURS,
                FLEX_HOURS,
                TimeUnit.HOURS,
            )
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                OttoConstants.WORK_HEARTBEAT_PERIODIC,
                ExistingPeriodicWorkPolicy.KEEP,
                request,
            )
        }

        private const val PERIOD_HOURS = 6L
        private const val FLEX_HOURS = 1L
    }
}
