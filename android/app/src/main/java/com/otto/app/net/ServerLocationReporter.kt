package com.otto.app.net

import com.otto.app.BuildConfig
import com.otto.app.core.OttoLog
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.location.LocationReport
import com.otto.app.location.LocationReporter
import java.io.IOException
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Posts one location answer, once.
 *
 * Signing and the placeholder no-op both come free: [DeviceAuthInterceptor] is on the single shared
 * OkHttp client and is generic over method + path + body, so a new route needs no signing code at
 * all, and [OttoApiFactory.currentApiOrNull] returns null while the URL is the `otto.invalid`
 * placeholder.
 *
 * That placeholder case returns TRUE — treat as delivered — mirroring [HeartbeatWorker]'s
 * `Result.success()` on the same condition, so an unpaired phone never builds up a retry loop
 * against a server that does not exist.
 */
@Singleton
class ServerLocationReporter @Inject constructor(
    private val apiFactory: OttoApiFactory,
    private val preferences: OttoPreferences,
) : LocationReporter {

    override suspend fun report(report: LocationReport): Boolean {
        val api = apiFactory.currentApiOrNull() ?: run {
            OttoLog.i("Server URL is the placeholder; dropping location report")
            return true
        }
        return try {
            val response = api.reportLocation(
                deviceId = preferences.getOrCreateDeviceId(),
                body = LocationReportRequest(
                    requestId = report.requestId,
                    status = report.status.wire,
                    latitude = report.fix?.latitude,
                    longitude = report.fix?.longitude,
                    accuracyMeters = report.fix?.accuracyMeters,
                    capturedAtMillis = report.fix?.capturedAtMillis,
                    atMillis = report.atMillis,
                    isMock = report.fix?.isMock,
                    appVersion = BuildConfig.VERSION_NAME,
                    detail = report.detail,
                ),
            )
            if (response.isSuccessful) {
                true
            } else {
                // Deliberately NOT logging the report itself: OttoLog forwards warnings to
                // Crashlytics, and a coordinate has no business in a crash breadcrumb.
                OttoLog.w("Location report failed: HTTP ${response.code()}")
                false
            }
        } catch (io: IOException) {
            OttoLog.w("Location report network error", io)
            false
        } catch (t: Throwable) {
            OttoLog.e("Location report error", t)
            false
        }
    }
}
