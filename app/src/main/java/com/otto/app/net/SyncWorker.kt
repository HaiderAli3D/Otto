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
import com.otto.app.alarm.AlarmController
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmRepository
import com.otto.app.data.prefs.OttoPreferences
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * SYNC: pulls the server's authoritative alarm set and reconciles local state to it — arms
 * (idempotently) everything the server lists as ARMED, then cancels any local ARMED alarm the
 * server no longer lists. Runs as a worker because it does network I/O and must outlive the
 * brief FCM wakelock. No-ops on the placeholder URL.
 */
@HiltWorker
class SyncWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val apiFactory: OttoApiFactory,
    private val controller: AlarmController,
    private val repository: AlarmRepository,
    private val preferences: OttoPreferences,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val api = apiFactory.currentApiOrNull() ?: run {
            OttoLog.i("Server URL is the placeholder; skipping sync")
            return Result.success()
        }
        return try {
            val response = api.fetchAlarms(preferences.getOrCreateDeviceId())
            if (!response.isSuccessful) {
                OttoLog.w("Sync fetch failed: HTTP ${response.code()}")
                return Result.retry()
            }
            // Delegate the safety-critical arm/cancel decision to the pure, tested reconciler so a
            // 200 with an empty/unparseable body can never wipe the user's alarms (see fix #1).
            when (val plan = SyncReconciler.reconcile(repository.getAllArmed(), response.body())) {
                SyncPlan.Retry -> {
                    OttoLog.w("Sync response not authoritative (empty/unparseable body); alarms unchanged")
                    Result.retry()
                }
                is SyncPlan.Apply -> {
                    // Arm/refresh (idempotent on alarmId), then cancel only what the server dropped.
                    for (a in plan.toArm) {
                        controller.arm(a.alarmId, a.triggerAtMillis, a.label, a.allowWhileIdle)
                    }
                    for (id in plan.toCancelIds) controller.cancel(id)
                    OttoLog.i("Synced: armed ${plan.toArm.size}, cancelled ${plan.toCancelIds.size}")
                    Result.success()
                }
            }
        } catch (io: IOException) {
            OttoLog.w("Sync network error; will retry", io)
            Result.retry()
        } catch (t: Throwable) {
            OttoLog.e("Sync error", t)
            Result.failure()
        }
    }

    companion object {
        /** Enqueue a reconciliation; a fresh enqueue replaces any pending one (latest wins). */
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(
                    Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                OttoConstants.WORK_SYNC,
                ExistingWorkPolicy.REPLACE,
                request,
            )
        }
    }
}
