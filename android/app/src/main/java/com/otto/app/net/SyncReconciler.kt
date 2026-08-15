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
     * @param local           EVERY local alarm regardless of state (from `repository.getAll()`), so
     *                        RANG/terminal rows are visible here and not mistaken for "absent".
     * @param serverBody      the deserialized 200 body, or `null` when the 2xx response had no
     *                        parseable body
     * @param pendingAlarmIds ids with an undelivered outbox event (`repository.getPendingEventAlarmIds()`);
     *                        their local/server divergence is expected, so they are never cancelled here.
     */
    fun reconcile(
        local: List<AlarmEntity>,
        serverBody: AlarmSyncResponse?,
        pendingAlarmIds: Set<String>,
    ): SyncPlan {
        // Fail-safe guard (the safety-critical decision): only a present, NON-EMPTY authoritative
        // list is trusted to drive cancellations. A null body (unparseable 200) or an empty list —
        // indistinguishable from a malformed `{}` given the DTO defaults — changes nothing and
        // retries; explicit removals arrive via CANCEL_ALARM instead. This is what makes an
        // empty/errored SYNC safe (fix #1). See SyncReconcilerTest; flip `emptyPresentList_*` if
        // the owner decides an explicit empty list should instead cancel everything.
        val serverArmed = serverBody?.alarms.orEmpty().filter { it.state == ARMED_STATE }
        if (serverArmed.isEmpty()) return SyncPlan.Retry

        val localById = local.associateBy { it.alarmId }
        // Arm a server-ARMED alarm only when its local row is ABSENT or itself ARMED. A locally
        // RANG or terminal (DISMISSED/CANCELLED/MISSED) row is the app's newer truth on its way to
        // the server via the outbox; re-arming it here would resurrect a finished alarm or re-ring
        // one the user is mid-dismissing (AF2).
        val toArm = serverArmed.filter { s ->
            val localState = localById[s.alarmId]?.state
            localState == null || localState == AlarmState.ARMED
        }

        val serverIds = serverArmed.mapTo(HashSet()) { it.alarmId }
        // Cancel a local ARMED alarm the server no longer lists — but never one with a pending
        // outbox event (a snooze/new trigger the server hasn't applied yet); that divergence is
        // expected and self-heals once the report is delivered (AF2).
        val toCancel = local
            .filter {
                it.state == AlarmState.ARMED &&
                    it.alarmId !in serverIds &&
                    it.alarmId !in pendingAlarmIds
            }
            .map { it.alarmId }
        return SyncPlan.Apply(toArm = toArm, toCancelIds = toCancel)
    }
}
