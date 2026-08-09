package com.otto.app.core

/**
 * Cross-cutting constants shared between components (scheduler ↔ receiver ↔ ring ↔ worker).
 * Component-private values stay in their own files.
 */
object OttoConstants {

    /** Notification channel for the ringing alarm (created at app start). */
    const val ALARM_CHANNEL_ID = "otto_alarm"

    /**
     * Notification channels for nudges — everything Otto says that is NOT an alarm.
     *
     * Channel ids are immutable once created: the OS hands their sound, importance and vibration to
     * the user at creation and ignores every later change, so a channel that needs different
     * behaviour needs a NEW id and the old one lingers in settings forever. These four are a
     * one-shot decision, named for what they are FOR rather than how loud they are, so a change of
     * mind about volume never forces a rename.
     *
     * Four levels and no more. Past that the system settings screen becomes unreadable and the
     * server cannot sensibly reason about which to pick.
     */
    const val NUDGE_CHANNEL_GROUP_ID = "otto_reminders"

    /** Heads-up over whatever is on screen, with sound. Not an alarm: no full-screen, no looping. */
    const val NUDGE_URGENT_CHANNEL_ID = "otto_nudge_urgent"

    /** Makes a sound and lands in the shade without peeking. The everyday rung. */
    const val NUDGE_CHANNEL_ID = "otto_nudge"

    /** Silent but visible. Confirmations, FYIs, and the quiet end of a chase ladder. */
    const val NUDGE_QUIET_CHANNEL_ID = "otto_quiet"

    /**
     * The persistent "N things open" summary, on its own channel so the owner can silence the
     * always-on line without silencing the content.
     */
    const val NUDGE_STATUS_CHANNEL_ID = "otto_status"

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

    /**
     * Unique work name for the standing heartbeat.
     *
     * There was none until nudges existed, and without one a dead FCM path is invisible to BOTH
     * sides: the server logs a successful send, the phone shows nothing, and nobody notices until
     * the owner mentions it. Alarms could survive that gap because a missed one is loud; a missed
     * nudge is silent by design.
     */
    const val WORK_HEARTBEAT_PERIODIC = "otto_heartbeat_periodic"

    /** Intent extra carrying a nudge id from a notification action back to the receiver. */
    const val EXTRA_NUDGE_ID = "com.otto.app.extra.NUDGE_ID"

    /** Intent extra carrying a nudge's stable notification id. */
    const val EXTRA_NUDGE_NOTIFICATION_ID = "com.otto.app.extra.NUDGE_NOTIFICATION_ID"

    /**
     * Id bands, kept disjoint from the alarm path by construction.
     *
     * Alarm notification ids and PendingIntent request codes both come from `alarms.requestCode`,
     * which counts up from 1. Nudges take bands far above that, so the two can never collide even
     * if one of them is ever changed to allocate differently. `RingService.FOREGROUND_ID` (0xA11A,
     * 41242) sits well below the lowest band here.
     *
     * A nudge action's request code is `NUDGE_PI_BASE + notificationId * 8 + action.ordinal`, which
     * is injective while there are fewer than eight actions. Distinct request codes are the second
     * of two defences against PendingIntent collision — the first is a distinct intent action per
     * button, because PendingIntent equality ignores extras and would otherwise collapse "Done" and
     * "Snooze" into one intent.
     */
    const val NUDGE_SUMMARY_NOTIFICATION_ID = 999_999
    const val NUDGE_NOTIFICATION_ID_BASE = 1_000_000
    const val NUDGE_PI_BASE = 2_000_000
    const val NUDGE_PI_STRIDE = 8

    /** How long a snooze lasts when the server does not say. Distinct from the 9-minute alarm one. */
    const val DEFAULT_SNOOZE_MINUTES = 30

    /**
     * Render limits. The server truncates before signing so the payload clears FCM's 4KB cap; these
     * are the backstop that keeps a server bug from throwing on the phone instead.
     */
    const val MAX_NUDGE_TITLE_CHARS = 80
    const val MAX_NUDGE_BODY_CHARS = 500

    /** Unique WorkManager work name for answering a REQUEST_LOCATION when the service path is shut. */
    const val WORK_LOCATION = "otto_location"

    /**
     * Notification id for the transparency notice shown while a fix is being taken.
     *
     * Its own id, above the nudge bands, because it is not a nudge and must never replace one.
     */
    const val LOCATION_NOTIFICATION_ID = 3_000_000

    /**
     * How old a cached fix may be before the provider goes and gets a fresh one, when the server
     * does not say. Kept short: the whole value of an on-demand fix is that it is current.
     */
    const val DEFAULT_LOCATION_MAX_AGE_MILLIS = 2 * 60 * 1000L

    /** Ceiling on the age the SERVER may ask for. Trusting it would make "current" unfalsifiable. */
    const val MAX_LOCATION_AGE_SECONDS = 30 * 60L

    /** How long to wait for a fix before answering TIMEOUT. Shorter than the agent's own patience. */
    const val LOCATION_FIX_TIMEOUT_MILLIS = 25_000L

    /**
     * How long a location request stays worth answering when the server names no expiry.
     *
     * A fix that arrives after the journey was planned is not a late answer, it is a wrong one, so
     * a request that has sat through a retry chain expires rather than replying with the present
     * about a question asked in the past.
     */
    const val LOCATION_REQUEST_TTL_MILLIS = 10 * 60 * 1000L

    /** Shown to the owner on the transparency notification; clamped like a nudge title. */
    const val MAX_LOCATION_REASON_CHARS = 120
}
