package com.otto.app.ring

import android.app.KeyguardManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.otto.app.R
import com.otto.app.core.OttoConstants
import com.otto.app.data.AlarmRepository
import com.otto.app.data.AlarmState
import com.otto.app.ui.theme.OttoTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * The full-screen ring experience. Shows over the lockscreen, turns the screen on, plays
 * the alarm via [AlarmRinger], and offers a single dismiss control. Dismissing stops the
 * sound, cancels the notification, and records DISMISSED in Room (the source of truth).
 */
@AndroidEntryPoint
class RingActivity : ComponentActivity() {

    @Inject lateinit var ringer: AlarmRinger
    @Inject lateinit var repository: AlarmRepository
    @Inject lateinit var notifications: AlarmNotifications
    @Inject lateinit var appScope: CoroutineScope

    private var alarmId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureLockedWindow()

        // Back press resolves the alarm cleanly (stop, cancel the notification, mark
        // DISMISSED) rather than leaving it stuck RANG with a pinned ongoing notification.
        onBackPressedDispatcher.addCallback(this) { dismiss() }

        alarmId = intent.getStringExtra(OttoConstants.EXTRA_ALARM_ID)
        val label = intent.getStringExtra(EXTRA_LABEL) ?: getString(R.string.ring_default_label)

        ringer.start()

        setContent {
            OttoTheme {
                RingScreen(label = label, onDismiss = ::dismiss)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleInstance: another fire is routed here; adopt the new intent's extras.
        // NOTE (M3): proper handling of simultaneous alarms — resolving the previous one and
        // updating the displayed label — is deferred to the M3 ring experience (spec §13).
        setIntent(intent)
        alarmId = intent.getStringExtra(OttoConstants.EXTRA_ALARM_ID)
    }

    private fun configureLockedWindow() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                    WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        // Auto-dismisses only an insecure keyguard; a secured lockscreen still shows the
        // ring over it (showWhenLocked) without unlocking.
        getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
    }

    private fun dismiss() {
        ringer.stop()
        alarmId?.let { id ->
            notifications.cancel(id)
            appScope.launch(Dispatchers.IO) { repository.markState(id, AlarmState.DISMISSED) }
        }
        finish()
    }

    override fun onDestroy() {
        super.onDestroy()
        ringer.stop()
    }

    companion object {
        const val EXTRA_LABEL = "com.otto.app.extra.LABEL"
    }
}

@Composable
private fun RingScreen(label: String, onDismiss: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Text(
                text = stringResource(R.string.ring_notification_title),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.secondary,
            )
            Spacer(Modifier.height(16.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.headlineLarge,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(56.dp))
            Button(
                onClick = onDismiss,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(64.dp),
            ) {
                Text(
                    text = stringResource(R.string.ring_dismiss),
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        }
    }
}
