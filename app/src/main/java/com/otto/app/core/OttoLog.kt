package com.otto.app.core

import android.util.Log
import com.otto.app.BuildConfig

/**
 * Thin, structured logging facade. One tag, explicit levels, debug stripped from release.
 *
 * Crashlytics breadcrumb/non-fatal forwarding is intentionally wired here in a single place
 * (see the commented `record`/`breadcrumb` hooks) so enabling it is a one-file change once the
 * `firebase-crashlytics` dependency can be fetched (see CLAUDE.md / build notes).
 *
 * Never pass secrets or full tokens — use [redact] for any token-like value.
 */
object OttoLog {
    private const val TAG = "Otto"

    fun d(message: String) {
        if (BuildConfig.DEBUG) Log.d(TAG, message)
    }

    fun i(message: String) {
        Log.i(TAG, message)
    }

    fun w(message: String, throwable: Throwable? = null) {
        Log.w(TAG, message, throwable)
    }

    fun e(message: String, throwable: Throwable? = null) {
        Log.e(TAG, message, throwable)
    }

    /** Reduces a token/secret to a short, non-reversible hint safe for logs. */
    fun redact(value: String?): String {
        if (value.isNullOrEmpty()) return "<none>"
        val tail = value.takeLast(4)
        return "…$tail(${value.length})"
    }
}
