package com.otto.app.net

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.otto.app.BuildConfig
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmRepository
import com.otto.app.data.prefs.OttoPreferences
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Drains the append-only alarm-event outbox (fix #2), POSTing one request per event and
 * deleting it on success. No-ops while the base URL is the placeholder. Because delivery is
 * at-least-once (a crash after POST but before delete re-sends), the server dedupes on
 * (alarmId, event, atMillis).
 */
@HiltWorker
class ReportWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val apiFactory: OttoApiFactory,
    private val repository: AlarmRepository,
    private val preferences: OttoPreferences,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val api = apiFactory.currentApiOrNull() ?: run {
            OttoLog.i("Server URL is the placeholder; skipping event reporting")
            return Result.success()
        }
        val pending = repository.getPendingEvents()
        if (pending.isEmpty()) return Result.success()

        val deviceId = preferences.getOrCreateDeviceId()
        var needsRetry = false
        for (event in pending) {
            try {
                val response = api.reportEvent(
                    alarmId = event.alarmId,
                    body = AlarmEventRequest(
                        deviceId = deviceId,
                        event = event.event,
                        atMillis = event.atMillis,
                        appVersion = BuildConfig.VERSION_NAME,
                    ),
                )
                if (response.isSuccessful) {
                    repository.markEventReported(event.id)
                    OttoLog.i("Reported ${event.event} for ${event.alarmId}")
                } else {
                    OttoLog.w("Event report for ${event.alarmId} failed: HTTP ${response.code()}")
                    needsRetry = true
                }
            } catch (io: IOException) {
                OttoLog.w("Event report network error; will retry", io)
                needsRetry = true
            } catch (t: Throwable) {
                // Skip this one rather than failing the whole batch.
                OttoLog.e("Event report error for ${event.alarmId}", t)
            }
        }
        return if (needsRetry) Result.retry() else Result.success()
    }

    companion object {
        /** Enqueue a drain; a fresh enqueue replaces any pending one (the drain is idempotent). */
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<ReportWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                OttoConstants.WORK_REPORT_EVENTS,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }
    }
}
