package com.otto.app.push

/**
 * The inbound-command trust gate (fix #6). Pure so every combination is unit-tested — see
 * `HmacGateTest`.
 *
 * Policy = **fail closed once paired**: before the device has ever been paired we accept unsigned
 * commands to bootstrap testing; once a secret has ever been provisioned, a command executes only
 * if it carries a valid signature. This means a leaked FCM token alone can never arm alarms, and a
 * secret that later fails to decrypt drops commands rather than silently reverting to unverified
 * (the exact silent-revert the audit flagged).
 */
object HmacGate {
    /**
     * @param hasSecret     a usable secret is currently available (decrypted successfully)
     * @param sigValid      the command's `sig` verified against that secret
     * @param hasEverPaired a secret has been provisioned at least once (latched; survives decrypt
     *                      failures, reset only by an explicit unpair)
     */
    fun shouldExecute(hasSecret: Boolean, sigValid: Boolean, hasEverPaired: Boolean): Boolean = when {
        hasSecret -> sigValid       // paired & usable: only correctly-signed commands run
        hasEverPaired -> false      // was paired but secret unusable/absent: fail closed
        else -> true                // never paired: bootstrap, accept unverified
    }
}
