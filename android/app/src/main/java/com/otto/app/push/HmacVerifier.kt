package com.otto.app.push

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Verifies the integrity `sig` on an inbound FCM payload (spec.md §7.3). Pure and Android-free
 * so it is fully unit-testable and the canonical form is auditable.
 *
 * Canonical form (must match the server and the /tools/send-push helper): every `data` field
 * **except** `sig`, sorted by key, joined as `key=value` with `&`, then HMAC-SHA256 with the
 * shared secret, rendered lowercase hex.
 */
object HmacVerifier {

    private const val SIG_FIELD = "sig"
    private const val ALGORITHM = "HmacSHA256"

    fun canonical(data: Map<String, String>): String =
        data.filterKeys { it != SIG_FIELD }
            .toSortedMap()
            .entries.joinToString("&") { "${it.key}=${it.value}" }

    fun compute(data: Map<String, String>, secret: String): String {
        val mac = Mac.getInstance(ALGORITHM)
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), ALGORITHM))
        // Mask to a byte: "%02x".format(byte) sign-extends a negative Byte to 8 hex digits.
        return mac.doFinal(canonical(data).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 0xFF) }
    }

    /** True iff [data] carries a `sig` matching [secret]. Constant-time compare. */
    fun verify(data: Map<String, String>, secret: String): Boolean {
        val provided = data[SIG_FIELD] ?: return false
        return MessageDigest.isEqual(
            provided.toByteArray(Charsets.UTF_8),
            compute(data, secret).toByteArray(Charsets.UTF_8),
        )
    }
}
