package com.otto.app.net

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.GET
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

    /**
     * Everything the device reports that is not an alarm state change — a nudge the owner acted on,
     * a push it could not parse. One route for all of them; see [DeviceEventRequest].
     */
    @POST("devices/{deviceId}/events")
    suspend fun reportDeviceEvent(
        @Path("deviceId") deviceId: String,
        @Body body: DeviceEventRequest,
    ): Response<Unit>

    /** SYNC: the server's authoritative alarm set, which the app reconciles to. */
    @GET("devices/{deviceId}/alarms")
    suspend fun fetchAlarms(
        @Path("deviceId") deviceId: String,
    ): Response<AlarmSyncResponse>

    /** PING: liveness heartbeat. */
    @POST("devices/{deviceId}/heartbeat")
    suspend fun heartbeat(
        @Path("deviceId") deviceId: String,
        @Body body: HeartbeatRequest,
    ): Response<Unit>

    /**
     * The answer to a REQUEST_LOCATION — a fix, or the reason there is not one.
     *
     * Its own route rather than another `kind` on `devices/{deviceId}/events`: that outbox drains
     * strictly in id order and stops at the first failure, which is a guarantee worth nothing here
     * at the price of the only one that matters. See [LocationReportRequest].
     */
    @POST("devices/{deviceId}/location")
    suspend fun reportLocation(
        @Path("deviceId") deviceId: String,
        @Body body: LocationReportRequest,
    ): Response<Unit>
}
