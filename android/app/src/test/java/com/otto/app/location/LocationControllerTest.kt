package com.otto.app.location

import com.otto.app.core.Clock
import com.otto.app.core.OttoConstants
import com.otto.app.push.FcmCommand
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The logic behind one REQUEST_LOCATION, exercised through hand-written fakes.
 *
 * Fakes rather than a mocking library, matching the rest of the suite. The two seams
 * ([LocationProvider], [LocationReporter]) exist precisely so this can run on the JVM with no Play
 * Services, no Retrofit and no Android framework.
 */
class LocationControllerTest {

    private val now = 1_800_000_000_000L

    private class FakeClock(var millis: Long) : Clock {
        override fun nowMillis(): Long = millis
    }

    private class FakeProvider(
        var foreground: Boolean = true,
        var background: Boolean = true,
        var enabled: Boolean = true,
        var fix: LocationFix? = null,
    ) : LocationProvider {
        var fixesTaken = 0
        var lastMaxAge: Long? = null
        override fun foregroundPermissionGranted() = foreground
        override fun backgroundPermissionGranted() = background
        override fun locationEnabled() = enabled
        override suspend fun currentFix(maxAgeMillis: Long, highAccuracy: Boolean, timeoutMillis: Long): LocationFix? {
            fixesTaken++
            lastMaxAge = maxAgeMillis
            return fix
        }
    }

    private class FakeReporter(var delivers: Boolean = true) : LocationReporter {
        val reports = mutableListOf<LocationReport>()
        override suspend fun report(report: LocationReport): Boolean {
            reports.add(report)
            return delivers
        }
    }

    private fun request(
        expiresAtMillis: Long? = null,
        maxAgeMillis: Long = OttoConstants.DEFAULT_LOCATION_MAX_AGE_MILLIS,
    ) = FcmCommand.RequestLocation(
        requestId = "req_1",
        maxAgeMillis = maxAgeMillis,
        expiresAtMillis = expiresAtMillis,
        highAccuracy = false,
        reason = "work out when to leave for the dentist",
    )

    private fun fix(mock: Boolean = false) = LocationFix(
        latitude = 51.5,
        longitude = -0.12,
        accuracyMeters = 18f,
        capturedAtMillis = now - 30_000,
        isMock = mock,
    )

    @Test
    fun takesAFixAndReportsIt() = runTest {
        val provider = FakeProvider(fix = fix())
        val reporter = FakeReporter()
        val controller = LocationController(provider, reporter, FakeClock(now))

        assertTrue(controller.fulfil(request()))

        val report = reporter.reports.single()
        assertEquals(LocationStatus.OK, report.status)
        assertEquals("req_1", report.requestId)
        assertEquals(51.5, report.fix!!.latitude, 0.0)
        // The time the FIX was taken, carried separately from when it was sent, so the server judges
        // staleness itself rather than accepting a replayed fix as current.
        assertEquals(now - 30_000, report.fix!!.capturedAtMillis)
    }

    @Test
    fun reportsEachRefusalDistinctly_andNeverTakesAFix() = runTest {
        // Silence is not an option: Otto is composing a reply right now, and "I can't" arriving
        // promptly is what lets it say "I've worked it out from home" instead of quietly guessing.
        val cases = listOf(
            FakeProvider(foreground = false) to LocationStatus.PERMISSION_DENIED,
            FakeProvider(background = false) to LocationStatus.BACKGROUND_DENIED,
            FakeProvider(enabled = false) to LocationStatus.LOCATION_DISABLED,
        )
        for ((provider, expected) in cases) {
            val reporter = FakeReporter()
            val controller = LocationController(provider, reporter, FakeClock(now))

            assertTrue(controller.fulfil(request()))

            assertEquals(expected, reporter.reports.single().status)
            assertNull(reporter.reports.single().fix)
            assertEquals(0, provider.fixesTaken)
        }
    }

