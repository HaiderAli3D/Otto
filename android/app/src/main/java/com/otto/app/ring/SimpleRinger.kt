package com.otto.app.ring

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.VibrationAttributes
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
 * Rings the device's default alarm sound on the alarm audio stream with a short volume ramp and a
 * repeating vibration. Uses [MediaPlayer] (not [android.media.Ringtone]) for reliable looping on
 * API 26+.
 *
 * This is an alarm clock, so it deliberately takes over the device alarm stream while ringing:
 * [MediaPlayer.setVolume] is only an *attenuation* of whatever the user's alarm slider is set to,
 * so without raising the stream the loudest Otto can ever be is whatever that slider happened to
 * be. [start] saves the current level and forces it to maximum; [stop] always puts it back.
 */
@Singleton
class SimpleRinger @Inject constructor(
    @ApplicationContext private val context: Context,
    private val appScope: CoroutineScope,
) : AlarmRinger {

    private var player: MediaPlayer? = null
    private var rampJob: Job? = null

    /** Non-null only while we have overridden the user's alarm volume, so [stop] can restore it. */
    private var savedAlarmVolume: Int? = null
    private var focusRequest: AudioFocusRequest? = null

    private val audioManager: AudioManager? by lazy {
        context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    }

    private val vibrator: Vibrator? by lazy {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
        }
    }

    private val alarmAttributes: AudioAttributes =
        AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

    @Synchronized
    override fun start() {
        stop()
        // Vibration first, and unconditionally: if no ringtone resolves we still want the phone to
        // buzz rather than fail completely silently (the previous behaviour).
        startVibration()

        val uri = alarmUri()
        if (uri == null) {
            OttoLog.e("No alarm/ringtone URI available; ringing with vibration only")
            return
        }
        try {
            raiseAlarmVolume()
            requestFocus()
            player = MediaPlayer().apply {
                setAudioAttributes(alarmAttributes)
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
        } catch (t: Throwable) {
            OttoLog.e("Failed to start alarm sound", t)
            // stop() restores the stream volume and abandons focus — never strand the phone at max.
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
        abandonFocus()
        restoreAlarmVolume()
    }

    /**
     * Force the alarm stream to maximum, remembering the previous level. No-op when the device
     * reports a fixed volume (some docks/TVs) or when the system refuses the change — on a locked
     * device with a restrictive DND policy this can throw [SecurityException], which is not fatal:
     * we simply ring at whatever level the user already had.
     */
    private fun raiseAlarmVolume() {
        val am = audioManager ?: return
        try {
            if (am.isVolumeFixed) return
            val max = am.getStreamMaxVolume(AudioManager.STREAM_ALARM)
            val current = am.getStreamVolume(AudioManager.STREAM_ALARM)
            if (current >= max) return // already maxed; nothing to restore later
            savedAlarmVolume = current
            am.setStreamVolume(AudioManager.STREAM_ALARM, max, 0)
            OttoLog.i("Alarm stream raised $current -> $max for the ring")
        } catch (t: Throwable) {
            OttoLog.w("Could not raise alarm volume; ringing at the current level", t)
            savedAlarmVolume = null
        }
    }

    private fun restoreAlarmVolume() {
        val previous = savedAlarmVolume ?: return
        savedAlarmVolume = null
        try {
            audioManager?.setStreamVolume(AudioManager.STREAM_ALARM, previous, 0)
            OttoLog.i("Alarm stream restored to $previous")
        } catch (t: Throwable) {
            OttoLog.w("Could not restore alarm volume to $previous", t)
        }
    }

    /** Ask media to duck/pause so the alarm isn't competing with whatever is playing. */
    private fun requestFocus() {
        val am = audioManager ?: return
        try {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(alarmAttributes)
                .build()
            focusRequest = request
            am.requestAudioFocus(request)
        } catch (t: Throwable) {
            OttoLog.w("Audio focus request failed", t)
            focusRequest = null
        }
    }

    private fun abandonFocus() {
        val am = audioManager ?: return
        val request = focusRequest ?: return
        focusRequest = null
        try {
            am.abandonAudioFocusRequest(request)
        } catch (t: Throwable) {
            OttoLog.w("Abandoning audio focus failed", t)
        }
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
            // Explicit max amplitude — the two-arg createWaveform overload uses DEFAULT_AMPLITUDE,
            // which is device-defined and often well below 255.
            val effect = VibrationEffect.createWaveform(VIBRATION_PATTERN, VIBRATION_AMPLITUDES, 0)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                // Tag it as an alarm, or it is classified USAGE_UNKNOWN and becomes eligible for
                // suppression by DND and by "vibration intensity" settings that exempt alarms.
                v.vibrate(
                    effect,
                    VibrationAttributes.Builder().setUsage(VibrationAttributes.USAGE_ALARM).build(),
                )
            } else {
                @Suppress("DEPRECATION")
                v.vibrate(effect, alarmAttributes)
            }
        } catch (t: Throwable) {
            OttoLog.w("Vibration unavailable", t)
        }
    }

    private fun alarmUri(): Uri? =
        RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            // Last resort: a notification tone is quieter than an alarm tone but is almost always
            // present, and any sound beats a silent alarm.
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)

    private companion object {
        /** ~0.6 ≈ -4.4 dB. The old 0.15 was -16.5 dB, which is inaudible through a duvet. */
        const val START_VOLUME = 0.6f
        const val RAMP_INCREMENT = 0.1f
        const val RAMP_STEP_MILLIS = 500L // full volume ~2s after the ring starts
        val VIBRATION_PATTERN = longArrayOf(0, 600, 600) // wait, buzz 600ms, pause 600ms, repeat
        val VIBRATION_AMPLITUDES = intArrayOf(0, 255, 0) // max amplitude on the buzz
    }
}
