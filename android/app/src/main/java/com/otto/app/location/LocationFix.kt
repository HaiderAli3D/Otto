package com.otto.app.location

/**
 * One position, taken once, on request.
 *
 * Deliberately NOT a Room entity and deliberately not cached anywhere. The fix is taken and posted
 * inside a single operation, so there is no moment at which a coordinate exists needing somewhere to
 * live — which is what makes "Otto keeps no location history" true by construction rather than by a
 * retention job that could be got wrong.
 */
data class LocationFix(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Float?,
    /** When the FIX was taken. The server judges staleness on this, never on when it arrived. */
    val capturedAtMillis: Long,
    /** Android says this came from a mock provider. The server refuses to plan a journey from one. */
    val isMock: Boolean,
)

/**
 * What happened when Otto asked.
 *
 * Every one of these is REPORTED. Silence is not an option the phone has: the server is waiting on
 * an answer inside a live conversation, and "I can't" arriving promptly is what lets Otto say
 * "I don't have location permission, so I've worked it out from home" instead of quietly guessing
 * and sounding certain.
 *
 * The refusals are separated because they mean different things to the owner. PERMISSION_DENIED and
 * BACKGROUND_DENIED are settings they can change and Otto may mention once; LOCATION_DISABLED is
 * device-wide; TIMEOUT and UNAVAILABLE are just weather.
 */
enum class LocationStatus {
    OK,
    PERMISSION_DENIED,
    BACKGROUND_DENIED,
    LOCATION_DISABLED,
    TIMEOUT,

    /** The request outlived its usefulness. A late fix is a wrong answer, not a slow one. */
    EXPIRED,
    UNAVAILABLE,
    ERROR,
    ;

    val wire: String get() = name
}

/** One answer, ready to post. */
data class LocationReport(
    val requestId: String,
    val status: LocationStatus,
    val fix: LocationFix?,
    val atMillis: Long,
    val detail: String? = null,
)
