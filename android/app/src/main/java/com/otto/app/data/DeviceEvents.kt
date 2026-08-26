package com.otto.app.data

/**
 * The event vocabulary the device reports, and the dedupe keys that bound it.
 *
 * Pure and Android-free so the bucketing rule is unit-testable without a database.
 */
object DeviceEvents {

    const val KIND_NUDGE = "NUDGE"
    const val KIND_PUSH = "PUSH"

    /** Shown on screen. */
    const val NUDGE_SHOWN = "SHOWN"

    /** The owner pressed Done: the task is finished. */
    const val NUDGE_DONE = "DONE"

    /** The owner pressed Snooze; [DeviceEventEntity.untilMillis] says until when. */
    const val NUDGE_SNOOZED = "SNOOZED"

    /** The owner pressed Not today. The next move is the server's. */
    const val NUDGE_DEFERRED = "DEFERRED"

    /** The owner opened the app from it. */
    const val NUDGE_OPENED = "OPENED"

    /**
     * Swiped away without acting.
     *
     * Worth the handful of lines it costs: "seen and ignored" is a genuinely different signal from
     * "never delivered", and it is the one a chase ladder should escalate on. Nothing else in the
     * system can tell those two apart.
     */
    const val NUDGE_DISMISSED = "DISMISSED"

    /**
     * The SERVER withdrew it — the reminder was completed or cancelled somewhere else.
     *
     * Split out from [NUDGE_DISMISSED] because the server cannot otherwise tell the two apart, and
     * it reads that column to decide whether the owner is awake: `lastActivityAt` gates the
     * wake-check stand-down, so a nudge Otto itself withdrew mid-ladder looked exactly like the
     * owner clearing one, and the ladder stood down on its own doing. The comment in
     * `NudgeController.cancel` claimed no event was written at all; `NudgeRepository.resolve`
     * always writes one.
     */
    const val NUDGE_WITHDRAWN = "WITHDRAWN"

    /** Its window closed before anyone saw it. */
    const val NUDGE_EXPIRED = "EXPIRED"

    /**
     * The device could not act on a push.
     *
     * Reported because a contract mismatch is otherwise invisible on BOTH sides: the server logs a
     * successful send, the phone logs a drop, and nobody correlates them. With two new command
     * types and eight new fields that is the likeliest failure in the system.
     */
    const val PUSH_REJECTED = "REJECTED"

    private const val HOUR_MILLIS = 3_600_000L

    /**
     * One row per nudge per event per instant — the same shape the server dedupes alarm events on.
     */
    fun nudgeKey(nudgeId: String, event: String, atMillis: Long): String = "NUDGE:$nudgeId:$event:$atMillis"

    /**
     * One row per rejected push `type` per hour, however many arrive.
     *
     * A server bug that sends a malformed type on a five-minute schedule would otherwise fill the
     * outbox with identical rows and push every genuine nudge event behind them — ReportWorker
     * drains in order and stops at the first failure, so a flood is not merely noise, it is a
     * blockage.
     */
    fun pushRejectionKey(type: String, atMillis: Long): String = "PUSH:$type:REJECTED:${atMillis / HOUR_MILLIS}"
}
