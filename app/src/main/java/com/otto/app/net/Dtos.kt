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
)

/** Body of POST /devices/{deviceId}/heartbeat — liveness ping (spec.md §7.4). */
@Serializable
data class HeartbeatRequest(
    val appVersion: String,
    val atMillis: Long,
    /** IANA zone id (e.g. "Europe/London"); nullable+default keeps older servers compatible. */
    val timezone: String? = null,
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
