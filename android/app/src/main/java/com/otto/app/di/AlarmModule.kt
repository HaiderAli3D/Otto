package com.otto.app.di

import com.otto.app.alarm.AlarmScheduler
import com.otto.app.alarm.AlarmSchedulerImpl
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class AlarmModule {

    @Binds
    @Singleton
    abstract fun bindAlarmScheduler(impl: AlarmSchedulerImpl): AlarmScheduler
}
