package com.otto.app.location

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.push.FcmCommand
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Holds the process open for exactly one location fix, and tells the owner it is doing so.
 *
 * A foreground service rather than a plain background coroutine because the FIX is what needs the
 * process alive: `onMessageReceived` holds the FCM wakelock only until it returns (~10s), which a
 * GPS lock can easily exceed. And typed `location` because from API 34 the system checks the
 * declared type against the permissions actually held at `startForeground()` time.
 *
 * Starting this from the background is legal only because the app holds ACCESS_BACKGROUND_LOCATION.
 * A high-priority FCM message is an exemption to the background-START restriction but is NOT on the
 * while-in-use exemption list, so without background location this would throw SecurityException
 * every time — see [LocationDispatcher], which is where that decision is made rather than here.
 */
@AndroidEntryPoint
class LocationService : Service() {

    @Inject lateinit var controller: LocationController
    @Inject lateinit var notifications: LocationNotifications
    @Inject lateinit var appScope: CoroutineScope

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val request = intent?.toRequest()
        if (request == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }

        // Foreground FIRST, before any await. The system gives a service started this way a few
        // seconds to call startForeground() and kills the process with an ANR-shaped crash if it
        // does not — and a GPS lock is exactly the sort of wait that would miss the window.
        goForeground(request.reason)

        appScope.launch(Dispatchers.IO) {
            try {
                val done = controller.fulfil(request)
                OttoLog.i("Location request ${request.requestId} answered (delivered=$done)")
                // The answer could not be delivered. Hand to the worker, which retries with a FRESH
                // fix rather than replaying this one — a replayed coordinate is a lie about the
                // present, and worse than no answer at all.
                if (!done) LocationWorker.enqueue(applicationContext, request)
            } catch (t: Throwable) {
                OttoLog.e("Location service failed to answer", t)
            } finally {
                ServiceCompat.stopForeground(this@LocationService, ServiceCompat.STOP_FOREGROUND_REMOVE)
                stopSelf(startId)
            }
        }
        return START_NOT_STICKY
    }

    private fun goForeground(reason: String?) {
        val type =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            } else {
                0
            }
        runCatching {
            ServiceCompat.startForeground(
                this,
                OttoConstants.LOCATION_NOTIFICATION_ID,
                notifications.building(reason),
                type,
            )
        }.onFailure {
            // Never fatal. Whatever the platform decided, the answer still has a road home.
            OttoLog.w("Could not go foreground for a location fix", it)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val ACTION_FIX = "com.otto.app.action.LOCATION_FIX"
        private const val EXTRA_REQUEST_ID = "requestId"
        private const val EXTRA_MAX_AGE = "maxAgeMillis"
        private const val EXTRA_EXPIRES_AT = "expiresAtMillis"
        private const val EXTRA_HIGH_ACCURACY = "highAccuracy"
        private const val EXTRA_REASON = "reason"

        fun start(context: Context, request: FcmCommand.RequestLocation) {
            val intent = Intent(context, LocationService::class.java).apply {
                action = ACTION_FIX
                putExtra(EXTRA_REQUEST_ID, request.requestId)
                putExtra(EXTRA_MAX_AGE, request.maxAgeMillis)
                request.expiresAtMillis?.let { putExtra(EXTRA_EXPIRES_AT, it) }
                putExtra(EXTRA_HIGH_ACCURACY, request.highAccuracy)
                request.reason?.let { putExtra(EXTRA_REASON, it) }
            }
            ContextCompat.startForegroundService(context, intent)
        }

        private fun Intent.toRequest(): FcmCommand.RequestLocation? {
            if (action != ACTION_FIX) return null
            val requestId = getStringExtra(EXTRA_REQUEST_ID)?.takeIf { it.isNotBlank() } ?: return null
            return FcmCommand.RequestLocation(
                requestId = requestId,
                maxAgeMillis = getLongExtra(EXTRA_MAX_AGE, OttoConstants.DEFAULT_LOCATION_MAX_AGE_MILLIS),
                expiresAtMillis = if (hasExtra(EXTRA_EXPIRES_AT)) getLongExtra(EXTRA_EXPIRES_AT, 0L) else null,
                highAccuracy = getBooleanExtra(EXTRA_HIGH_ACCURACY, false),
                reason = getStringExtra(EXTRA_REASON),
            )
        }
    }
}
