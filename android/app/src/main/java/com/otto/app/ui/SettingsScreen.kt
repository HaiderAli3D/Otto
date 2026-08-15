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
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

@Composable
fun SettingsScreen(
    state: SettingsViewModel.SettingsState,
    onBack: () -> Unit,
    onSetSecret: (String) -> Unit,
    onClearPairing: () -> Unit,
    onSetServerUrl: (String?) -> Unit,
) {
    Scaffold(modifier = Modifier.fillMaxSize()) { innerPadding ->
        Column(
            modifier = Modifier
                .padding(innerPadding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            TextButton(onClick = onBack) { Text("← Back") }
            Text("Settings", style = MaterialTheme.typography.headlineSmall)

            SettingsCard("Pairing") {
                Text("Device ID", style = MaterialTheme.typography.labelMedium)
                SelectionContainer {
                    Text(
                        text = state.deviceId ?: "Generating…",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
                Text(
                    if (state.pairingSecretSet) {
                        "Paired — inbound commands are HMAC-verified."
                    } else {
                        "Not paired — inbound commands are accepted unverified."
                    },
                    style = MaterialTheme.typography.bodySmall,
                )
                var secret by remember { mutableStateOf("") }
                OutlinedTextField(
                    value = secret,
                    onValueChange = { secret = it },
                    label = { Text("Shared secret from server") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { onSetSecret(secret); secret = "" },
                        enabled = secret.isNotBlank(),
                    ) { Text("Pair") }
                    OutlinedButton(onClick = onClearPairing, enabled = state.pairingSecretSet) {
                        Text("Unpair")
                    }
                }
            }

            if (state.allowUrlOverride) {
                SettingsCard("Server (debug)") {
                    Text(
                        "Base URL: ${state.serverBaseUrl}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    var url by remember { mutableStateOf("") }
                    OutlinedTextField(
                        value = url,
                        onValueChange = { url = it },
                        label = { Text("Override base URL (https://…)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(
                            onClick = { onSetServerUrl(url); url = "" },
                            enabled = url.isNotBlank(),
                        ) { Text("Save") }
                        OutlinedButton(
                            onClick = { onSetServerUrl(null) },
                            enabled = state.urlOverridden,
                        ) { Text("Reset") }
                    }
                }
            }
        }
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
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
