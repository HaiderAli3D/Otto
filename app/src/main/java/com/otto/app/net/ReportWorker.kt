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
 * Drains every alarm whose latest state change hasn't reached the server, POSTing one event
 * per alarm. No-ops while the base URL is the placeholder. Re-runs only re-report what is
 * still unreported (the markReported updatedAtMillis guard), so duplicate POSTs are bounded
 * and the server is expected to dedupe on (alarmId, event, atMillis).
 */
@HiltWorker
class ReportWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val api: OttoApi,
    private val repository: AlarmRepository,
    private val preferences: OttoPreferences,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        if (BuildConfig.SERVER_BASE_URL.contains(PLACEHOLDER_HOST)) {
            OttoLog.i("Server URL is the placeholder; skipping event reporting")
            return Result.success()
        }
        val pending = repository.getUnreported()
        if (pending.isEmpty()) return Result.success()

        val deviceId = preferences.getOrCreateDeviceId()
        var needsRetry = false
        for (alarm in pending) {
            try {
                val response = api.reportEvent(
                    alarmId = alarm.alarmId,
                    body = AlarmEventRequest(
                        deviceId = deviceId,
                        event = alarm.state.name,
                        atMillis = alarm.updatedAtMillis,
                        appVersion = BuildConfig.VERSION_NAME,
                    ),
                )
                if (response.isSuccessful) {
                    repository.markReported(alarm)
                    OttoLog.i("Reported ${alarm.state} for ${alarm.alarmId}")
                } else {
                    OttoLog.w("Event report for ${alarm.alarmId} failed: HTTP ${response.code()}")
                    needsRetry = true
                }
            } catch (io: IOException) {
                OttoLog.w("Event report network error; will retry", io)
                needsRetry = true
            } catch (t: Throwable) {
                // Skip this one rather than failing the whole batch.
                OttoLog.e("Event report error for ${alarm.alarmId}", t)
            }
        }
        return if (needsRetry) Result.retry() else Result.success()
    }

    companion object {
        private const val PLACEHOLDER_HOST = "otto.invalid"

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
