package com.otto.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.otto.app.BuildConfig
import com.otto.app.core.OttoLog
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.data.prefs.SecretStore
import com.otto.app.net.ServerUrl
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

@HiltViewModel
class SettingsViewModel @Inject constructor(
    private val preferences: OttoPreferences,
    private val secretStore: SecretStore,
) : ViewModel() {

    data class SettingsState(
        val deviceId: String? = null,
        val pairingSecretSet: Boolean = false,
        val serverBaseUrl: String = BuildConfig.SERVER_BASE_URL,
        val urlOverridden: Boolean = false,
        val allowUrlOverride: Boolean = BuildConfig.ALLOW_URL_OVERRIDE,
    )

    val state: StateFlow<SettingsState> = combine(
        preferences.deviceId,
        preferences.hmacSecret,
        preferences.serverUrlOverride,
    ) { deviceId, secret, urlOverride ->
        SettingsState(
            deviceId = deviceId,
            pairingSecretSet = !secret.isNullOrBlank(),
            serverBaseUrl = ServerUrl.effective(
                urlOverride, BuildConfig.SERVER_BASE_URL, BuildConfig.ALLOW_URL_OVERRIDE,
            ),
            urlOverridden = urlOverride != null,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), SettingsState())

    /** Pair the device by storing the server-issued shared secret (encrypted at rest). */
    fun setPairingSecret(secret: String) {
        if (secret.isBlank()) return
        viewModelScope.launch {
            try {
                secretStore.setSecret(secret.trim())
            } catch (t: Throwable) {
                OttoLog.e("Failed to store pairing secret", t)
            }
        }
    }

    fun clearPairing() {
        viewModelScope.launch {
            try {
                secretStore.clearSecret()
            } catch (t: Throwable) {
                OttoLog.e("Failed to clear pairing", t)
            }
        }
    }

    fun setServerUrlOverride(url: String?) {
        if (!BuildConfig.ALLOW_URL_OVERRIDE) return
        val cleaned = url?.trim()?.ifBlank { null }
        // Enforce HTTPS on the override (dev tunnels like cloudflared/ngrok are already https); a
        // typo'd http:// host would be blocked by usesCleartextTraffic anyway, so reject it early.
        if (cleaned != null && !cleaned.startsWith("https://")) {
            OttoLog.w("Ignoring non-HTTPS server URL override")
            return
        }
        // Persist with the trailing slash Retrofit's baseUrl() requires, so what's stored is what
        // the network stack uses (ServerUrl.effective would fix it up anyway; keep them agreeing).
        val normalized = if (cleaned == null || cleaned.endsWith("/")) cleaned else "$cleaned/"
        viewModelScope.launch { preferences.setServerUrlOverride(normalized) }
    }
}
