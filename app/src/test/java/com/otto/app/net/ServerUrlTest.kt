package com.otto.app.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerUrlTest {

    private val default = "https://otto.invalid/"
    private val override = "https://staging.otto.example/"

    @Test
    fun override_wins_whenAllowedAndNonBlank() {
        assertEquals(override, ServerUrl.effective(override, default, allowOverride = true))
    }

    @Test
    fun blankOrNullOverride_fallsBackToDefault() {
        assertEquals(default, ServerUrl.effective("   ", default, allowOverride = true))
        assertEquals(default, ServerUrl.effective(null, default, allowOverride = true))
    }

    @Test
    fun override_ignored_whenNotAllowed() {
        // Release builds must never honor a persisted override, even if one somehow exists.
        assertEquals(default, ServerUrl.effective(override, default, allowOverride = false))
    }

    @Test
    fun missingTrailingSlash_isAppended_onOverride() {
        // A tunnel subpath without the trailing slash Retrofit requires (bug_002): baseUrl()
        // throws IllegalArgumentException on any URL whose last path segment is non-empty.
        assertEquals(
            "https://foo.trycloudflare.com/otto-server/",
            ServerUrl.effective("https://foo.trycloudflare.com/otto-server", default, allowOverride = true),
        )
    }

    @Test
    fun missingTrailingSlash_isAppended_onDefault() {
        // A release SERVER_BASE_URL typed without the slash must be tolerated at runtime too.
        assertEquals(
            "https://otto.example.com/api/",
            ServerUrl.effective(null, "https://otto.example.com/api", allowOverride = false),
        )
    }

    @Test
    fun isPlaceholder_detectsPlaceholderHost() {
        assertTrue(ServerUrl.isPlaceholder(default))
        assertFalse(ServerUrl.isPlaceholder(override))
    }
}
