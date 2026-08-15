package com.otto.app.net

import com.otto.app.core.OttoConstants

/**
 * Pure resolution of the effective server base URL (spec.md §16). A debug-only override wins
 * over the compile-time [com.otto.app.BuildConfig.SERVER_BASE_URL] default only when overrides
 * are allowed (debug builds) and the override is non-blank; otherwise the default is used.
 *
 * Kept Android-free so the precedence is unit-testable and — crucially — so the Retrofit
 * factory, every worker's placeholder gate, and the settings UI all resolve the *same* URL.
 * Before this, the UI displayed the override while the network stack ignored it (bug_001).
 */
object ServerUrl {

    /** The base URL the network stack should actually target. */
    fun effective(override: String?, default: String, allowOverride: Boolean): String {
        val chosen = if (allowOverride && !override.isNullOrBlank()) override else default
        // Retrofit's baseUrl() rejects a URL whose last path segment is non-empty (e.g. a tunnel
        // subpath like https://x.trycloudflare.com/otto-server) with an IllegalArgumentException
        // that would crash every worker before its try/catch. Normalising here — the one choke
        // point — keeps the UI, placeholder gate, and Retrofit factory agreeing on the same URL.
        return if (chosen.endsWith("/")) chosen else "$chosen/"
    }

    /** True while [url] is still the built-in placeholder host; workers no-op in that case. */
    fun isPlaceholder(url: String): Boolean = url.contains(OttoConstants.PLACEHOLDER_SERVER_HOST)
}
