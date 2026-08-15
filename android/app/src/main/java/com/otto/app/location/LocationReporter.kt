package com.otto.app.location

/**
 * Where an answer goes.
 *
 * A seam for the same reason [com.otto.app.core.ReportTrigger] is one: it keeps [LocationController]
 * free of Retrofit and WorkManager so the interesting logic is plain JVM code testable behind a
 * hand-written fake.
 */
interface LocationReporter {
    /**
     * @return true when the server has it, or when there is no server to have it (an unpaired
     *   phone on the placeholder URL). False means "try again later WITH A FRESH FIX" — never
     *   "resend this one", because a fix that arrives ten minutes late is not a late answer, it is
     *   a wrong one.
     */
    suspend fun report(report: LocationReport): Boolean
}
