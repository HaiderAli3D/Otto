package com.otto.app.push

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HmacVerifierTest {

    // The fields that produced the cross-checked vector below (node + openssl agree on it).
    private val data = mapOf(
        "v" to "1",
        "type" to "ARM_ALARM",
        "alarmId" to "alm_demo",
        "triggerAtMillis" to "FIXED",
        "label" to "Email Teal",
        "allowWhileIdle" to "true",
    )
    private val secret = "s3cr3t"

    @Test
    fun computesKnownVector() {
        // Contract test: this exact value is produced by tools/send-push (node Object.keys.sort)
        // and by `openssl dgst -sha256 -hmac` over the canonical form. Keys sort lexicographically,
        // so alarmId precedes allowWhileIdle ('a' < 'l' at index 2) — the agreement is the point.
        assertEquals(
            "22ad59bfda272fb03eebb637ec7a20535f562fdde59e7e0c05e28c72afd901a2",
            HmacVerifier.compute(data, secret),
        )
    }

    @Test
    fun canonicalExcludesSigAndSortsByKey() {
        assertEquals("a=1&b=2", HmacVerifier.canonical(mapOf("b" to "2", "a" to "1", "sig" to "x")))
    }

    @Test
    fun verifyAcceptsMatchingSig() {
        val signed = data + ("sig" to HmacVerifier.compute(data, secret))
        assertTrue(HmacVerifier.verify(signed, secret))
    }

    @Test
    fun verifyRejectsTamperedSig() {
        assertFalse(HmacVerifier.verify(data + ("sig" to "deadbeef"), secret))
    }

    @Test
    fun verifyRejectsMissingSig() {
        assertFalse(HmacVerifier.verify(data, secret))
    }

    @Test
    fun verifyRejectsWrongSecret() {
        val signed = data + ("sig" to HmacVerifier.compute(data, secret))
        assertFalse(HmacVerifier.verify(signed, "different"))
    }
}
