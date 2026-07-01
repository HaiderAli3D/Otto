package com.otto.app.push

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Exhaustive truth table for the fail-closed-once-paired gate (fix #6). */
class HmacGateTest {

    @Test
    fun neverPaired_noSecret_acceptsUnverified() {
        assertTrue(HmacGate.shouldExecute(hasSecret = false, sigValid = false, hasEverPaired = false))
    }

    @Test
    fun paired_validSignature_executes() {
        assertTrue(HmacGate.shouldExecute(hasSecret = true, sigValid = true, hasEverPaired = true))
    }

    @Test
    fun paired_invalidSignature_drops() {
        assertFalse(HmacGate.shouldExecute(hasSecret = true, sigValid = false, hasEverPaired = true))
    }

    @Test
    fun everPaired_butSecretNowMissing_failsClosed() {
        // The audit's silent-revert case: the secret fails to decrypt after pairing -> must drop,
        // NOT fall back to accepting unsigned commands.
        assertFalse(HmacGate.shouldExecute(hasSecret = false, sigValid = false, hasEverPaired = true))
    }

    @Test
    fun secretPresent_alwaysRequiresValidSig_regardlessOfLatch() {
        assertFalse(HmacGate.shouldExecute(hasSecret = true, sigValid = false, hasEverPaired = false))
        assertTrue(HmacGate.shouldExecute(hasSecret = true, sigValid = true, hasEverPaired = false))
    }
}
