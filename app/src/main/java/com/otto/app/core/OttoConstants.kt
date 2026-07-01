package com.otto.app.core

/**
 * Cross-cutting constants shared between components (scheduler ↔ receiver ↔ ring ↔ worker).
 * Component-private values stay in their own files.
 */
object OttoConstants {

    /** Notification channel for the ringing alarm (created at app start). */
    const val ALARM_CHANNEL_ID = "otto_alarm"

    /** Intent extra carrying the alarm id from the scheduler's PendingIntent to the receiver. */
    const val EXTRA_ALARM_ID = "com.otto.app.extra.ALARM_ID"

    /** Intent extra carrying an alarm's stable requestCode through the ring path (fix #4). */
    const val EXTRA_REQUEST_CODE = "com.otto.app.extra.REQUEST_CODE"

    /**
     * Past-time grace window. An alarm whose trigger time is at-or-before now but within this
     * window still rings; older than this it is marked MISSED instead of ringing late.
     */
    const val DEFAULT_GRACE_WINDOW_MILLIS = 60_000L

    /**
     * Snooze interval (spec §14 open decision resolved as a fixed interval — the classic 9
     * minutes). A snooze re-arms the alarm at now + this and increments snoozeCount.
     */
    const val SNOOZE_INTERVAL_MILLIS = 9 * 60 * 1000L

    /**
     * How long after its trigger a still-RANG alarm is considered stuck (the ringing process was
     * killed mid-ring) rather than legitimately ringing. On boot/app-update recovery such alarms
     * are reclassified MISSED. Chosen comfortably longer than a normal ring so a recovery pass that
     * races an in-flight ring never marks an active alarm missed.
     */
    const val STUCK_RANG_THRESHOLD_MILLIS = 5 * 60 * 1000L

    /** Host of the default placeholder server URL; network workers no-op while it's in use. */
    const val PLACEHOLDER_SERVER_HOST = "otto.invalid"

    /** Unique WorkManager work name for FCM-token registration. */
    const val WORK_REGISTER_TOKEN = "otto_register_token"

    /** Unique WorkManager work name for draining unreported alarm events to the server. */
    const val WORK_REPORT_EVENTS = "otto_report_events"

    /** Unique WorkManager work name for SYNC reconciliation. */
    const val WORK_SYNC = "otto_sync"

    /** Unique WorkManager work name for PING heartbeats. */
    const val WORK_HEARTBEAT = "otto_heartbeat"
}
