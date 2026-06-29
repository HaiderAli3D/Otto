package com.otto.app.data.prefs

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.otto.app.core.OttoLog
import kotlinx.coroutines.flow.firstOrNull
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Stores the shared HMAC secret at rest, encrypted with a hardware-backed AES-GCM key from the
 * Android Keystore — the key never leaves secure hardware and the ciphertext lives in DataStore.
 *
 * CLAUDE.md suggested Tink; we use the Keystore + AES/GCM directly instead: dependency-free,
 * a stable API since API 23, and exactly what Tink wraps. The secret is provisioned at pairing
 * (M5); for M2 it is set from the debug control panel.
 */
@Singleton
class SecretStore @Inject constructor(
    private val preferences: OttoPreferences,
) {
    private fun getOrCreateKey(): SecretKey {
        val keystore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keystore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }

    /** Encrypt and persist [secret]. */
    suspend fun setSecret(secret: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        val packed = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) +
            SEPARATOR + Base64.encodeToString(ciphertext, Base64.NO_WRAP)
        preferences.setHmacSecret(packed)
    }

    /** Decrypt and return the secret, or null if unpaired / undecryptable. */
    suspend fun getSecret(): String? {
        val packed = preferences.hmacSecret.firstOrNull() ?: return null
        return try {
            val parts = packed.split(SEPARATOR, limit = 2)
            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val ciphertext = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (t: Throwable) {
            OttoLog.e("Failed to decrypt HMAC secret", t)
            null
        }
    }

    suspend fun clearSecret() = preferences.setHmacSecret(null)

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "otto_hmac_secret_key"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val SEPARATOR = ":"
        const val GCM_TAG_BITS = 128
    }
}
