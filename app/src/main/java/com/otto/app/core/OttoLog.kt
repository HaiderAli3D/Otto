package com.otto.app.core

import android.util.Log
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.otto.app.BuildConfig

/**
 * Thin, structured logging facade. One tag, explicit levels, debug/info stripped from release.
 *
 * warn/error are also forwarded to Crashlytics as breadcrumbs (warn) and non-fatals (error) so a
 * "why didn't it ring" trail survives even when nobody is watching logcat. Forwarding is wrapped
 * in runCatching and lazily resolves the SDK, so a missing/unconfigured Crashlytics can never
 * crash the app. Auto-init reads app/google-services.json.
 *
 * Never pass secrets or full tokens — use [redact] for any token-like value.
 */
object OttoLog {
    private const val TAG = "Otto"

    private val crashlytics: FirebaseCrashlytics? by lazy {
        runCatching { FirebaseCrashlytics.getInstance() }.getOrNull()
    }

    fun d(message: String) {
        if (BuildConfig.DEBUG) Log.d(TAG, message)
    }

    fun i(message: String) {
        if (BuildConfig.DEBUG) Log.i(TAG, message)
    }

    // Policy: w/e stay on in release — on a sideloaded personal app, `adb logcat -s Otto` is the
    // only "why didn't it ring" trail, and output is already secret-safe via [redact].

    fun w(message: String, throwable: Throwable? = null) {
        Log.w(TAG, message, throwable)
        runCatching {
            crashlytics?.log("W/$TAG: $message")
            if (throwable != null) crashlytics?.recordException(throwable)
        }
    }

    fun e(message: String, throwable: Throwable? = null) {
        Log.e(TAG, message, throwable)
        runCatching {
            crashlytics?.log("E/$TAG: $message")
            crashlytics?.recordException(throwable ?: RuntimeException(message))
        }
    }

    /** Reduces a token/secret to a short, non-reversible hint safe for logs. */
    fun redact(value: String?): String {
        if (value.isNullOrEmpty()) return "<none>"
        val tail = value.takeLast(4)
        return "…$tail(${value.length})"
    }
}
