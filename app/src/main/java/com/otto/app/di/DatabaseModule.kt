package com.otto.app.di

import android.content.Context
import androidx.room.Room
import com.otto.app.data.AlarmDao
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
        Room.databaseBuilder(context, OttoDatabase::class.java, OttoDatabase.NAME).build()

    @Provides
    fun provideAlarmDao(database: OttoDatabase): AlarmDao = database.alarmDao()
}
