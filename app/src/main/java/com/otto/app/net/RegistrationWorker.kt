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
import kotlinx.coroutines.flow.firstOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * Posts the current FCM token to the server. No-ops gracefully while the base URL is still
 * the placeholder (the server doesn't exist yet in M1). Network failures retry with backoff.
 */
@HiltWorker
class RegistrationWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val apiFactory: OttoApiFactory,
    private val preferences: OttoPreferences,
    private val clock: Clock,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val api = apiFactory.currentApiOrNull() ?: run {
            OttoLog.i("Server URL is the placeholder; skipping token registration")
            return Result.success()
        }

        val token = preferences.fcmToken.firstOrNull()
        if (token.isNullOrBlank()) {
            OttoLog.w("No FCM token available; nothing to register yet")
            return Result.success()
        }

        return try {
            val response = api.registerToken(
                deviceId = preferences.getOrCreateDeviceId(),
                body = TokenRegistrationRequest(
                    token = token,
                    appVersion = BuildConfig.VERSION_NAME,
                    timezone = java.util.TimeZone.getDefault().id,
                ),
            )
            if (response.isSuccessful) {
                preferences.setLastRegistrationMillis(clock.nowMillis())
                OttoLog.i("Registered FCM token ${OttoLog.redact(token)}")
                Result.success()
            } else {
                OttoLog.w("Token registration failed: HTTP ${response.code()}")
                Result.retry()
            }
        } catch (io: IOException) {
            OttoLog.w("Token registration network error; will retry", io)
            Result.retry()
        } catch (t: Throwable) {
            OttoLog.e("Token registration error", t)
            Result.failure()
        }
    }

    companion object {
        /** Enqueue a one-off registration; a fresh enqueue replaces any pending one. */
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<RegistrationWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                OttoConstants.WORK_REGISTER_TOKEN,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }
    }
}
