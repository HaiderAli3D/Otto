import { nextLocalTimeAt } from '../services/time.js'
import { deferPastQuietHours, type QuietHours } from './quietHours.js'
import { DEFAULT_ROUTINE, dayStartHour, dayStartMinute, type Routine } from './routine.js'
import {
  ABSOLUTE_MAX_RUNGS,
  DEFAULT_TIMING_KIND,
  planRungs,
  tightestGap,
  type NagPlanSpec,
  type NagPolicy,
  type ResolvedPlan,
  type TimingKind,
} from './rungPlan.js'

// The policy vocabulary lives in rungPlan.ts beside the tables it indexes, but every consumer in
// the codebase imports it from here. Re-exported rather than moved so none of them has to change.
export {
  isNagPolicy,
  isTimingKind,
  NAG_POLICIES,
  TIMING_KINDS,
  DEFAULT_NAG_POLICY,
  DEFAULT_TIMING_KIND,
  type NagPlanSpec,
  type NagPolicy,
  type TimingKind,
} from './rungPlan.js'

/**
 * Historic name for the post-due ceiling on `trigger` × `persistent`.
 *
 * It is no longer a global: each (timing kind × policy) pair carries its own `maxChases` in the
 * table, and they range from 2 to 24. This export survives with its original value because that
 * one cell still holds it, and because callers and tests reference it by name. Do not "fix" it by
 * raising it — raise the cell.
 */
export const MAX_NAGS = 8

const MINUTE = 60_000

/**
 * The floor under every rung from 1 upward: no chase may land sooner than this after the one that
 * just went out. Kept exported and unrenamed because `services/brief.ts` imports it for
 * `holdNudgesCoveredByBrief`, where its meaning is unchanged.
 *
 * Rungs are offsets from the DUE time rather than from each other, and that is what makes a floor
 * necessary. A quiet window swallows several of them whole: a 23:00 reminder's +30m/+2h/+6h rungs
 * are 23:30, 01:00 and 05:00, all inside 22:00–07:00, and deferring each one independently lands
 * all three on the same 07:00. `runNudge` queues the next rung the instant it sends the current one
 * and every rung carries its own dedupe key, so nothing downstream suppresses the pile-up — the
 * owner gets three escalating chases inside two scheduler ticks, with rungs 2 and 3 burned against
 * someone who has not yet had a chance to reply.
 *
 * Measuring from `nowMillis` is what makes this work: whenever the ladder is called from
 * `runNudge`, `nowMillis` IS the instant the previous rung fired. It also makes the ladder
 * monotonic for a reminder that was already hours overdue when it was created — `dueAtMillis + 30m`
 * would otherwise be in the PAST, and `runNudge`'s staleness gate would retire that rung without
 * ever sending it.
 */
export const MIN_RUNG_GAP_MS = 30 * MINUTE

/**
 * The spacing floor for one intensity, before the ladder's own shape is taken into account.
 *
 * Per-policy rather than global because the floor exists to catch a pile-up, not to override the
 * table. A single global 3 minutes would reinstate for `gentle` exactly the collapse
 * `MIN_RUNG_GAP_MS` documents.
 *
 * This is only ever a CEILING on the real floor — see `spacingFloor`. On its own it is not safe to
 * apply, because a ladder can ask for rungs closer together than its policy's nominal spacing.
 */
export function minRungGapMs(policy: NagPolicy): number {
  switch (policy) {
    case 'hard':
      return 10 * MINUTE
    case 'relentless':
      return 3 * MINUTE
    default:
      return MIN_RUNG_GAP_MS
  }
}

/**
 * The floor actually applied: the policy's nominal spacing, or this ladder's own tightest gap,
 * whichever is smaller.
 *
 * Taking the minimum is what keeps the floor's justification true. It is there to separate rungs a
 * quiet window collapsed onto one instant, and it must never be wide enough to move a rung the
 * table placed deliberately. `appointment` × `persistent` is the case that proved it: its lead
 * rungs are 20 minutes apart, so a flat 30-minute floor pushed the last warning forward onto the
 * appointment itself and the owner got the heads-up and the "it's now" in the same breath.
 */
