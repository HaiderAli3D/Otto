package com.otto.app.di

import com.otto.app.location.FusedLocationProvider
import com.otto.app.location.LocationProvider
import com.otto.app.location.LocationReporter
import com.otto.app.net.ServerLocationReporter
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * Binds the two seams the location path is built on.
 *
 * Both exist so [com.otto.app.location.LocationController] — which owns the only interesting logic:
 * refuse, expire, take one fix, report, never cache — stays free of Play Services and Retrofit and
 * can be exercised by hand-written fakes on the JVM. The project prefers those to mocking libraries.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class LocationModule {

    @Binds
    @Singleton
    abstract fun bindLocationProvider(impl: FusedLocationProvider): LocationProvider

    @Binds
    @Singleton
    abstract fun bindLocationReporter(impl: ServerLocationReporter): LocationReporter
}
