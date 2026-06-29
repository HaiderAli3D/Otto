package com.otto.app.di

import com.otto.app.ring.AlarmRinger
import com.otto.app.ring.SimpleRinger
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
abstract class RingModule {

    @Binds
    @Singleton
    abstract fun bindAlarmRinger(impl: SimpleRinger): AlarmRinger
}
