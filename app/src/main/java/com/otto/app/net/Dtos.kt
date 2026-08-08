package com.otto.app.net

import kotlinx.serialization.Serializable

/** Body of POST /devices/{deviceId}/token (spec.md §7.4). */
@Serializable
data class TokenRegistrationRequest(
    val token: String,
    val appVersion: String,
    /** IANA zone id (e.g. "Europe/London"); nullable+default keeps older servers compatible. */
    val timezone: String? = null,
)

/** Body of POST /alarms/{alarmId}/events — one alarm lifecycle transition (spec.md §7.4). */
@Serializable
data class AlarmEventRequest(
    val deviceId: String,
    val event: String,
    val atMillis: Long,
    val appVersion: String,
    /**
     * The alarm's current trigger at report time, so a snooze's new time reaches the server (AF4).
     * Nullable+default keeps older servers compatible (they ignore it); the server acts on it only
     * for an ARMED event.
     */
    val triggerAtMillis: Long? = null,
)

/**
 * Body of POST /devices/{deviceId}/events — anything the device reports that is not an alarm state.
 *
 * One generic route rather than one per feature. [kind] says which vocabulary [event] is drawn
 * from, so a new device-side signal is a new constant on both sides rather than a new endpoint, a
 * new DTO and a new drain loop. The server dedupes on (deviceId, kind, refId, event, atMillis),
 * mirroring the alarm rule, because delivery here is at-least-once for the same reason.
 */
@Serializable
data class DeviceEventRequest(
    val deviceId: String,
    val kind: String,
    val refId: String,
    val event: String,
    val atMillis: Long,
    val appVersion: String,
    val detail: String? = null,
    /** Only meaningful for a snooze: when the owner asked to be shown it again. */
    val untilMillis: Long? = null,
)

/** Body of POST /devices/{deviceId}/heartbeat — liveness ping (spec.md §7.4). */
@Serializable
data class HeartbeatRequest(
    val appVersion: String,
    val atMillis: Long,
    /** IANA zone id (e.g. "Europe/London"); nullable+default keeps older servers compatible. */
    val timezone: String? = null,
    /**
     * Whether the owner has notifications on at all, and which channels are silenced.
     *
     * Reported because a muted channel is invisible from the server otherwise: it would keep
     * spending the day's message budget on pushes that reach nobody, and Otto would go on
     * confirming chases the owner never sees. Android gives no way to UNDO a mute — the owner owns
     * that setting — but knowing about it lets the server reroute to WhatsApp and say so once.
     * Nullable+default so an older server ignores it.
     */
    val notificationsEnabled: Boolean? = null,
    val mutedChannels: List<String>? = null,
)

/** Response of GET /devices/{deviceId}/alarms — the server's authoritative alarm set. */
@Serializable
data class AlarmSyncResponse(
    val alarms: List<SyncAlarm> = emptyList(),
)

@Serializable
data class SyncAlarm(
    val alarmId: String,
    val triggerAtMillis: Long,
    val label: String = "Alarm",
    val allowWhileIdle: Boolean = true,
    val state: String = "ARMED",
)
