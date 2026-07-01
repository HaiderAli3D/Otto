package com.otto.app.net

import com.otto.app.data.AlarmEntity
import com.otto.app.data.AlarmState

/**
 * Reconciliation plan produced by [SyncReconciler.reconcile].
 */
sealed interface SyncPlan {
    /**
     * The server response is trustworthy and authoritative: arm/refresh [toArm] (idempotent on
     * `alarmId`) and cancel the local alarms in [toCancelIds].
     */
    data class Apply(val toArm: List<SyncAlarm>, val toCancelIds: List<String>) : SyncPlan

    /**
     * The server response is NOT trustworthy enough to act on (e.g. a 200 with no parseable
     * body). Change nothing locally and let the worker retry. This is the fail-safe outcome that
     * prevents a transient/empty response from wiping every alarm.
     */
    data object Retry : SyncPlan
}

/**
 * Pure, Android-free reconciliation of local ARMED alarms against the server's authoritative set.
 *
 * SAFETY-CRITICAL: this is the one place that can cancel alarms in bulk. The previous inline
 * logic in [SyncWorker] collapsed "empty body", "unparseable body", and "genuinely no alarms"
 * into the single action "cancel everything" (it used `response.body()?.alarms.orEmpty()`), so
 * any transient hiccup silently deleted the user's alarms. Keeping this a pure function makes
 * every branch exhaustively unit-testable — see `SyncReconcilerTest`.
 */
object SyncReconciler {
    /** The state string the server uses for an armed alarm. */
    const val ARMED_STATE = "ARMED"

    /**
     * @param local      the alarms currently ARMED on this device (from `repository.getAllArmed()`)
     * @param serverBody the deserialized 200 body, or `null` when the 2xx response had no
     *                   parseable body
     */
    fun reconcile(local: List<AlarmEntity>, serverBody: AlarmSyncResponse?): SyncPlan {
        // Fail-safe guard (the safety-critical decision): only a present, NON-EMPTY authoritative
        // list is trusted to drive cancellations. A null body (unparseable 200) or an empty list —
        // indistinguishable from a malformed `{}` given the DTO defaults — changes nothing and
        // retries; explicit removals arrive via CANCEL_ALARM instead. This is what makes an
        // empty/errored SYNC safe (fix #1). See SyncReconcilerTest; flip `emptyPresentList_*` if
        // the owner decides an explicit empty list should instead cancel everything.
        val serverArmed = serverBody?.alarms.orEmpty().filter { it.state == ARMED_STATE }
        if (serverArmed.isEmpty()) return SyncPlan.Retry

        val serverIds = serverArmed.mapTo(HashSet()) { it.alarmId }
        val toCancel = local
            .filter { it.state == AlarmState.ARMED && it.alarmId !in serverIds }
            .map { it.alarmId }
        return SyncPlan.Apply(toArm = serverArmed, toCancelIds = toCancel)
    }
}
