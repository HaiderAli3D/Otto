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
    fun isPlaceholder_detectsPlaceholderHost() {
        assertTrue(ServerUrl.isPlaceholder(default))
        assertFalse(ServerUrl.isPlaceholder(override))
    }
}
