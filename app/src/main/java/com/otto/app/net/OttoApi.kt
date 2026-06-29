package com.otto.app.net

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * The Otto server HTTP surface (spec.md §7.4). M1 used only token registration; M2 adds
 * alarm-event reporting.
 */
interface OttoApi {
    @POST("devices/{deviceId}/token")
    suspend fun registerToken(
        @Path("deviceId") deviceId: String,
        @Body body: TokenRegistrationRequest,
    ): Response<Unit>

    @POST("alarms/{alarmId}/events")
    suspend fun reportEvent(
        @Path("alarmId") alarmId: String,
        @Body body: AlarmEventRequest,
    ): Response<Unit>
}
