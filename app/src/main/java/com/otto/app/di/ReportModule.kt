package com.otto.app.di

import android.content.Context
import com.otto.app.core.ReportTrigger
import com.otto.app.net.ReportWorker
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/** Binds the production [ReportTrigger] to a WorkManager-backed drain of the event outbox. */
@Module
@InstallIn(SingletonComponent::class)
object ReportModule {
    @Provides
    @Singleton
    fun provideReportTrigger(@ApplicationContext context: Context): ReportTrigger =
        ReportTrigger { ReportWorker.enqueue(context) }
}
