package com.otto.app.net

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * Signs outbound device→server requests (the `x-otto-*` headers the server verifies). Pure and
 * Android-free so the canonical form is unit-testable against vectors pinned in BOTH repos —
 * this is a cross-repo contract; change it only in lockstep with the server.
 *
 * Canonical string: `METHOD \n pathWithQuery \n tsMillis \n sha256HexOfBodyBytes`, where METHOD
 * is the uppercase HTTP method, pathWithQuery is the URL-encoded path plus `?query` when one
 * exists, and an empty body hashes to SHA-256 of zero bytes. Signature: HMAC-SHA256 over that
 * string, keyed by the pairing secret's UTF-8 bytes (NOT hex-decoded), rendered lowercase hex.
 */
object RequestSigner {

    private const val ALGORITHM = "HmacSHA256"

    /** Lowercase-hex SHA-256 of the exact request body bytes (zero bytes for no body). */
    fun bodySha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).toLowercaseHex()

    fun canonical(method: String, pathWithQuery: String, tsMillis: Long, bodyHashHex: String): String =
        "${method.uppercase()}\n$pathWithQuery\n$tsMillis\n$bodyHashHex"

    fun sign(secret: String, canonical: String): String {
        val mac = Mac.getInstance(ALGORITHM)
        mac.init(SecretKeySpec(secret.toByteArray(Charsets.UTF_8), ALGORITHM))
        return mac.doFinal(canonical.toByteArray(Charsets.UTF_8)).toLowercaseHex()
    }

    // Mask to a byte: "%02x".format(byte) sign-extends a negative Byte to 8 hex digits.
    private fun ByteArray.toLowercaseHex(): String =
        joinToString("") { "%02x".format(it.toInt() and 0xFF) }
}
