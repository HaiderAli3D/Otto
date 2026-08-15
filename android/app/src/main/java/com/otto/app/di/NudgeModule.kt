package com.otto.app.di

import com.otto.app.nudge.NudgeScheduler
import com.otto.app.nudge.NudgeSchedulerImpl
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * The nudge path's own bindings, kept out of [AlarmModule] on purpose: the two schedulers are
 * separate interfaces so that nothing can accidentally hand a nudge to the alarm path, and keeping
 * their modules separate is what makes that separation visible rather than merely true.
 */
@Module
@InstallIn(SingletonComponent::class)
abstract class NudgeModule {

    @Binds
    @Singleton
    abstract fun bindNudgeScheduler(impl: NudgeSchedulerImpl): NudgeScheduler
}
