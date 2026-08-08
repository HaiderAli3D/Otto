package com.otto.app.data

import androidx.room.TypeConverter

/**
 * Stores [AlarmState] and [NudgeState] as their enum names.
 *
 * Nudge conversion lives here rather than in a class of its own: a second `@TypeConverters` entry
 * on the database is churn for no gain, converters do not affect the schema identity hash, and the
 * class name being a slight misnomer is cheaper than the risk of touching the database annotation.
 * The DAOs' SQL-literal state guards depend on this enum-name storage.
 */
class AlarmConverters {
    @TypeConverter
    fun stateToString(state: AlarmState): String = state.name

    @TypeConverter
    fun stringToState(value: String): AlarmState = AlarmState.valueOf(value)

    @TypeConverter
    fun nudgeStateToString(state: NudgeState): String = state.name

    @TypeConverter
    fun stringToNudgeState(value: String): NudgeState = NudgeState.valueOf(value)
}
