package com.otto.app.nudge

/**
 * A button the owner can press on a nudge, from the lockscreen, without unlocking.
 *
 * This is the half of the feature that makes the other half tolerable. A one-way channel that
 * chases you five times a day and can only be swiped away trains you to swipe; one you can resolve
 * with a single tap closes the loop where the owner already is, rather than making them open
 * WhatsApp to say "done".
 */
enum class NudgeAction {
    /** The task is finished. Resolves the nudge and tells the server to complete the reminder. */
    DONE,

    /** Come back in [com.otto.app.data.NudgeEntity.snoozeMinutes]. Re-shown locally, offline-safe. */
    SNOOZE,

    /** Not today. Clears it here and leaves the next move to the server's ladder. */
    LATER,

    /** Open the app. The one action that legitimately needs an unlock. */
    OPEN,
    ;

    companion object {
        /**
         * Android renders at most three actions on a notification; a fourth is silently dropped by
         * the platform, which would make the contract quietly untrue rather than visibly wrong.
         */
        const val MAX_ACTIONS = 3

        /** What a nudge gets when the server says nothing: resolve it, or push it back. */
        val DEFAULT: List<NudgeAction> = listOf(DONE, SNOOZE)

        /**
         * Parse the CSV the server sends, dropping tokens this build does not know.
         *
         * An explicitly empty string means a pure FYI with no buttons, and is distinguished from an
         * absent field — which is why the caller passes `null` for absent and `""` for empty. That
         * distinction is what lets `level=SILENT, actions=""` be a plain notification without
         * needing a second command type for it.
         */
        fun parseCsv(csv: String?): List<NudgeAction> {
            if (csv == null) return DEFAULT
            if (csv.isBlank()) return emptyList()
            return csv.split(',')
                .mapNotNull { token ->
                    val trimmed = token.trim()
                    entries.firstOrNull { it.name.equals(trimmed, ignoreCase = true) }
                }
                .distinct()
                .take(MAX_ACTIONS)
        }
    }
}
