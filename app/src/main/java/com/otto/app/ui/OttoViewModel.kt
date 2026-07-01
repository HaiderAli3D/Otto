package com.otto.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.google.firebase.messaging.FirebaseMessaging
import com.otto.app.BuildConfig
import com.otto.app.alarm.AlarmController
import com.otto.app.core.Clock
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmEntity
import com.otto.app.data.AlarmRepository
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.net.ServerUrl
import com.otto.app.permissions.PermissionState
import com.otto.app.permissions.PermissionsManager
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

data class OttoUiState(
    val deviceId: String? = null,
    val fcmToken: String? = null,
    val permissions: PermissionState = PermissionState.UNKNOWN,
    val alarms: List<AlarmEntity> = emptyList(),
    val serverBaseUrl: String = BuildConfig.SERVER_BASE_URL,
    val lastRegistrationMillis: Long? = null,
)

@HiltViewModel
class OttoViewModel @Inject constructor(
    private val controller: AlarmController,
    private val repository: AlarmRepository,
    private val preferences: OttoPreferences,
    private val permissionsManager: PermissionsManager,
    private val clock: Clock,
) : ViewModel() {

    // Permissions aren't observable; the Activity re-pushes them on resume.
    private val permissions = MutableStateFlow(permissionsManager.currentState())

    // Grouped so the public combine stays within the 5-arg typed limit.
    private data class Identity(
        val deviceId: String?,
        val token: String?,
        val lastRegistration: Long?,
        val urlOverride: String?,
    )

    private val identity = combine(
        preferences.deviceId,
        preferences.fcmToken,
        preferences.lastRegistrationMillis,
        preferences.serverUrlOverride,
    ) { deviceId, token, lastRegistration, urlOverride ->
        Identity(deviceId, token, lastRegistration, urlOverride)
    }

    val uiState: StateFlow<OttoUiState> = combine(
        identity,
        repository.observeAlarms(),
        permissions,
    ) { id, alarms, perms ->
        OttoUiState(
            deviceId = id.deviceId,
            fcmToken = id.token,
            permissions = perms,
            alarms = alarms,
            serverBaseUrl = ServerUrl.effective(
                id.urlOverride, BuildConfig.SERVER_BASE_URL, BuildConfig.ALLOW_URL_OVERRIDE,
            ),
            lastRegistrationMillis = id.lastRegistration,
        )
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), OttoUiState())

    init {
        refreshToken()
        viewModelScope.launch {
            // Mint the device id eagerly so it shows in the UI and is ready for registration.
            preferences.getOrCreateDeviceId()
            // Force-stop recovery (spec §10): a force-stop clears all scheduled alarms while
            // Room keeps them ARMED. Re-arming on every app open repairs that state.
            try {
                controller.reArmAll()
            } catch (t: Throwable) {
                OttoLog.e("Re-arm on app open failed", t)
            }
        }
    }

    fun refreshPermissions() {
        permissions.value = permissionsManager.currentState()
    }

    fun refreshToken() {
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { token -> viewModelScope.launch { preferences.setFcmToken(token) } }
            .addOnFailureListener { OttoLog.w("Failed to fetch FCM token", it) }
    }

    /** Exercises the full scheduler→receiver→ring path locally, with no push involved. */
    fun armTestAlarm() {
        viewModelScope.launch {
            try {
                val now = clock.nowMillis()
                controller.arm(
                    alarmId = "test_$now",
                    triggerAtMillis = now + TEST_ALARM_DELAY_MILLIS,
                    label = "Test alarm",
                    allowWhileIdle = true,
                )
            } catch (t: Throwable) {
                OttoLog.e("Failed to arm test alarm", t)
            }
        }
    }

    fun cancelAlarm(alarmId: String) {
        viewModelScope.launch {
            try {
                controller.cancel(alarmId)
            } catch (t: Throwable) {
                OttoLog.e("Failed to cancel $alarmId", t)
            }
        }
    }

    private companion object {
        const val TEST_ALARM_DELAY_MILLIS = 60_000L
    }
}
