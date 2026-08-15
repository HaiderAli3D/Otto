package com.otto.app.di

import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object AppModule {

    /**
     * Application-lifetime coroutine scope for fire-and-forget work that must outlive the
     * short-lived component that started it (e.g. a BroadcastReceiver's goAsync block, or a
     * dismissed Activity persisting its outcome). SupervisorJob so one failure can't cancel
     * unrelated work.
     */
    @Provides
    @Singleton
    fun provideApplicationScope(): CoroutineScope =
        CoroutineScope(SupervisorJob() + Dispatchers.Default)
}
