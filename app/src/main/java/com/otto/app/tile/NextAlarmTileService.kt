package com.otto.app.tile

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.otto.app.core.OttoLog
import com.otto.app.data.AlarmRepository
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
        fun appScope(): CoroutineScope
    }

    private val formatter = SimpleDateFormat("EEE HH:mm", Locale.getDefault())

    override fun onStartListening() {
        super.onStartListening()
        val deps = EntryPointAccessors.fromApplication(applicationContext, Deps::class.java)
        deps.appScope().launch(Dispatchers.IO) {
            val next = deps.repository().getNextAlarm()
            withContext(Dispatchers.Main) { render(next?.triggerAtMillis) }
        }
    }

    private fun render(triggerAtMillis: Long?) {
        qsTile?.apply {
            if (triggerAtMillis == null) {
                state = Tile.STATE_INACTIVE
                label = "Otto · no alarm"
            } else {
                state = Tile.STATE_ACTIVE
                label = "Otto · ${formatter.format(Date(triggerAtMillis))}"
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
