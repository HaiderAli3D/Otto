package com.otto.app.data

import androidx.room.testing.MigrationTestHelper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Verifies the v1 → v2 migration on a real SQLite engine (fixes #2 and #4). Run on a
 * device/emulator: `./gradlew :app:connectedDebugAndroidTest`. Reads the exported schemas from
 * `app/schemas` (wired as androidTest assets in build.gradle.kts).
 */
@RunWith(AndroidJUnit4::class)
class MigrationTest {

    @get:Rule
    val helper = MigrationTestHelper(
        InstrumentationRegistry.getInstrumentation(),
        OttoDatabase::class.java,
    )

    @Test
    fun migrate1To2_preservesAlarms_backfillsUniqueRequestCodes_addsOutbox() {
        // Seed two v1 alarms (v1 has no requestCode column and no alarm_events table).
        helper.createDatabase(TEST_DB, 1).apply {
            execSQL(
                "INSERT INTO alarms (alarmId, triggerAtMillis, label, state, allowWhileIdle, " +
                    "snoozeCount, createdAtMillis, updatedAtMillis, reportedToServer) " +
                    "VALUES ('alm_a', 1000, 'A', 'ARMED', 1, 0, 0, 0, 0)",
            )
            execSQL(
                "INSERT INTO alarms (alarmId, triggerAtMillis, label, state, allowWhileIdle, " +
                    "snoozeCount, createdAtMillis, updatedAtMillis, reportedToServer) " +
                    "VALUES ('alm_b', 2000, 'B', 'ARMED', 1, 0, 0, 0, 0)",
            )
            close()
        }

        val db = helper.runMigrationsAndValidate(TEST_DB, 2, true, MIGRATION_1_2)

        // Both alarms survive with distinct, non-zero request codes (fix #4).
        db.query("SELECT requestCode FROM alarms ORDER BY alarmId").use { c ->
            assertEquals(2, c.count)
            val codes = mutableSetOf<Int>()
            while (c.moveToNext()) codes += c.getInt(0)
            assertEquals("request codes must be distinct", 2, codes.size)
            assertTrue("request codes must be backfilled (non-zero)", codes.none { it == 0 })
        }
        // The outbox table exists and starts empty (fix #2).
        db.query("SELECT COUNT(*) FROM alarm_events").use { c ->
            c.moveToFirst()
            assertEquals(0, c.getInt(0))
        }
        db.close()
    }

    private companion object {
        const val TEST_DB = "migration-test"
    }
}
