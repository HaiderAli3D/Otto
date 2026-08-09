package com.otto.app.location

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.push.FcmCommand
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.util.concurrent.TimeUnit

/**
 * The other way to stay alive long enough to answer.
 *
 * Used when the foreground service is not available — the push was downgraded out of high priority,
 * or the FGS start threw — and as the retry path when the POST itself failed. It runs exactly the
 * same [LocationController.fulfil], so there is one behaviour to reason about and one to test.
 *
 * ⚠️ Retry here re-TAKES a fix; it never replays one. That is the opposite of every other reporting
 * path in this app — [com.otto.app.net.ReportWorker] is at-least-once with ordered draining, because
 * a nudge event that arrives late is still true. A location fix that arrives late is not late, it is
 * WRONG, and nothing downstream could tell. This is the one place where the established pattern is
 * the bug, which is exactly why no coordinate is ever persisted: there is nothing here to replay.
 *
 * The request parameters survive process death without any Room table, because WorkManager persists
 * a worker's input [Data] in its own database. That is the load-bearing detail behind "no Room
 * change" — it is sound across a reboot, not merely tidy.
 */
@HiltWorker
class LocationWorker @AssistedInject constructor(
    @Assisted appContext: Context,
    @Assisted params: WorkerParameters,
    private val controller: LocationController,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val requestId = inputData.getString(KEY_REQUEST_ID)?.takeIf { it.isNotBlank() }
            ?: return Result.success() // nothing to answer; never retry a malformed enqueue
        val request = FcmCommand.RequestLocation(
            requestId = requestId,
            maxAgeMillis = inputData.getLong(KEY_MAX_AGE, OttoConstants.DEFAULT_LOCATION_MAX_AGE_MILLIS),
            expiresAtMillis = inputData.getLong(KEY_EXPIRES_AT, 0L).takeIf { it > 0L },
            highAccuracy = inputData.getBoolean(KEY_HIGH_ACCURACY, false),
            reason = inputData.getString(KEY_REASON),
        )
        return try {
            // `fulfil` reports EXPIRED and returns true once the request has outlived its use, so the
            // exponential backoff below is bounded by the request's own TTL rather than by an
            // attempt count that would keep a stale question alive.
            if (controller.fulfil(request)) Result.success() else Result.retry()
        } catch (t: Throwable) {
            OttoLog.e("Location worker failed", t)
            Result.failure()
        }
    }

    companion object {
        private const val KEY_REQUEST_ID = "requestId"
        private const val KEY_MAX_AGE = "maxAgeMillis"
        private const val KEY_EXPIRES_AT = "expiresAtMillis"
        private const val KEY_HIGH_ACCURACY = "highAccuracy"
        private const val KEY_REASON = "reason"

        fun enqueue(context: Context, request: FcmCommand.RequestLocation) {
            val data = Data.Builder()
                .putString(KEY_REQUEST_ID, request.requestId)
                .putLong(KEY_MAX_AGE, request.maxAgeMillis)
                .putLong(KEY_EXPIRES_AT, request.expiresAtMillis ?: 0L)
                .putBoolean(KEY_HIGH_ACCURACY, request.highAccuracy)
                .putString(KEY_REASON, request.reason)
                .build()

            val work = OneTimeWorkRequestBuilder<LocationWorker>()
                .setInputData(data)
                // Expedited so it runs now rather than at the system's convenience — an answer that
                // arrives after the conversation ended is not an answer. RUN_AS_NON_EXPEDITED_WORK
                // rather than dropping it once the quota is spent: late is still better than never,
                // and the request's own expiry is what stops a genuinely stale one being answered.
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()

            // Keyed by request id: two questions in flight are two pieces of work, and a REPLACE on
            // a shared name would silently drop the older one's answer.
            WorkManager.getInstance(context).enqueueUniqueWork(
                "${OttoConstants.WORK_LOCATION}:${request.requestId}",
                ExistingWorkPolicy.KEEP,
                work,
            )
        }
    }
}