function spacingFloor(policy: NagPolicy, plan: ResolvedPlan, dueAtMillis: number): number {
  return Math.min(minRungGapMs(policy), tightestGap(plan, dueAtMillis))
}

/** Where a rung sits relative to the due time. Drives wording, and nothing else. */
export type RungPhase = 'lead' | 'due' | 'overdue'

export function rungPhaseFor(leadCount: number, nagCount: number): RungPhase {
  if (nagCount < leadCount) return 'lead'
  if (nagCount === leadCount) return 'due'
  return 'overdue'
}

/**
 * The absolute instant of rung `index`, before spacing and quiet hours are applied.
 *
 * Null means the ladder is spent: either the post-due budget is used up or an `appointment` has
 * run out of things to say. The reminder stays OPEN either way and still shows in lists, digests
 * and the brief — it just stops pestering.
 */
function rungInstant(
  plan: ResolvedPlan,
  index: number,
  dueAtMillis: number,
  zone: string,
  nowMillis: number,
  routine: Routine,
): number | null {
  if (index < plan.leadAt.length) return plan.leadAt[index]!

  const postDue = index - plan.leadAt.length
  if (postDue >= plan.maxChases) return null
  if (postDue < plan.chase.length) return dueAtMillis + plan.chase[postDue]!
  if (plan.tail === 'stop') return null

  // Daily from here, on the owner's own morning rather than a fixed 09:00. Computed as a wall-clock
  // time in the device zone rather than by adding hours to a UTC instant — otherwise a UK owner's
  // nudges drift by an hour every summer.
  return nextLocalTimeAt(Math.max(dueAtMillis, nowMillis), zone, dayStartHour(routine), dayStartMinute(routine))
}

/**
 * When to nudge next, or null when the ladder is exhausted.
 *
 * `nagCount` is how many nudges have ALREADY been sent, so 0 means "the first one is due". Which
 * rung that indexes depends on the timing kind: for a `trigger` rung 0 is the due instant, and for
 * a `deadline` it is the first warning in the run-up, days before anything is late.
 *
 * Every parameter past `quiet` is optional and defaults to the pre-timing behaviour — `trigger`,
 * the default routine (day starts 09:00), no explicit plan. That is deliberate and is what lets
 * the four external schedulers that reach this function keep calling it unchanged.
 *
 * `quiet` is the PRIMARY quiet-hours choke point for the whole system. Deferring here means nothing
 * is ever SCHEDULED into the window in the first place — far better than filtering at delivery,
 * where a suppressed nudge has already burned its rung. Omitting it (or passing null) reproduces
 * the pre-quiet-hours behaviour byte for byte.
 */
export function nextNagAt(params: {
  policy: NagPolicy
  nagCount: number
  dueAtMillis: number | null
  zone: string
  nowMillis: number
  quiet?: QuietHours
  kind?: TimingKind
  plannedAtMillis?: number
  routine?: Routine
  plan?: NagPlanSpec | null
}): number | null {
  const { policy, nagCount, dueAtMillis, zone, nowMillis } = params
  const quiet = params.quiet ?? null
  const kind = params.kind ?? DEFAULT_TIMING_KIND
  const routine = params.routine ?? DEFAULT_ROUTINE

  if (policy === 'off') return null
  // Undated ("someday") reminders never nag on a clock; they surface in lists and the digest.
  if (dueAtMillis === null) return null
  if (nagCount >= ABSOLUTE_MAX_RUNGS) return null

  const plan = planRungs({
    kind,
    policy,
    dueAtMillis,
    plannedAtMillis: params.plannedAtMillis ?? nowMillis,
    zone,
    override: params.plan ?? null,
    // Passed so a warning that quiet hours would push past its own deadline is dropped at plan
    // time rather than delivered late.
    quiet,
  })

  const at = rungInstant(plan, nagCount, dueAtMillis, zone, nowMillis, routine)
  if (at === null) return null

  // The rung that lands ON the due instant is never moved, by spacing or by quiet hours, as long as
  // it is still ahead of us. That instant is the one the owner picked, so a reminder due 23:30
  // nudges at 23:30 even inside a quiet window. Explicit per-item intent beats a global default,
  // and a window that silently moved the owner's own chosen time would make the feature read as
  // broken rather than considerate. Once the due time is behind us we are picking the instant
  // ourselves, so the window applies again.
  //
  // Keyed on the OFFSET being zero rather than the index being zero: with lead rungs the due
  // instant sits at index `leadAt.length`, not at 0.
  if (at === dueAtMillis && at >= nowMillis) return at

  // Nothing has gone out yet, so there is nothing to space this from. Without this branch a
  // reminder created after its own due time would be pushed half an hour into the future instead
  // of being chased promptly.
  if (nagCount === 0) return deferPastQuietHours(Math.max(at, nowMillis), zone, quiet)

  // Every rung past the first, settled: hold it off the heels of the one that just fired, THEN push
  // it out of the quiet window.
  //
  // That order is load-bearing. Flooring after the deferral could push a rung that had legitimately
  // cleared the window (say 21:55, with the window opening at 22:00) straight back into it.
  return deferPastQuietHours(Math.max(at, nowMillis + spacingFloor(policy, plan, dueAtMillis)), zone, quiet)
}

