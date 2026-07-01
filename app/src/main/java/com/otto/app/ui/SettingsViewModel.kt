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
        viewModelScope.launch { preferences.setServerUrlOverride(url?.ifBlank { null }) }
    }
}
