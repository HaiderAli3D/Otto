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

    /**
     * Past-time grace window. An alarm whose trigger time is at-or-before now but within this
     * window still rings; older than this it is marked MISSED instead of ringing late.
     */
    const val DEFAULT_GRACE_WINDOW_MILLIS = 60_000L

    /** Unique WorkManager work name for FCM-token registration. */
    const val WORK_REGISTER_TOKEN = "otto_register_token"

    /** Unique WorkManager work name for draining unreported alarm events to the server. */
    const val WORK_REPORT_EVENTS = "otto_report_events"
}
