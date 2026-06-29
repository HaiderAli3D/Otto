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
import com.otto.app.core.OttoLog
import com.otto.app.permissions.PermissionsManager
import com.otto.app.ui.theme.OttoTheme
import dagger.hilt.android.AndroidEntryPoint
import javax.inject.Inject

@AndroidEntryPoint
class MainActivity : ComponentActivity() {

    @Inject lateinit var permissionsManager: PermissionsManager

    private val viewModel: OttoViewModel by viewModels()

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {
            viewModel.refreshPermissions()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
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
                    onArmTest = viewModel::armTestAlarm,
                    onCancelAlarm = viewModel::cancelAlarm,
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // Pick up any permission the user toggled in Settings while we were backgrounded.
        viewModel.refreshPermissions()
    }

    private fun grantNotifications() {
        if (permissionsManager.shouldRequestNotificationsRuntime()) {
            notificationPermissionLauncher.launch(PermissionsManager.POST_NOTIFICATIONS)
        } else {
            startActivitySafely(permissionsManager.appNotificationSettingsIntent())
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
