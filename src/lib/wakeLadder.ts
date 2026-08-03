/**
 * The wake-check ladder: when to ask "you up?" after an alarm is dismissed, and what to say.
 *
 * Pure, like `nagLadder`, and for the same reasons — it is the one part of the feature worth
 * reasoning about in isolation, and every instant it produces is derived from the dismissal rather
 * than from `Date.now()`, so a late tick lands the ladder where it always would have.
 */

/** Chat rounds before the ringer takes over. Three is the whole budget; a fourth is nagging. */
export const MAX_WAKE_ROUNDS = 3

/**
 * Minutes between rounds, from the dismissal: 12, then 10, then 10.
 *
 * The first gap is the longest on purpose — plenty of people dismiss an alarm and are genuinely up
 * ninety seconds later, and asking then is just noise. After that the gaps tighten, because by the
 * second ask the question has stopped being polite and started being a check.
 *
 * A round past the last gap reuses the last one, which is what gives the escalation tick a time.
 */
const GAP_MINUTES = [12, 10, 10]

/** The instant round `round` (0-based) is due, measured from the dismissal. */
export function wakeCheckAt(round: number, fromMillis: number): number {
  let offset = 0
  for (let r = 0; r <= round; r++) offset += GAP_MINUTES[Math.min(r, GAP_MINUTES.length - 1)]!
  return fromMillis + offset * 60_000
}

/**
 * What to send on each round.
 *
 * Deterministic rather than LLM-written, for exactly the reasons `nudgeText` is: one sentence with
 * one variable, seen dozens of times, and it has to work at 06:30 on a machine with no Anthropic
 * key. Latency matters more here than anywhere else — a 15s round trip is a big fraction of the
 * whole window in which the answer is still meaningful.
 */
export function wakeText(round: number, label: string): string {
  switch (round) {
    case 0:
      return 'You up?'
    case 1:
      return 'Still nothing. Are you up?'
    default:
      return `${label} was half an hour ago and you've gone quiet. Last ask before I ring the phone again.`
  }
}
