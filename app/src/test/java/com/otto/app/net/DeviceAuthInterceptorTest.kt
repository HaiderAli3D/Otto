package com.otto.app.net

import com.otto.app.core.Clock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Drives the interceptor through a real OkHttpClient whose next application interceptor
 * short-circuits with a canned response — no server, no Android — via the suspend-provider
 * constructor. The signed cases reuse the pinned cross-repo vectors from [RequestSignerTest],
 * proving the interceptor derives method/path/ts/body-hash correctly.
 */
class DeviceAuthInterceptorTest {

    private class FixedClock(private val now: Long) : Clock {
        override fun nowMillis(): Long = now
    }

    private val ts = 1751500000000L

    private fun interceptor(secret: String?) = DeviceAuthInterceptor(
        secretProvider = { secret },
        deviceIdProvider = { "dev_test" },
        clock = FixedClock(ts),
    )

    /** Executes [request] through [auth] and returns the request as the next interceptor saw it. */
    private fun sendThrough(auth: DeviceAuthInterceptor, request: Request): Request {
        var seen: Request? = null
        val client = OkHttpClient.Builder()
            .addInterceptor(auth)
            .addInterceptor { chain ->
                seen = chain.request()
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(200)
                    .message("OK")
                    .body("".toResponseBody())
                    .build()
            }
            .build()
        client.newCall(request).execute().close()
        return seen!!
    }

    @Test
    fun noSecret_passesRequestThroughUnmodified() {
        val sent = sendThrough(
            interceptor(secret = null),
            Request.Builder().url("https://otto.example/devices/dev_test/alarms").build(),
        )
        assertNull(sent.header(DeviceAuthInterceptor.HEADER_DEVICE_ID))
        assertNull(sent.header(DeviceAuthInterceptor.HEADER_TS))
        assertNull(sent.header(DeviceAuthInterceptor.HEADER_SIG))
    }

    @Test
    fun withSecret_postBody_signsToVector1() {
        val body = """{"appVersion":"1.0.0","atMillis":1751500000000}"""
            .toRequestBody("application/json".toMediaType())
        val sent = sendThrough(
            interceptor(secret = "s3cr3t"),
            Request.Builder().url("https://otto.example/devices/dev_test/heartbeat").post(body).build(),
        )
        assertEquals("dev_test", sent.header(DeviceAuthInterceptor.HEADER_DEVICE_ID))
        assertEquals("1751500000000", sent.header(DeviceAuthInterceptor.HEADER_TS))
        assertEquals(
            "06d89492c040004727bd8167d79e5014651710488f8aa401bbd1370d862bd711",
            sent.header(DeviceAuthInterceptor.HEADER_SIG),
        )
    }

    @Test
    fun withSecret_getEmptyBody_signsToVector2() {
        val sent = sendThrough(
            interceptor(secret = "s3cr3t"),
            Request.Builder().url("https://otto.example/devices/dev_test/alarms").build(),
        )
        assertEquals(
            "e24f5b661348e1b025493a3b75dc8031d9237963aafe25733e545657d77719ab",
            sent.header(DeviceAuthInterceptor.HEADER_SIG),
        )
    }
}
