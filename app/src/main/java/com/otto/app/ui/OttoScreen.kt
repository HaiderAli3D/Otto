package com.otto.app.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.otto.app.BuildConfig
import com.otto.app.data.AlarmEntity
import com.otto.app.data.AlarmState
import com.otto.app.permissions.PermissionState
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val GrantedGreen = Color(0xFF2E7D32)

@Composable
fun OttoScreen(
    state: OttoUiState,
    onCopyToken: (String) -> Unit,
    onRefreshToken: () -> Unit,
    onGrantNotifications: () -> Unit,
    onGrantExactAlarm: () -> Unit,
    onGrantFullScreenIntent: () -> Unit,
    onGrantBattery: () -> Unit,
    onArmTest: () -> Unit,
    onCancelAlarm: (String) -> Unit,
    onSetSecret: (String) -> Unit,
    onClearSecret: () -> Unit,
) {
    val formatter = remember { SimpleDateFormat("MMM d · HH:mm:ss", Locale.getDefault()) }

    Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Otto control panel", style = MaterialTheme.typography.headlineSmall)

            SectionCard("Test") {
                Text(
                    "Arm an alarm 60 seconds from now and lock the screen to verify the full ring path.",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Button(onClick = onArmTest, modifier = Modifier.fillMaxWidth()) {
                    Text("Arm test alarm (+60s)")
                }
            }

            SectionCard("Device") {
                Text("Device ID", style = MaterialTheme.typography.labelMedium)
                SelectionContainer {
                    Text(
                        text = state.deviceId ?: "Generating…",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                Text("FCM token", style = MaterialTheme.typography.labelMedium)
                SelectionContainer {
                    Text(
                        text = state.fcmToken ?: "Fetching…",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        maxLines = 4,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { state.fcmToken?.let(onCopyToken) },
                        enabled = state.fcmToken != null,
                    ) { Text("Copy") }
                    OutlinedButton(onClick = onRefreshToken) { Text("Refresh") }
                }
                Text(
                    "Server: ${state.serverBaseUrl}",
                    style = MaterialTheme.typography.bodySmall,
                )
                state.lastRegistrationMillis?.let {
                    Text(
                        "Last registered: ${formatter.format(Date(it))}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }

            if (BuildConfig.ALLOW_URL_OVERRIDE) {
                SectionCard("Pairing (debug)") {
                    Text(
                        if (state.pairingSecretSet) {
                            "Shared secret set — inbound commands are HMAC-verified."
                        } else {
                            "No shared secret — inbound commands are accepted unverified."
                        },
                        style = MaterialTheme.typography.bodySmall,
                    )
                    var secret by remember { mutableStateOf("") }
                    OutlinedTextField(
                        value = secret,
                        onValueChange = { secret = it },
                        label = { Text("Shared secret") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { onSetSecret(secret); secret = "" },
                            enabled = secret.isNotBlank(),
                        ) { Text("Save secret") }
                        OutlinedButton(onClick = onClearSecret, enabled = state.pairingSecretSet) {
                            Text("Clear")
                        }
                    }
                }
            }

            SectionCard("Permissions") {
                PermissionRow("Notifications", state.permissions.notificationsGranted, onGrantNotifications)
                PermissionRow("Exact alarms", state.permissions.exactAlarmGranted, onGrantExactAlarm)
                PermissionRow("Full-screen intent", state.permissions.fullScreenIntentGranted, onGrantFullScreenIntent)
                PermissionRow("Battery exemption", state.permissions.batteryExemptionGranted, onGrantBattery)
            }

            SectionCard("Reliability") {
                Text(
                    "Don't use \"Force stop\" on Otto in Android Settings. A force-stop cancels " +
                        "every scheduled alarm and pauses push until you reopen the app. If it " +
                        "happens, just open Otto again — armed alarms are restored automatically.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            SectionCard("Armed alarms") {
                if (state.alarms.isEmpty()) {
                    Text("No alarms yet.", style = MaterialTheme.typography.bodyMedium)
                } else {
                    state.alarms.forEach { alarm ->
                        AlarmRow(alarm, formatter.format(Date(alarm.triggerAtMillis)), onCancelAlarm)
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun PermissionRow(name: String, granted: Boolean, onGrant: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyLarge)
            Text(
                text = if (granted) "Granted" else "Missing",
                style = MaterialTheme.typography.bodySmall,
                color = if (granted) GrantedGreen else MaterialTheme.colorScheme.error,
            )
        }
        if (!granted) {
            Button(onClick = onGrant) { Text("Grant") }
        }
    }
}

@Composable
private fun AlarmRow(alarm: AlarmEntity, formattedTime: String, onCancel: (String) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(alarm.label, style = MaterialTheme.typography.bodyLarge)
            Text(
                "$formattedTime · ${alarm.state}",
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (alarm.state == AlarmState.ARMED) {
            TextButton(onClick = { onCancel(alarm.alarmId) }) { Text("Cancel") }
        }
    }
}
