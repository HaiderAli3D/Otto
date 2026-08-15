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
 * Verifies every migration on a real SQLite engine. Run on a device/emulator:
 * `./gradlew :app:connectedDebugAndroidTest`. Reads the exported schemas from `app/schemas` (wired
 * as androidTest assets in build.gradle.kts).
 *
 * This is the one test that must pass before installing a new build over an existing one. There is
 * no `fallbackToDestructiveMigration`, so a migration that does not reproduce the generated schema
 * exactly throws at first open — and on a phone whose job is ringing alarms, that means the alarms
 * stop and the owner finds out by oversleeping.
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

    @Test
    fun migrate2To3_preservesAlarmsAndOutbox_addsNudgeTables() {
        helper.createDatabase(TEST_DB, 2).apply {
            execSQL(
                "INSERT INTO alarms (alarmId, triggerAtMillis, label, state, allowWhileIdle, " +
                    "snoozeCount, createdAtMillis, updatedAtMillis, reportedToServer, requestCode) " +
                    "VALUES ('alm_a', 1000, 'A', 'ARMED', 1, 0, 0, 0, 0, 7)",
            )
            execSQL("INSERT INTO alarm_events (alarmId, event, atMillis) VALUES ('alm_a', 'ARMED', 1000)")
            close()
        }

        val db = helper.runMigrationsAndValidate(TEST_DB, 3, true, MIGRATION_2_3)

        // v3 is purely additive: nothing the alarm path depends on may be disturbed by it.
        db.query("SELECT alarmId, requestCode FROM alarms").use { c ->
            assertEquals(1, c.count)
            c.moveToFirst()
            assertEquals("alm_a", c.getString(0))
            assertEquals(7, c.getInt(1))
        }
        db.query("SELECT COUNT(*) FROM alarm_events").use { c ->
            c.moveToFirst()
            assertEquals("the alarm outbox must survive untouched", 1, c.getInt(0))
        }
        for (table in listOf("nudges", "device_events")) {
            db.query("SELECT COUNT(*) FROM $table").use { c ->
                c.moveToFirst()
                assertEquals("$table must exist and start empty", 0, c.getInt(0))
            }
        }
        db.close()
    }

    @Test
    fun migrate2To3_dedupeKeyIndexIsUnique() {
        // Asserted at the DDL level rather than in Kotlin because the index IS the rate limiter for
        // push-rejection reporting. If it were created non-unique the app would still compile, still
        // run, and quietly let a looping server bug fill the outbox — and ReportWorker drains in
        // order and stops at the first failure, so a flood there is a blockage, not just noise.
        helper.createDatabase(TEST_DB, 2).close()
        val db = helper.runMigrationsAndValidate(TEST_DB, 3, true, MIGRATION_2_3)

        val insert = "INSERT OR IGNORE INTO device_events (kind, refId, event, atMillis, dedupeKey) " +
            "VALUES ('PUSH', 'LAUNCH_ROCKET', 'REJECTED', 1000, 'PUSH:LAUNCH_ROCKET:REJECTED:1')"
        db.execSQL(insert)
        db.execSQL(insert)

        db.query("SELECT COUNT(*) FROM device_events").use { c ->
            c.moveToFirst()
            assertEquals("a duplicate dedupeKey must not produce a second row", 1, c.getInt(0))
        }
        db.close()
    }

    @Test
    fun migrate1To3_chainsBothMigrations() {
        // Cheap, and the only thing that catches a broken chain for a device still on v1.
        helper.createDatabase(TEST_DB, 1).apply {
            execSQL(
                "INSERT INTO alarms (alarmId, triggerAtMillis, label, state, allowWhileIdle, " +
                    "snoozeCount, createdAtMillis, updatedAtMillis, reportedToServer) " +
                    "VALUES ('alm_a', 1000, 'A', 'ARMED', 1, 0, 0, 0, 0)",
            )
            close()
        }

        val db = helper.runMigrationsAndValidate(TEST_DB, 3, true, MIGRATION_1_2, MIGRATION_2_3)

        db.query("SELECT requestCode FROM alarms").use { c ->
            c.moveToFirst()
            assertTrue("the v1 -> v2 backfill must still have happened", c.getInt(0) != 0)
        }
        db.query("SELECT COUNT(*) FROM nudges").use { c ->
            c.moveToFirst()
            assertEquals(0, c.getInt(0))
        }
        db.close()
    }

    private companion object {
        const val TEST_DB = "migration-test"
    }
}