/**
 * The next `count` rungs as absolute instants, walked the way `runNudge` actually walks them.
 *
 * Each result is fed back as the following call's `nowMillis`, because that is what happens in
 * production: the ladder is re-entered at the moment the previous rung fires. Anything that
 * previewed the schedule by holding `nowMillis` still would show the owner a set of times the
 * system will never produce.
 */
export function previewRungs(
  params: Parameters<typeof nextNagAt>[0],
  count: number,
): number[] {
  const out: number[] = []
  let nagCount = params.nagCount
  let now = params.nowMillis
  for (let i = 0; i < count; i++) {
    const at = nextNagAt({ ...params, nagCount, nowMillis: now })
    if (at === null) break
    out.push(at)
    nagCount++
    now = at
  }
  return out
}

/**
 * Escalating nudge wording, indexed by where the rung sits rather than by how many have gone out.
 *
 * Templated rather than LLM-generated: it is one sentence with one variable, the owner will see it
 * dozens of times, and phase-indexed phrasing reads as escalation instead of a bot repeating
 * itself. It also works at 3am with no API key and no latency.
 *
 * A `lead` rung is NEVER a scolding. Nothing is late yet — a warning three hours before a deadline
 * that reads like a chase teaches the owner to ignore the ones that aren't.
 */
export function nudgeTextFor(ctx: {
  title: string
  phase: RungPhase
  index: number
  overdueDescription?: string
}): string {
  const { title, phase, index, overdueDescription } = ctx
  if (phase === 'lead') {
    if (index === 0) return `${title} — heads up, that one's coming.`
    if (index === 1) return `${title} — that's due soon.`
    return `${title} — not long left on that.`
  }
  if (phase === 'due') return `${title}.`
  switch (index) {
    case 0:
      return `Still need to ${lowerFirst(title)}? Say done when it's sorted.`
    case 1:
      return `Nudge: ${lowerFirst(title)} is still open.`
    default:
      return overdueDescription
        ? `${title} — ${overdueDescription}. Done, or shall I drop it?`
        : `${title} is still outstanding. Done, or shall I drop it?`
  }
}

/**
 * The pre-timing wording, byte for byte.
 *
 * Kept as a thin wrapper rather than deleted: it is the fallback `agent/nudge.ts` degrades to when
 * the API is unreachable, and `test/persona.test.ts` pins its exact output for a fixed set of
 * counts. Callers that know the phase should use `nudgeTextFor` directly.
 */
export function nudgeText(title: string, nagCount: number, overdueDescription?: string): string {
  if (nagCount === 0) return nudgeTextFor({ title, phase: 'due', index: 0 })
  return nudgeTextFor({ title, phase: 'overdue', index: nagCount - 1, overdueDescription })
}

function lowerFirst(s: string): string {
  return s.length > 0 ? s[0]!.toLowerCase() + s.slice(1) : s
}
