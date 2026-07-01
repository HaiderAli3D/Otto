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
import com.otto.app.core.Clock
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.prefs.OttoPreferences
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** PING: posts a liveness heartbeat. No-ops on the placeholder URL. */
@HiltWorker
class HeartbeatWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val apiFactory: OttoApiFactory,
    private val preferences: OttoPreferences,
    private val clock: Clock,
) : CoroutineWorker(appContext, params) {

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
    }
}
