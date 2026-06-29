package com.otto.app.net

import retrofit2.Response
import retrofit2.http.Body
import retrofit2.http.POST
import retrofit2.http.Path

/**
 * The Otto server HTTP surface. M1 only needs token registration; alarm-event reporting and
 * heartbeats (spec.md §7.4) arrive in M2.
 */
interface OttoApi {
    @POST("devices/{deviceId}/token")
    suspend fun registerToken(
        @Path("deviceId") deviceId: String,
        @Body body: TokenRegistrationRequest,
    ): Response<Unit>
}
