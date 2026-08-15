package com.otto.app.di

import android.content.Context
import androidx.room.Room
import com.otto.app.data.AlarmDao
import com.otto.app.data.MIGRATION_1_2
import com.otto.app.data.MIGRATION_2_3
import com.otto.app.data.NudgeDao
import com.otto.app.data.OttoDatabase
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): OttoDatabase =
        Room.databaseBuilder(context, OttoDatabase::class.java, OttoDatabase.NAME)
            // No fallbackToDestructiveMigration, deliberately: this database holds the alarms the
            // owner is relying on, and silently wiping them to recover from a schema mistake is a
            // worse outcome than failing loudly. Every version bump needs a hand-written migration.
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .build()

    @Provides
    fun provideAlarmDao(database: OttoDatabase): AlarmDao = database.alarmDao()

    @Provides
    fun provideNudgeDao(database: OttoDatabase): NudgeDao = database.nudgeDao()
}
