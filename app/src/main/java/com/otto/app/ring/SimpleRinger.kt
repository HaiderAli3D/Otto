package com.otto.app.ring

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import com.otto.app.core.OttoLog
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * M1 ringer: loops the device's default alarm sound on the alarm audio stream. Uses a
 * [MediaPlayer] (rather than [android.media.Ringtone]) because looping is reliable on every
 * API level we support (26+). Volume ramp and vibration are deferred to M3.
 */
@Singleton
class SimpleRinger @Inject constructor(
    @ApplicationContext private val context: Context,
) : AlarmRinger {

    private var player: MediaPlayer? = null

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
                start()
            }
        } catch (t: Throwable) {
            OttoLog.e("Failed to start alarm sound", t)
            stop()
        }
    }

    @Synchronized
    override fun stop() {
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

    private fun alarmUri(): Uri? =
        RingtoneManager.getActualDefaultRingtoneUri(context, RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
}