    @Test
    fun foregroundOnlyIsItsOwnAnswer() = runTest {
        // Separated from PERMISSION_DENIED because it is a different sentence to the owner: they
        // granted something, and the thing they granted cannot answer a push.
        val reporter = FakeReporter()
        val controller = LocationController(FakeProvider(background = false), reporter, FakeClock(now))

        controller.fulfil(request())

        assertEquals(LocationStatus.BACKGROUND_DENIED, reporter.reports.single().status)
    }

    @Test
    fun reportsTimeoutRatherThanInventingAPosition() = runTest {
        val reporter = FakeReporter()
        val controller = LocationController(FakeProvider(fix = null), reporter, FakeClock(now))

        assertTrue(controller.fulfil(request()))

        assertEquals(LocationStatus.TIMEOUT, reporter.reports.single().status)
        assertNull(reporter.reports.single().fix)
    }

    @Test
    fun expiresBeforeSpendingAnythingAtAll() = runTest {
        // A request that sat through a retry chain is answering a question the server stopped
        // waiting on. Replying with the present about the past is worse than not replying, because
        // nothing downstream could tell the difference.
        val provider = FakeProvider(fix = fix())
        val reporter = FakeReporter()
        val controller = LocationController(provider, reporter, FakeClock(now))

        assertTrue(controller.fulfil(request(expiresAtMillis = now - 1)))

        assertEquals(LocationStatus.EXPIRED, reporter.reports.single().status)
        assertEquals(0, provider.fixesTaken)
    }

    @Test
    fun expiresOnItsOwnTtlWhenTheServerNamesNone() = runTest {
        val clock = FakeClock(now)
        val provider = FakeProvider(fix = fix())
        val reporter = FakeReporter()
        val controller = LocationController(provider, reporter, clock)

        // Same request object, answered far too late.
        val req = request()
        clock.millis = now + OttoConstants.LOCATION_REQUEST_TTL_MILLIS + 1
        controller.fulfil(req.copy(expiresAtMillis = now + OttoConstants.LOCATION_REQUEST_TTL_MILLIS))

        assertEquals(LocationStatus.EXPIRED, reporter.reports.single().status)
        assertEquals(0, provider.fixesTaken)
    }

    @Test
    fun anUndeliveredFixIsWorthAnotherAttempt() = runTest {
        // False means "try again WITH A FRESH FIX" — never "resend this one". Nothing is cached, so
        // there is nothing to replay even by accident.
        val reporter = FakeReporter(delivers = false)
        val controller = LocationController(FakeProvider(fix = fix()), reporter, FakeClock(now))

        assertFalse(controller.fulfil(request()))
    }

    @Test
    fun anUndeliveredRefusalIsNot() = runTest {
        // Retrying a refusal is pointless — the permission will not have changed in thirty seconds —
        // and the chain would keep a dead request alive past the moment it mattered.
        val reporter = FakeReporter(delivers = false)
        val controller = LocationController(FakeProvider(foreground = false), reporter, FakeClock(now))

        assertTrue(controller.fulfil(request()))
    }

    @Test
    fun passesTheServersMaxAgeThroughToTheProvider() = runTest {
        val provider = FakeProvider(fix = fix())
        val controller = LocationController(provider, FakeReporter(), FakeClock(now))

        controller.fulfil(request(maxAgeMillis = 45_000))

        assertEquals(45_000L, provider.lastMaxAge)
    }

    @Test
    fun carriesTheMockFlagRatherThanDroppingTheFix() = runTest {
        // Reported, not filtered: the SERVER decides whether to plan from a spoofed origin, and it
        // cannot decide about something the phone silently swallowed.
        val reporter = FakeReporter()
        val controller = LocationController(FakeProvider(fix = fix(mock = true)), reporter, FakeClock(now))

        controller.fulfil(request())

        assertTrue(reporter.reports.single().fix!!.isMock)
    }
}
