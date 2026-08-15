package com.otto.app.net

import com.otto.app.core.Clock
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.data.prefs.SecretStore
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response
import okio.Buffer
import javax.inject.Inject

/**
 * Adds the device-auth headers (`x-otto-device-id`, `x-otto-ts`, `x-otto-sig`) to every outbound
 * request; the server verifies them on the device endpoints once the device has ever signed
 * (spec.md §7.4 / [RequestSigner] for the canonical form). While unpaired there is no secret to
 * sign with, so requests go out unmodified — the server allows unsigned traffic until the first
 * valid signature (bootstrap), then fails closed.
 *
 * The primary constructor takes plain suspend providers so this is JVM-testable with hand-written
 * fakes ([SecretStore]/[OttoPreferences] are Keystore/DataStore-bound); Hilt uses the @Inject one.
 */
class DeviceAuthInterceptor(
    private val secretProvider: suspend () -> String?,
    private val deviceIdProvider: suspend () -> String,
    private val clock: Clock,
) : Interceptor {

    @Inject constructor(
        secretStore: SecretStore,
        preferences: OttoPreferences,
        clock: Clock,
    ) : this(
        secretProvider = { secretStore.getSecret() },
        deviceIdProvider = { preferences.getOrCreateDeviceId() },
        clock = clock,
    )

    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        // intercept() is synchronous and runs on OkHttp's own dispatcher threads, so blocking on
        // the suspend DataStore/Keystore reads here is acceptable.
        val secret = runBlocking { secretProvider() }
            ?: return chain.proceed(request) // unpaired bootstrap: server accepts unsigned
        val deviceId = runBlocking { deviceIdProvider() }

        val bodyBytes = request.body
            ?.let { body -> Buffer().also { body.writeTo(it) }.readByteArray() }
            ?: ByteArray(0)
        val pathWithQuery = request.url.encodedPath +
            (request.url.encodedQuery?.let { "?$it" } ?: "")
        val tsMillis = clock.nowMillis()
        val canonical = RequestSigner.canonical(
            method = request.method,
            pathWithQuery = pathWithQuery,
            tsMillis = tsMillis,
            bodyHashHex = RequestSigner.bodySha256Hex(bodyBytes),
        )
        return chain.proceed(
            request.newBuilder()
                .header(HEADER_DEVICE_ID, deviceId)
                .header(HEADER_TS, tsMillis.toString())
                .header(HEADER_SIG, RequestSigner.sign(secret, canonical))
                .build(),
        )
    }

    companion object {
        const val HEADER_DEVICE_ID = "x-otto-device-id"
        const val HEADER_TS = "x-otto-ts"
        const val HEADER_SIG = "x-otto-sig"
    }
}
