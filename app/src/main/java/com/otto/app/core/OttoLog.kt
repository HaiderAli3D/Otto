package com.otto.app.core

import android.util.Log
import com.otto.app.BuildConfig

/**
 * Thin logging facade. Debug-level logs are stripped in release builds. Never pass secrets
 * or full tokens — use [redact] for any token-like value.
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
