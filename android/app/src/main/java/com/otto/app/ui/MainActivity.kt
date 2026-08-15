package com.otto.app.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import com.otto.app.core.OttoLog
import com.otto.app.data.prefs.OttoPreferences
import com.otto.app.net.HeartbeatWorker
import com.otto.app.net.RegistrationWorker
import com.otto.app.net.SyncWorker
import com.otto.app.permissions.PermissionsManager
import com.otto.app.ui.theme.OttoTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var permissionsManager: PermissionsManager
    @Inject lateinit var preferences: OttoPreferences

    private val viewModel: OttoViewModel by viewModels()

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            viewModel.refreshPermissions()
        }

    /**
     * The FIRST half of the location grant. Both foreground permissions in one call, never with
     * the background one alongside it — requesting a foreground and the background permission
     * together makes the system ignore the request and grant neither.
     */
    private val locationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            viewModel.refreshPermissions()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Best-effort (re)registration on launch; the worker no-ops on the placeholder URL
        // and retries with backoff when a real server is configured.
        RegistrationWorker.enqueue(this)
        // Reconcile with the server on open (also part of force-stop recovery).
        SyncWorker.enqueue(this)
        // Report a heartbeat on app open as well as on PING (spec.md §7.4). No-ops on placeholder URL.
        HeartbeatWorker.enqueue(this)
        // Prompt once (spec §9) to exempt the app from battery optimisation so alarms fire in Doze.
        maybePromptBatteryExemption()
        setContent {
            OttoTheme {
                val state by viewModel.uiState.collectAsStateWithLifecycle()
                OttoScreen(
                    state = state,
                    onCopyToken = ::copyToken,
                    onRefreshToken = viewModel::refreshToken,
                    onGrantNotifications = ::grantNotifications,
                    onGrantExactAlarm = { startActivitySafely(permissionsManager.exactAlarmSettingsIntent()) },
                    onGrantFullScreenIntent = { startActivitySafely(permissionsManager.fullScreenIntentSettingsIntent()) },
                    onGrantBattery = { startActivitySafely(permissionsManager.batteryExemptionIntent()) },
                    onGrantLocation = ::grantLocation,
                    onArmTest = viewModel::armTestAlarm,
                    onCancelAlarm = viewModel::cancelAlarm,
                    onOpenSettings = { startActivitySafely(Intent(this, SettingsActivity::class.java)) },
                    onSendHeartbeat = { HeartbeatWorker.enqueue(this) },
                    onSendTestNudge = viewModel::sendTestNudge,
                    onNudgeAction = viewModel::actOnNudge,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Pick up any permission the user toggled in Settings while we were backgrounded.
        viewModel.refreshPermissions()
    }

    /**
     * Spec §9: on first launch, if not already exempt, fire the battery-optimisation exemption
     * request once and latch the flag so we never auto-prompt again. If already exempt (e.g. an
     * OEM default) we just latch the flag. The intent is guarded because some OEMs lack the
     * activity; on failure we fall back silently to the passive permissions-panel row.
     */
    private fun maybePromptBatteryExemption() {
        lifecycleScope.launch {
            if (preferences.batteryPromptShown.first()) return@launch
            // Latch first so a config change/crash mid-flow can't turn this into a prompt loop.
            preferences.setBatteryPromptShown(true)
            if (permissionsManager.batteryExemptionGranted()) return@launch
            try {
                startActivity(permissionsManager.batteryExemptionIntent())
            } catch (t: Throwable) {
                OttoLog.w("Battery-exemption prompt unavailable; using passive panel row", t)
            }
        }
    }

    private fun grantNotifications() {
        if (permissionsManager.shouldRequestNotificationsRuntime()) {
            notificationPermissionLauncher.launch(PermissionsManager.POST_NOTIFICATIONS)
        } else {
            startActivitySafely(permissionsManager.appNotificationSettingsIntent())
        }
    }

    /**
     * Location, in the two steps the platform insists on.
     *
     * Foreground first, because asking for both at once grants neither. Then "Allow all the time",
     * which from API 30 has no dialog at all — the owner has to set it on the app's settings page,
     * so the second step is a deep link rather than a second request.
     *
     * Only "Allow all the time" can answer a push arriving with the screen off, so stopping after
     * step one leaves the feature looking granted and answering BACKGROUND_DENIED every time.
     */
    private fun grantLocation() {
        if (!permissionsManager.locationGranted()) {
            locationPermissionLauncher.launch(PermissionsManager.FOREGROUND_LOCATION)
        } else {
            startActivitySafely(permissionsManager.locationSettingsIntent())
        }
    }

    private fun copyToken(token: String) {
        getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("FCM token", token))
        Toast.makeText(this, "Token copied", Toast.LENGTH_SHORT).show()
    }

    private fun startActivitySafely(intent: Intent) {
        try {
            startActivity(intent)
        } catch (t: Throwable) {
            OttoLog.w("No activity found for $intent", t)
            Toast.makeText(this, "Couldn't open settings", Toast.LENGTH_SHORT).show()
        }
    }
}
