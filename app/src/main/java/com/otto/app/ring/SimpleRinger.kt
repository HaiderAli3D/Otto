package com.otto.app.ring

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import com.otto.app.core.OttoLog
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Rings the device's default alarm sound on the alarm audio stream, with an M3 volume ramp
 * (eases in over a few seconds rather than blasting at full volume) and a repeating vibration
 * pattern. Uses [MediaPlayer] (not [android.media.Ringtone]) for reliable looping on API 26+.
 */
@Singleton
class SimpleRinger @Inject constructor(
    @ApplicationContext private val context: Context,
    private val appScope: CoroutineScope,
) : AlarmRinger {

    private var player: MediaPlayer? = null
    private var rampJob: Job? = null

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    @Synchronized
    override fun start() {
        stop()
        val uri = alarmUri()
        if (uri == null) {
            OttoLog.w("No alarm/ringtone URI available; cannot ring")
            return
        }
        try {
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(context, uri)
                isLooping = true
                setOnErrorListener { _, what, extra ->
                    OttoLog.e("MediaPlayer error (what=$what extra=$extra)")
                    true
                }
                prepare()
                setVolume(START_VOLUME, START_VOLUME)
                start()
            }
            rampJob = appScope.launch { rampVolume() }
            startVibration()
        } catch (t: Throwable) {
            OttoLog.e("Failed to start alarm sound", t)
            stop()
        }
    }

    @Synchronized
    override fun stop() {
        rampJob?.cancel()
        rampJob = null
        try {
            vibrator?.cancel()
        } catch (_: Throwable) {
        }
        player?.let { mp ->
            try {
                if (mp.isPlaying) mp.stop()
            } catch (_: IllegalStateException) {
                // Already stopped/released — nothing to do.
            }
            mp.release()
        }
        player = null
    }

    private suspend fun rampVolume() {
        var volume = START_VOLUME
        while (volume < 1f) {
            delay(RAMP_STEP_MILLIS)
            volume = (volume + RAMP_INCREMENT).coerceAtMost(1f)
            synchronized(this) {
                try {
                    player?.setVolume(volume, volume)
                } catch (_: IllegalStateException) {
                    // Player released mid-ramp; stop adjusting.
                }
            }
        }
    }

    private fun startVibration() {
        val v = vibrator ?: return
        if (!v.hasVibrator()) return
        try {
            // Repeat the on/off pattern from index 0 until stop() cancels it.
            v.vibrate(VibrationEffect.createWaveform(VIBRATION_PATTERN, 0))
        } catch (t: Throwable) {
            OttoLog.w("Vibration unavailable", t)
        }
    }

    private fun alarmUri(): Uri? =
        RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

    private companion object {
        const val START_VOLUME = 0.15f
        const val RAMP_INCREMENT = 0.1f
        const val RAMP_STEP_MILLIS = 1_200L // ~10s from start to full
        val VIBRATION_PATTERN = longArrayOf(0, 600, 600) // wait, buzz 600ms, pause 600ms, repeat
    }
}
