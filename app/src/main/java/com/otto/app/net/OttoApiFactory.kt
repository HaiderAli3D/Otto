package com.otto.app.net

import com.otto.app.BuildConfig
import com.otto.app.data.prefs.OttoPreferences
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import retrofit2.Retrofit
import retrofit2.converter.kotlinx.serialization.asConverterFactory
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Builds the [OttoApi] against the *effective* base URL rather than a fixed compile-time one.
 *
 * Retrofit bakes its `baseUrl` in at construction and cannot swap it on a shared instance, so a
 * plain `@Singleton` `OttoApi` could never honor the debug URL override (bug_001). This factory
 * resolves the effective URL from the persisted override + [BuildConfig] via [ServerUrl] and
 * caches one Retrofit per URL, rebuilding only when the override changes.
 */
@Singleton
class OttoApiFactory @Inject constructor(
    private val client: OkHttpClient,
    private val json: Json,
    private val preferences: OttoPreferences,
) {
    private var cached: Pair<String, OttoApi>? = null

    /** The base URL the network stack should target right now (override-or-default). */
    suspend fun effectiveBaseUrl(): String = ServerUrl.effective(
        override = preferences.serverUrlOverride.firstOrNull(),
        default = BuildConfig.SERVER_BASE_URL,
        allowOverride = BuildConfig.ALLOW_URL_OVERRIDE,
    )

    /**
     * The API for the current effective URL, or null while it is still the placeholder — in
     * which case the caller should no-op (the Otto server isn't reachable yet).
     */
    suspend fun currentApiOrNull(): OttoApi? {
        val baseUrl = effectiveBaseUrl()
        return if (ServerUrl.isPlaceholder(baseUrl)) null else apiFor(baseUrl)
    }

    @Synchronized
    private fun apiFor(baseUrl: String): OttoApi {
        cached?.let { (url, api) -> if (url == baseUrl) return api }
        val api = Retrofit.Builder()
            .baseUrl(baseUrl)
            .client(client)
            .addConverterFactory(json.asConverterFactory("application/json".toMediaType()))
            .build()
            .create(OttoApi::class.java)
        cached = baseUrl to api
        return api
    }
}
