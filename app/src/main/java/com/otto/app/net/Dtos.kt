package com.otto.app.net

import kotlinx.serialization.Serializable

/** Body of POST /devices/{deviceId}/token (spec.md §7.4). */
@Serializable
data class TokenRegistrationRequest(
    val token: String,
    val appVersion: String,
)

/** Body of POST /alarms/{alarmId}/events — one alarm lifecycle transition (spec.md §7.4). */
@Serializable
data class AlarmEventRequest(
    val deviceId: String,
    val event: String,
    val atMillis: Long,
    val appVersion: String,
)
