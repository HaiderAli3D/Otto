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
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.otto.app.R
import com.otto.app.alarm.AlarmController
import com.otto.app.core.OttoConstants
import com.otto.app.data.AlarmRepository
import com.otto.app.data.AlarmState
import com.otto.app.ui.theme.OttoTheme
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import javax.inject.Inject

/**
 * The full-screen ring experience (M3). Shows over the lockscreen, turns the screen on, plays
 * the ramped + vibrating alarm via [AlarmRinger], and offers Dismiss and Snooze. Resolving one
 * alarm advances to the next still-RANG alarm (handling simultaneous fires) and only stops the
 * sound when none remain. Room stays the source of truth for every transition.
 */
@AndroidEntryPoint
class RingActivity : ComponentActivity() {

    @Inject lateinit var ringer: AlarmRinger
    @Inject lateinit var repository: AlarmRepository
    @Inject lateinit var controller: AlarmController
    @Inject lateinit var notifications: AlarmNotifications
    @Inject lateinit var appScope: CoroutineScope

    private val display = mutableStateOf(Ringing("", ""))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        configureLockedWindow()

        // Back press dismisses cleanly rather than leaving the alarm stuck RANG.
        onBackPressedDispatcher.addCallback(this) { dismiss() }

        display.value = ringingFromIntent(intent)
        ringer.start()

        setContent {
            OttoTheme {
                val current by display
                RingScreen(label = current.label, onDismiss = ::dismiss, onSnooze = ::snooze)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // singleInstance: a second simultaneous alarm routed its full-screen intent here. Show
        // the newest now; any alarm still RANG is returned to when this one is resolved.
        setIntent(intent)
        display.value = ringingFromIntent(intent)
    }

    private fun ringingFromIntent(intent: Intent) = Ringing(
        alarmId = intent.getStringExtra(OttoConstants.EXTRA_ALARM_ID).orEmpty(),
        label = intent.getStringExtra(EXTRA_LABEL) ?: getString(R.string.ring_default_label),
    )

    private fun dismiss() {
        val id = display.value.alarmId
        appScope.launch(Dispatchers.IO) {
            if (id.isNotEmpty()) {
                notifications.cancel(id)
                repository.markState(id, AlarmState.DISMISSED)
            }
            advanceOrFinish()
        }
    }

    private fun snooze() {
        val id = display.value.alarmId
        appScope.launch(Dispatchers.IO) {
            if (id.isNotEmpty()) {
                notifications.cancel(id)
                controller.snooze(id)
            }
            advanceOrFinish()
        }
    }

    /** Switch to the next still-ringing alarm, or stop the sound and finish when none remain. */
    private suspend fun advanceOrFinish() {
        val next = repository.getRinging().firstOrNull()
        if (next != null) {
            withContext(Dispatchers.Main) { display.value = Ringing(next.alarmId, next.label) }
        } else {
            ringer.stop()
            withContext(Dispatchers.Main) { finish() }
        }
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
        // Auto-dismisses only an insecure keyguard; a secured lockscreen still shows the ring
        // over it (showWhenLocked) without unlocking.
        getSystemService(KeyguardManager::class.java)?.requestDismissKeyguard(this, null)
    }

    override fun onDestroy() {
        super.onDestroy()
        ringer.stop()
    }

    private data class Ringing(val alarmId: String, val label: String)

    companion object {
        const val EXTRA_LABEL = "com.otto.app.extra.LABEL"
    }
}

@Composable
private fun RingScreen(label: String, onDismiss: () -> Unit, onSnooze: () -> Unit) {
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
            Spacer(Modifier.height(16.dp))
            OutlinedButton(
                onClick = onSnooze,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(64.dp),
            ) {
                Text(
                    text = stringResource(R.string.ring_snooze),
                    style = MaterialTheme.typography.titleLarge,
                )
            }
        }
    }
}
