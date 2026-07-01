package com.otto.app.net

import com.otto.app.data.AlarmEntity
import com.otto.app.data.AlarmState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract for [SyncReconciler.reconcile]. These tests encode the RECOMMENDED fail-safe
 * policy (see the chat handoff). The only genuinely debatable case is `emptyPresentList_*`:
 * if you decide an explicit empty list should cancel everything, flip that test to expect
 * `SyncPlan.Apply(emptyList(), <all local ids>)` and implement accordingly.
 */
class SyncReconcilerTest {

    private fun local(id: String, state: AlarmState = AlarmState.ARMED) = AlarmEntity(
        alarmId = id,
        triggerAtMillis = 1_000L,
        label = "L-$id",
        state = state,
        createdAtMillis = 0L,
        updatedAtMillis = 0L,
    )

    private fun server(id: String, state: String = "ARMED") =
        SyncAlarm(alarmId = id, triggerAtMillis = 2_000L, label = "S-$id", state = state)

    @Test
    fun nullBody_isNotAuthoritative_retriesAndChangesNothing() {
        // A 200 with no parseable body must NEVER cancel alarms.
        assertEquals(SyncPlan.Retry, SyncReconciler.reconcile(listOf(local("a")), serverBody = null))
    }

    @Test
    fun serverAddsAlarm_armsIt_cancelsNothing() {
        val plan = SyncReconciler.reconcile(
            local = listOf(local("a")),
            serverBody = AlarmSyncResponse(listOf(server("a"), server("b"))),
        )
        plan as SyncPlan.Apply
        assertEquals(setOf("a", "b"), plan.toArm.map { it.alarmId }.toSet())
        assertTrue(plan.toCancelIds.isEmpty())
    }

    @Test
    fun serverDropsLocalAlarm_cancelsOnlyTheDroppedOne() {
        val plan = SyncReconciler.reconcile(
            local = listOf(local("a"), local("b")),
            serverBody = AlarmSyncResponse(listOf(server("a"))),
        )
        plan as SyncPlan.Apply
        assertEquals(setOf("a"), plan.toArm.map { it.alarmId }.toSet())
        assertEquals(listOf("b"), plan.toCancelIds)
    }

    @Test
    fun serverOnlyReturnsNonArmedStates_areIgnoredForArming() {
        // A non-ARMED entry in the server set is not something to arm; it counts as "not present".
        val plan = SyncReconciler.reconcile(
            local = listOf(local("a")),
            serverBody = AlarmSyncResponse(listOf(server("a"), server("z", state = "CANCELLED"))),
        )
        plan as SyncPlan.Apply
        assertEquals(setOf("a"), plan.toArm.map { it.alarmId }.toSet())
        assertTrue(plan.toCancelIds.isEmpty())
    }

    @Test
    fun emptyPresentList_failsSafe_doesNotCancelAll() {
        // RECOMMENDED policy: an empty authoritative list is treated as "not trustworthy enough
        // to bulk-cancel" (indistinguishable from a malformed `{}`), so leave alarms intact.
        // Explicit removals arrive via CANCEL_ALARM instead.
        val plan = SyncReconciler.reconcile(
            local = listOf(local("a"), local("b")),
            serverBody = AlarmSyncResponse(alarms = emptyList()),
        )
        assertEquals(SyncPlan.Retry, plan)
    }
}
