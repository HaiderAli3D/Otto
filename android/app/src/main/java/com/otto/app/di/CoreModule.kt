package com.otto.app.di

import com.otto.app.core.Clock
import com.otto.app.core.DefaultDispatcherProvider
import com.otto.app.core.DispatcherProvider
import com.otto.app.core.SystemClock
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/** Binds the cross-cutting core interfaces to their implementations. */
@Module
@InstallIn(SingletonComponent::class)
abstract class CoreModule {

    @Binds
    @Singleton
    abstract fun bindClock(impl: SystemClock): Clock

    @Binds
    @Singleton
    abstract fun bindDispatcherProvider(impl: DefaultDispatcherProvider): DispatcherProvider
}
