package com.otto.app.data

import androidx.room.TypeConverter

/** Stores [AlarmState] as its enum name. */
class AlarmConverters {
    @TypeConverter
    fun stateToString(state: AlarmState): String = state.name

    @TypeConverter
    fun stringToState(value: String): AlarmState = AlarmState.valueOf(value)
}
