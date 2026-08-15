package com.otto.app.ring

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.otto.app.core.OttoConstants
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Foreground service that backs the ring so the alarm keeps sounding even if [RingActivity] is
 * destroyed (swiped away, low memory). It owns the [AlarmRinger] and shows one ongoing
 * full-screen notification for the currently-ringing alarm, and stops itself once no alarm is
 * RANG. Started best-effort from [com.otto.app.alarm.AlarmReceiver] (exact-alarm FGS exemption)
 * and re-asserted from the foreground Activity, so at least one start always succeeds.
 */
@AndroidEntryPoint
class RingService : Service() {

    @Inject lateinit var ringer: AlarmRinger
    @Inject lateinit var notifications: AlarmNotifications
    @Inject lateinit var repository: AlarmRepository
    @Inject lateinit var appScope: CoroutineScope

    private var ringing = false

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_RING -> {
                val alarmId = intent.getStringExtra(OttoConstants.EXTRA_ALARM_ID).orEmpty()
                val label = intent.getStringExtra(EXTRA_LABEL).orEmpty()
                val requestCode = intent.getIntExtra(OttoConstants.EXTRA_REQUEST_CODE, 0)
                // Mark the ring live in this process so recovery code doesn't mistake a long,
                // genuinely-sounding alarm for one stuck after a mid-ring kill (see isActive()).
                active = true
                goForeground(alarmId, label, requestCode)
                // Replace the receiver's launcher notification with our foreground one.
                if (alarmId.isNotEmpty()) notifications.cancel(requestCode)
                if (!ringing) {
                    ringer.start()
                    ringing = true
                }
            }
            ACTION_REFRESH -> {
                // Started via startService (we're already foreground), so no startForeground
                // obligation here — re-evaluate which alarm, if any, should keep ringing.
                appScope.launch(Dispatchers.IO) {
                    val next = repository.getRinging().firstOrNull()
                    if (next == null) {
                        stopRinging()
                    } else {
                        notifications.cancel(next.requestCode)
                        goForeground(next.alarmId, next.label, next.requestCode)
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun goForeground(alarmId: String, label: String, requestCode: Int) {
        try {
            ServiceCompat.startForeground(
                this,
                FOREGROUND_ID,
                notifications.buildRinging(alarmId, label, requestCode),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
            )
        } catch (t: Throwable) {
            OttoLog.e("Failed to start ring foreground service", t)
        }
    }

    private fun stopRinging() {
        active = false
        if (ringing) {
            ringer.stop()
            ringing = false
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        super.onDestroy()
        active = false
        if (ringing) {
            ringer.stop()
            ringing = false
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        private const val FOREGROUND_ID = 0xA11A
        private const val ACTION_RING = "com.otto.app.ring.ACTION_RING"
        private const val ACTION_REFRESH = "com.otto.app.ring.ACTION_REFRESH"
        const val EXTRA_LABEL = RingActivity.EXTRA_LABEL

        // Process-wide: true while a ring is sounding in THIS process. Resets to false on any cold
        // start (process death from boot/force-stop), which is exactly how recovery tells a ring
        // that was killed mid-play (stuck RANG → reclassify) from one still live (leave it alone).
        @Volatile
        private var active = false

        /** Whether a ring is currently sounding in this process. */
        fun isActive(): Boolean = active

        /** Ensure the ring is sounding for [alarmId] (idempotent). */
        fun ring(context: Context, alarmId: String, label: String, requestCode: Int) {
            val intent = Intent(context, RingService::class.java).apply {
                action = ACTION_RING
                putExtra(OttoConstants.EXTRA_ALARM_ID, alarmId)
                putExtra(EXTRA_LABEL, label)
                putExtra(OttoConstants.EXTRA_REQUEST_CODE, requestCode)
            }
            ContextCompat.startForegroundService(context, intent)
        }

        /** Re-evaluate the ring against Room (advance to the next RANG alarm, or stop). */
        fun refresh(context: Context) {
            val intent = Intent(context, RingService::class.java).apply { action = ACTION_REFRESH }
            // startService (not foreground): the service is already running and foreground.
            try {
                context.startService(intent)
            } catch (t: Throwable) {
                OttoLog.w("Could not refresh ring service", t)
            }
        }
    }
}
