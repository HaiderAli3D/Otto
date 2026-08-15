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
import com.otto.app.data.NudgeEntity
import com.otto.app.data.NudgeRepository
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.net.ServerUrl
import com.otto.app.nudge.NudgeAction
import com.otto.app.nudge.NudgeController
import com.otto.app.nudge.NudgeLevel
import com.otto.app.push.FcmCommand
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
    /** Nudges not yet finished with — the only place to see what was missed while face-down. */
    val nudges: List<NudgeEntity> = emptyList(),
    val serverBaseUrl: String = BuildConfig.SERVER_BASE_URL,
    val lastRegistrationMillis: Long? = null,
)

@HiltViewModel
class OttoViewModel @Inject constructor(
    private val controller: AlarmController,
    private val repository: AlarmRepository,
    private val nudgeController: NudgeController,
    private val nudgeRepository: NudgeRepository,
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
        nudgeRepository.observeLive(),
        permissions,
    ) { id, alarms, nudges, perms ->
        OttoUiState(
            deviceId = id.deviceId,
            fcmToken = id.token,
            permissions = perms,
            alarms = alarms,
            nudges = nudges,
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

    /**
     * Exercises the whole nudge path locally — Room, the notification, the buttons — with no server
     * and no push involved. Cycles the level so all three channels can be checked in three taps,
     * which is what makes the on-device test matrix runnable at all.
     */
    fun sendTestNudge() {
        viewModelScope.launch {
            try {
                val level = NudgeLevel.entries[testNudgeLevel++ % NudgeLevel.entries.size]
                nudgeController.show(
                    FcmCommand.Nudge(
                        nudgeId = "test_nudge",
                        title = "Test nudge · $level",
                        body = "This is what a $level nudge looks like. Done and Snooze both work.",
                        level = level,
                        actions = NudgeAction.DEFAULT,
                        snoozeMinutes = 1,
                        expiresAtMillis = null,
                        ongoing = false,
                    ),
                )
            } catch (t: Throwable) {
                OttoLog.e("Failed to show the test nudge", t)
            }
        }
    }

    /** Act on a nudge from the in-app list. Goes through the same funnel the lockscreen does. */
    fun actOnNudge(nudgeId: String, action: NudgeAction) {
        viewModelScope.launch {
            try {
                nudgeController.act(nudgeId, action)
            } catch (t: Throwable) {
                OttoLog.e("Failed to act on nudge $nudgeId", t)
            }
        }
    }

    private var testNudgeLevel = 0

    private companion object {
        const val TEST_ALARM_DELAY_MILLIS = 60_000L
    }
}
