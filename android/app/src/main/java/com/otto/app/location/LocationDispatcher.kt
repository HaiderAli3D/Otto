package com.otto.app.location

import android.content.Context
import com.otto.app.core.OttoLog
import com.otto.app.push.FcmCommand
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Decides HOW to stay alive long enough to answer, and is the only place that decision is made.
 *
 * Not inline in `onMessageReceived`: that holds the FCM wakelock only until it returns (~10s), which
 * a GPS lock easily exceeds. This starts something that outlives it and returns — the same hand-off
 * SYNC and PING already use, but with a foreground service because here it is the FIX itself that
 * needs the process kept alive rather than a network call a worker could retry.
 *
 * TWO conditions gate the service, and both are real:
 *
 *  1. **ACCESS_BACKGROUND_LOCATION.** A `location`-typed foreground service started while the app is
 *     backgrounded throws SecurityException without it. High-priority FCM is an exemption to the
 *     background-START restriction (API 31+) but is NOT on the while-in-use exemption list (API
 *     34+), so it opens one gate of two.
 *  2. **The message actually ARRIVED at high priority.** FCM may downgrade a high-priority message
 *     it judges is not being used for time-sensitive user-facing content, and a REQUEST_LOCATION
 *     produces no notification of its own — precisely the profile that gets downgraded. Attempting
 *     the start after a downgrade throws ForegroundServiceStartNotAllowedException.
 *
 * When either fails, the worker path runs the SAME [LocationController.fulfil]. It is slower and
 * Doze can defer it, but it is an answer rather than a crash — and when the refusal is the answer
 * ("I don't have background permission"), the worker delivers it perfectly well.
 */
@Singleton
class LocationDispatcher @Inject constructor(
    @ApplicationContext private val context: Context,
    private val provider: LocationProvider,
) {
    fun dispatch(request: FcmCommand.RequestLocation, canStartForegroundService: Boolean) {
        val serviceViable = canStartForegroundService && provider.backgroundPermissionGranted()
        if (serviceViable) {
            runCatching { LocationService.start(context, request) }
                .onSuccess { return }
                .onFailure { OttoLog.w("Could not start the location service; falling back to a worker", it) }
        } else {
            OttoLog.i(
                "Location service not viable (highPriority=$canStartForegroundService, " +
                    "background=${provider.backgroundPermissionGranted()}); using a worker",
            )
        }
        LocationWorker.enqueue(context, request)
    }
}
