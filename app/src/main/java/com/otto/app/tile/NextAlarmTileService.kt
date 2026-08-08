package com.otto.app.tile

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.otto.app.R
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmRepository
import com.otto.app.data.NudgeRepository
import com.otto.app.ui.MainActivity
import dagger.hilt.EntryPoint
import dagger.hilt.InstallIn
import dagger.hilt.android.EntryPointAccessors
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Quick-settings tile (M5, optional) showing the next armed alarm. Refreshes whenever the
 * tile becomes visible; tapping it opens the control panel. Deps come from the Hilt graph via
 * [EntryPointAccessors] (a TileService isn't an @AndroidEntryPoint target).
 */
class NextAlarmTileService : TileService() {

    @EntryPoint
    @InstallIn(SingletonComponent::class)
    interface Deps {
        fun repository(): AlarmRepository
        fun nudgeRepository(): NudgeRepository
        fun appScope(): CoroutineScope
    }

    private val formatter = SimpleDateFormat("EEE HH:mm", Locale.getDefault())

    override fun onStartListening() {
        super.onStartListening()
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        deps.appScope().launch(Dispatchers.IO) {
            val next = deps.repository().getNextAlarm()
            val open = deps.nudgeRepository().getActive().size
            withContext(Dispatchers.Main) { render(next?.triggerAtMillis, open) }
        }
    }

    /**
     * Open nudges win the label when there are any.
     *
     * Roughly twelve characters survive before the tile truncates, so it can only ever say one
     * thing — and "3 open" is the one that needs acting on. A next alarm is already visible in the
     * status bar's own alarm icon; an outstanding chase is visible nowhere else at a glance.
     */
    private fun render(triggerAtMillis: Long?, openNudges: Int) {
        qsTile?.apply {
            when {
                openNudges > 0 -> {
                    state = Tile.STATE_ACTIVE
                    label = getString(R.string.tile_open_count, openNudges)
                }
                triggerAtMillis != null -> {
                    state = Tile.STATE_ACTIVE
                    label = getString(R.string.tile_next_alarm, formatter.format(Date(triggerAtMillis)))
                }
                else -> {
                    state = Tile.STATE_INACTIVE
                    label = getString(R.string.tile_no_alarm)
                }
            }
            updateTile()
        }
    }

    override fun onClick() {
        super.onClick()
        val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val pending = PendingIntent.getActivity(
                    this, 0, intent, PendingIntent.FLAG_IMMUTABLE,
                )
                startActivityAndCollapse(pending)
            } else {
                @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
                startActivityAndCollapse(intent)
            }
        } catch (t: Throwable) {
            OttoLog.w("Could not open from tile", t)
        }
    }
}
