package com.otto.app.location

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import com.otto.app.core.Clock
import com.otto.app.core.OttoLog
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import javax.inject.Inject
import javax.inject.Singleton
import kotlin.coroutines.resume

/**
 * One position, on request.
 *
 * An interface for the same reason [com.otto.app.core.ReportTrigger] is one: it keeps
 * [LocationController] free of Play Services so the interesting logic — refuse, expire, report,
 * never cache — is plain JVM code testable behind a hand-written fake. The project prefers
 * hand-written fakes to mocking libraries, and this is the seam that makes one possible.
 */
interface LocationProvider {
    /** True when the app may read location AT ALL. */
    fun foregroundPermissionGranted(): Boolean

    /** True when it may do so from the background, which is the only case that matters here. */
    fun backgroundPermissionGranted(): Boolean

    /** True when location is switched on device-wide. Distinct from "we are not allowed". */
    fun locationEnabled(): Boolean

    /**
     * A fix no older than [maxAgeMillis], or null.
     *
     * Null means "could not get one", never "they are nowhere" — the caller reports TIMEOUT or
     * UNAVAILABLE rather than inventing a position.
     */
    suspend fun currentFix(maxAgeMillis: Long, highAccuracy: Boolean, timeoutMillis: Long): LocationFix?
}

@Singleton
class FusedLocationProvider @Inject constructor(
    @ApplicationContext private val context: Context,
    private val clock: Clock,
) : LocationProvider {

    private val client by lazy { LocationServices.getFusedLocationProviderClient(context) }

    override fun foregroundPermissionGranted(): Boolean =
        granted(Manifest.permission.ACCESS_COARSE_LOCATION) || granted(Manifest.permission.ACCESS_FINE_LOCATION)

    override fun backgroundPermissionGranted(): Boolean {
        // The permission only exists from API 29. Below it, holding the foreground one IS background
        // access — returning false there would report a refusal the owner could not act on.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return foregroundPermissionGranted()
        return granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
    }

    override fun locationEnabled(): Boolean =
        runCatching {
            val manager = context.getSystemService(LocationManager::class.java)
            manager != null && LocationManagerCompatIsEnabled(manager)
        }.getOrDefault(false)

    @SuppressLint("MissingPermission") // guarded by foregroundPermissionGranted() on every path
    override suspend fun currentFix(maxAgeMillis: Long, highAccuracy: Boolean, timeoutMillis: Long): LocationFix? {
        if (!foregroundPermissionGranted()) return null

        // A cached fix that is still fresh is the cheapest correct answer: no GPS wake, no battery,
        // no seconds of latency inside a conversation the owner is waiting on. Only if it is too old
        // do we go and get one.
        val cached = runCatching { awaitTask { client.lastLocation } }.getOrNull()
        if (cached != null && clock.nowMillis() - cached.time <= maxAgeMillis) return cached.toFix()

        val priority = if (highAccuracy) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY
        val tokenSource = CancellationTokenSource()
        return try {
            // withTimeoutOrNull rather than trusting the provider to give up: a device with no fix
            // and no cell signal can leave getCurrentLocation pending indefinitely, and this runs
            // inside a foreground service the owner can see.
            withTimeoutOrNull(timeoutMillis) {
                awaitTask { client.getCurrentLocation(priority, tokenSource.token) }?.toFix()
            }
        } catch (t: Throwable) {
            OttoLog.w("Location: could not take a fix", t)
            null
        } finally {
            tokenSource.cancel()
        }
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    /**
     * Await a Play Services Task without pulling in kotlinx-coroutines-play-services.
     *
     * One small function against one extra dependency on the release graph, in an app whose gradle
     * pins are already load-bearing for staying on compileSdk 36.
     */
    private suspend fun <T> awaitTask(start: () -> com.google.android.gms.tasks.Task<T>): T? =
        suspendCancellableCoroutine { continuation ->
            start()
                .addOnSuccessListener { if (continuation.isActive) continuation.resume(it) }
                .addOnFailureListener {
                    OttoLog.w("Location: task failed", it)
                    if (continuation.isActive) continuation.resume(null)
                }
                .addOnCanceledListener { if (continuation.isActive) continuation.resume(null) }
        }

    private fun Location.toFix(): LocationFix = LocationFix(
        latitude = latitude,
        longitude = longitude,
        accuracyMeters = if (hasAccuracy()) accuracy else null,
        // The time the FIX was taken, not now. The server judges staleness on this.
        capturedAtMillis = time,
        isMock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) isMock else @Suppress("DEPRECATION") isFromMockProvider,
    )

    /** `LocationManagerCompat.isLocationEnabled` without the extra artifact. */
    private fun LocationManagerCompatIsEnabled(manager: LocationManager): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            manager.isLocationEnabled
        } else {
            @Suppress("DEPRECATION")
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
                manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
        }
}
