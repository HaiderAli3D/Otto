package com.otto.app.net

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The vectors here are pinned in the Otto server's test suite too — a cross-repo contract lock.
 * If an implementation change breaks one of these, the implementation is wrong, not the vector.
 */
class RequestSignerTest {

    private val secret = "s3cr3t"
    private val ts = 1751500000000L
    private val emptyBodyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    @Test
    fun emptyBody_hashesToTheEmptySha256() {
        assertEquals(emptyBodyHash, RequestSigner.bodySha256Hex(ByteArray(0)))
    }

    @Test
    fun canonical_assemblesWithNewlineSeparators() {
        assertEquals(
            "POST\n/devices/dev_test/heartbeat\n1751500000000\nabc123",
            RequestSigner.canonical("POST", "/devices/dev_test/heartbeat", ts, "abc123"),
        )
    }

    @Test
    fun vector1_postWithBody_signsToPinnedHex() {
        val body = """{"appVersion":"1.0.0","atMillis":1751500000000}""".toByteArray(Charsets.UTF_8)
        val bodyHash = RequestSigner.bodySha256Hex(body)
        assertEquals("7beb24e8b0e0d74cb8d1eba8c480b59720f90367c36eb940e7d6467816f0ee40", bodyHash)

        val canonical = RequestSigner.canonical("POST", "/devices/dev_test/heartbeat", ts, bodyHash)
        assertEquals(
            "06d89492c040004727bd8167d79e5014651710488f8aa401bbd1370d862bd711",
            RequestSigner.sign(secret, canonical),
        )
    }

    @Test
    fun vector2_getWithEmptyBody_signsToPinnedHex() {
        val canonical = RequestSigner.canonical("GET", "/devices/dev_test/alarms", ts, emptyBodyHash)
        assertEquals(
            "e24f5b661348e1b025493a3b75dc8031d9237963aafe25733e545657d77719ab",
            RequestSigner.sign(secret, canonical),
        )
    }
}
