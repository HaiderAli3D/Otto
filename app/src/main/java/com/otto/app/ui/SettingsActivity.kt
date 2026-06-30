package com.otto.app.ui

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.otto.app.ui.theme.OttoTheme
import dagger.hilt.android.AndroidEntryPoint

/** Settings / pairing screen (M5), launched from the control panel. */
@AndroidEntryPoint
class SettingsActivity : ComponentActivity() {

    private val viewModel: SettingsViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            OttoTheme {
                val state by viewModel.state.collectAsStateWithLifecycle()
                SettingsScreen(
                    state = state,
                    onBack = ::finish,
                    onSetSecret = viewModel::setPairingSecret,
                    onClearPairing = viewModel::clearPairing,
                    onSetServerUrl = viewModel::setServerUrlOverride,
                )
            }
        }
    }
}
