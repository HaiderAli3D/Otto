package com.otto.app.core

/**
 * Requests a drain of the alarm-event outbox to the server. This thin seam abstracts
 * WorkManager away from [com.otto.app.data.AlarmRepository] so the repository's transition
 * logic (including the SNOOZED-then-ARMED ordering of fix #2) stays unit-testable in plain JVM —
 * tests pass a no-op; production enqueues `ReportWorker` (see `di/ReportModule`).
 */
fun interface ReportTrigger {
    fun requestReport()
}
