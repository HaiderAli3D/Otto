package com.otto.app.net

import kotlinx.serialization.Serializable

/** Body of POST /devices/{deviceId}/token (spec.md §7.4). */
@Serializable
data class TokenRegistrationRequest(
    val token: String,
    val appVersion: String,
)
