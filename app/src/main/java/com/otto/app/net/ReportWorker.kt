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
 *
 * ORDERING GUARANTEE (AF3): events are drained strictly in id-ASC (chronological) order and the
 * drain STOPS at the first failure. The server applies state unconditionally, so letting a newer
 * event overtake an older one after a mid-batch failure would corrupt state (e.g. a stale ARMED
 * landing after a DISMISSED). The retry re-drains from the front, preserving order.
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
            val delivered = try {
                val response = api.reportEvent(
                    alarmId = event.alarmId,
                    body = AlarmEventRequest(
                        deviceId = deviceId,
                        event = event.event,
                        atMillis = event.atMillis,
                        appVersion = BuildConfig.VERSION_NAME,
                        // The alarm's CURRENT trigger, so the server picks up a snooze's new time
                        // (AF4). Null if the row is gone; the server only acts on it for ARMED.
                        triggerAtMillis = repository.getById(event.alarmId)?.triggerAtMillis,
                    ),
                )
                if (!response.isSuccessful) {
                    OttoLog.w("Event report for ${event.alarmId} failed: HTTP ${response.code()}")
                }
                response.isSuccessful
            } catch (io: IOException) {
                OttoLog.w("Event report network error; will retry", io)
                false
            } catch (t: Throwable) {
                OttoLog.e("Event report error for ${event.alarmId}; will retry", t)
                false
            }
            if (!delivered) {
                // Stop at the first failure to keep events strictly in order (AF3); the retry
                // re-drains from the front. Do NOT continue to a newer event.
                needsRetry = true
                break
            }
            repository.markEventReported(event.id)
            OttoLog.i("Reported ${event.event} for ${event.alarmId}")
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
