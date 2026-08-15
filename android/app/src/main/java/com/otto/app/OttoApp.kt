package com.otto.app

import android.app.Application
import android.util.Log
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.otto.app.net.HeartbeatWorker
import com.otto.app.ring.NotificationChannels
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

/**
 * Application entry point.
 *
 * Annotated [HiltAndroidApp] so Hilt can field-inject the framework components the OS
 * instantiates for us (the FCM service and the alarm/boot receivers).
 *
 * Implements [Configuration.Provider] so WorkManager is initialised on-demand with
 * Hilt's [HiltWorkerFactory]. This is paired with the manifest entry that removes
 * WorkManager's default startup initializer — without that removal, WorkManager would
 * initialise itself before [workerFactory] is injected and our @HiltWorker classes
 * could not be constructed.
 */
@HiltAndroidApp
class OttoApp : Application(), Configuration.Provider {

    @Inject
    lateinit var workerFactory: HiltWorkerFactory

    override fun onCreate() {
        super.onCreate()
        NotificationChannels.ensureCreated(this)
        // Here rather than in an Activity so it re-arms on an FCM-only process start too. A phone
        // whose owner never opens the app is exactly the one whose delivery path can rot unnoticed.
        HeartbeatWorker.enqueuePeriodic(this)
    }

    // Must be a computed `get()` (not a direct initializer): the configuration has to be
    // built AFTER Hilt injects [workerFactory], which happens during super.onCreate().
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setWorkerFactory(workerFactory)
            .setMinimumLoggingLevel(if (BuildConfig.DEBUG) Log.DEBUG else Log.INFO)
            .build()
}
