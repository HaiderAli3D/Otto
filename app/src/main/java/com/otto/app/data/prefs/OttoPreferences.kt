package com.otto.app.data.prefs

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

// Must be a top-level delegate (one DataStore per file/name).
private val Context.ottoDataStore: DataStore<Preferences> by preferencesDataStore(name = "otto_prefs")

/**
 * Small key-value store for device state that isn't an alarm: the FCM token, one-time UI
 * flags, and the debug-only server URL override (spec.md §6.3).
 */
@Singleton
class OttoPreferences @Inject constructor(
    @ApplicationContext private val context: Context,
) {
    private object Keys {
        val FCM_TOKEN = stringPreferencesKey("fcm_token")
        val LAST_REGISTRATION_MILLIS = longPreferencesKey("last_registration_millis")
        val SERVER_URL_OVERRIDE = stringPreferencesKey("server_url_override")
        val BATTERY_PROMPT_SHOWN = booleanPreferencesKey("battery_prompt_shown")
    }

    val fcmToken: Flow<String?> = context.ottoDataStore.data.map { it[Keys.FCM_TOKEN] }

    suspend fun setFcmToken(token: String) {
        context.ottoDataStore.edit { it[Keys.FCM_TOKEN] = token }
    }

    val lastRegistrationMillis: Flow<Long?> =
        context.ottoDataStore.data.map { it[Keys.LAST_REGISTRATION_MILLIS] }

    suspend fun setLastRegistrationMillis(value: Long) {
        context.ottoDataStore.edit { it[Keys.LAST_REGISTRATION_MILLIS] = value }
    }

    val serverUrlOverride: Flow<String?> =
        context.ottoDataStore.data.map { it[Keys.SERVER_URL_OVERRIDE] }

    suspend fun setServerUrlOverride(url: String?) {
        context.ottoDataStore.edit { prefs ->
            if (url.isNullOrBlank()) prefs.remove(Keys.SERVER_URL_OVERRIDE) else prefs[Keys.SERVER_URL_OVERRIDE] = url
        }
    }

    val batteryPromptShown: Flow<Boolean> =
        context.ottoDataStore.data.map { it[Keys.BATTERY_PROMPT_SHOWN] ?: false }

    suspend fun setBatteryPromptShown(shown: Boolean) {
        context.ottoDataStore.edit { it[Keys.BATTERY_PROMPT_SHOWN] = shown }
    }
}
