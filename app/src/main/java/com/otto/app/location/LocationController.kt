package com.otto.app.location

import com.otto.app.core.Clock
import com.otto.app.core.OttoConstants
import com.otto.app.push.FcmCommand
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Answering one REQUEST_LOCATION: refuse, expire, take a fix, report. Never cache.
 *
 * Everything interesting lives here rather than in the service or the worker, behind two interfaces
 * ([LocationProvider], [LocationReporter]) that have hand-written fakes in the tests. The service and
 * the worker are two ways to keep the process alive long enough to call [fulfil]; they must never
 * disagree about what it does.
 *
 * Deliberately free of ANDROID as well as of Play Services and Retrofit — including OttoLog, which
 * reaches `android.util.Log` and throws in a plain JVM test. Every outcome is already carried in the
 * [LocationReport], so the callers do the logging and this stays a class the tests can just call.
 */
@Singleton
class LocationController @Inject constructor(
    private val provider: LocationProvider,
    private val reporter: LocationReporter,
    private val clock: Clock,
) {

    /**
     * @return true when this request is finished with — answered, refused, or expired — and false
     *   only when the ANSWER could not be delivered and is worth another attempt with a fresh fix.
     */
    suspend fun fulfil(request: FcmCommand.RequestLocation): Boolean {
        val now = clock.nowMillis()

        // Expiry first, before any permission check or GPS wake. A request that has sat through a
        // retry chain is answering a question the server stopped waiting on; replying with the
        // present about the past is the one failure worse than not replying, because the server
        // cannot tell the difference. Mirrors NudgeController.show's drop-on-arrival rule.
        val expiresAt = request.expiresAtMillis ?: (now + OttoConstants.LOCATION_REQUEST_TTL_MILLIS)
        if (now > expiresAt) {
            return report(request, LocationStatus.EXPIRED, null, "expired before a fix was taken")
        }

        // Refusals are REPORTED, never silent. The server is composing a reply right now, and "I
        // can't" arriving promptly is what lets Otto say "I don't have location permission, so I've
        // worked it out from home" instead of quietly guessing and sounding certain.
        if (!provider.foregroundPermissionGranted()) {
            return report(request, LocationStatus.PERMISSION_DENIED, null, "location permission not granted")
        }
        if (!provider.backgroundPermissionGranted()) {
            // Separated from PERMISSION_DENIED because it is a different sentence to the owner:
            // they granted something, and the thing they granted cannot answer a push.
            return report(request, LocationStatus.BACKGROUND_DENIED, null, "background location not granted")
        }
        if (!provider.locationEnabled()) {
            return report(request, LocationStatus.LOCATION_DISABLED, null, "location is switched off on the device")
        }

        val fix = provider.currentFix(
            maxAgeMillis = request.maxAgeMillis,
            highAccuracy = request.highAccuracy,
            timeoutMillis = OttoConstants.LOCATION_FIX_TIMEOUT_MILLIS,
        )
        if (fix == null) {
            return report(request, LocationStatus.TIMEOUT, null, "no fix within the timeout")
        }
        return report(request, LocationStatus.OK, fix, null)
    }

    /**
     * A refusal is always "finished with", however the POST went.
     *
     * Retrying a refusal is pointless — the permission will not have changed in thirty seconds — and
     * a retry chain for one would keep the request alive past the moment it mattered, which is
     * exactly what the expiry above exists to prevent.
     */
    private suspend fun report(
        request: FcmCommand.RequestLocation,
        status: LocationStatus,
        fix: LocationFix?,
        detail: String?,
    ): Boolean {
        val delivered = reporter.report(
            LocationReport(
                requestId = request.requestId,
                status = status,
                fix = fix,
                atMillis = clock.nowMillis(),
                detail = detail,
            ),
        )
        return delivered || status != LocationStatus.OK
    }
}
