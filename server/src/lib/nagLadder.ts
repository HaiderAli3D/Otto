import { nextLocalTimeAt } from '../services/time.js'
import { deferPastQuietHours, inQuietHours, type QuietHours } from './quietHours.js'
import { spreadOffsetMs } from './spread.js'
import { DEFAULT_ROUTINE, dayStartHour, dayStartMinute, type Routine } from './routine.js'
import {
  ABSOLUTE_MAX_RUNGS,
  DEFAULT_TIMING_KIND,
  planRungs,
  planUndatedRungs,
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
function spacingFloor(policy: NagPolicy, plan: ResolvedPlan, anchorMillis: number): number {
  return Math.min(minRungGapMs(policy), tightestGap(plan, anchorMillis))
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
/**
 * Which branch of the table produced a rung. Read only by the spread, which must be able to tell a
 * daily-tail rung — the same day-start instant for every exhausted ladder in the database — from a
 * chase rung, which already varies per item because it is an offset from the owner's own due time.
 *
 * Returned from here rather than recomputed by the caller so the test can never drift from the
 * branch: there is exactly one place that decides a rung is a daily one, and it is the line below.
 */
export type RungSource = 'lead' | 'chase' | 'dailyTail'

function rungInstant(
  plan: ResolvedPlan,
  index: number,
  anchorMillis: number,
  zone: string,
  nowMillis: number,
  routine: Routine,
): { at: number; source: RungSource } | null {
  if (index < plan.leadAt.length) return { at: plan.leadAt[index]!, source: 'lead' }

  const postDue = index - plan.leadAt.length
  if (postDue >= plan.maxChases) return null
  if (postDue < plan.chase.length) return { at: anchorMillis + plan.chase[postDue]!, source: 'chase' }
  if (plan.tail === 'stop') return null

  // Daily from here, on the owner's own morning rather than a fixed 09:00. Computed as a wall-clock
  // time in the device zone rather than by adding hours to a UTC instant — otherwise a UK owner's
  // nudges drift by an hour every summer.
  return {
    at: nextLocalTimeAt(Math.max(anchorMillis, nowMillis), zone, dayStartHour(routine), dayStartMinute(routine)),
    source: 'dailyTail',
  }
}

/**
 * Fan out an instant OTTO chose that carries no per-item variation. Returns `at` unchanged otherwise.
 *
 * Exactly two such instants exist, and they are the two pile-ups the owner experiences as a burst:
 * the exclusive END of a quiet window, which `deferPastQuietHours` returns with no spread at all, so
 * every rung held overnight resolves to one millisecond; and the daily tail rung, which is the same
 * `dayStartHour` for every ladder that has run out of chases. Everything else is already anchored to
 * a due time the owner picked and spreads itself.
 *
 * Deliberately NOT inside `deferPastQuietHours`. Three things depend on that function's exact
 * output: `runNudge` compares it for EQUALITY to decide whether the assumed-attendance gate wrote an
 * instant, `rungPlan` uses it inside the lead-rung survival filter, and two paths re-defer an
 * already-deferred instant and rely on it being a fixpoint. It also has no per-item key and must not
 * grow one.
 *
 * Only ever moves an instant LATER, so it cannot undercut the spacing floor and cannot invert two
 * rungs of the same reminder — rung N+1's base is measured from when rung N actually FIRED, which is
 * the spread instant, not the unspread one.
 */
function spreadSelfChosen(p: {
  at: number
  base: number
  source: RungSource
  dueAtMillis: number | null
  key: string | undefined
  zone: string
  quiet: QuietHours
}): number {
  // No key means the caller is one of the four external schedulers that predate this, or a test
  // pinning the pre-spread instants. Same backwards-compatibility contract as `routine` and `plan`.
  if (p.key === undefined) return p.at

  const movedByWindow = p.at !== p.base
  if (!movedByWindow && p.source !== 'dailyTail') return p.at

  const spread = p.at + spreadOffsetMs(p.key)

  // A lead rung is a warning about something that has not happened yet, and a warning that lands
  // after the thing is worse than no warning. The window has already moved this one off its chosen
  // offset, so spreading it is legitimate — but never far enough to cross the deadline it is about.
  // `rungPlan`'s survival filter drops warnings the window would push past their own due time; this
  // is the same rule applied to the extra distance the spread adds.
  if (p.source === 'lead' && p.dueAtMillis !== null && spread >= p.dueAtMillis) return p.at

  // Belt and braces: unreachable for any window narrower than roughly twenty-one hours. If a spread
  // ever did land back inside the window, DROPPING it is the only safe answer — deferring it would
  // return the window end again and rebuild the very pile this exists to break.
  if (inQuietHours(spread, p.zone, p.quiet)) return p.at

  return spread
}

/**
 * When to nudge next, or null when the ladder is exhausted.
 *
 * `nagCount` is how many nudges have ALREADY been sent, so 0 means "the first one is due". Which
 * rung that indexes depends on the timing kind: for a `trigger` rung 0 is the due instant, and for
 * a `deadline` it is the first warning in the run-up, days before anything is late.
 *
 * With no due time at all the rungs hang off `plannedAtMillis` instead and there is no lead phase —
 * see `planUndatedRungs`. An undated reminder is still chased; it simply has nothing to count down
 * to, so it is asked about each morning rather than warned about in advance.
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
  /**
   * A stable per-item key that switches the fan-out on — in practice the reminder id.
   *
   * Optional, and no key means no spread at all, which is what keeps every caller and every test
   * that predates this producing byte-identical instants. `services/reminders.ts` supplies it from
   * `ladderParams`, so all five production paths are covered by one line there.
   */
  spreadKey?: string
}): number | null {
  const { policy, nagCount, dueAtMillis, zone, nowMillis } = params
  const quiet = params.quiet ?? null
  const kind = params.kind ?? DEFAULT_TIMING_KIND
  const routine = params.routine ?? DEFAULT_ROUTINE

  if (policy === 'off') return null
  if (nagCount >= ABSOLUTE_MAX_RUNGS) return null

  // An undated reminder is chased too. It just has nothing to count down TO.
  //
  // A ladder needs one instant to hang its offsets off, and for a dated reminder that is the due
  // time. With no due time the anchor is the moment the chase was PLANNED — creation, or whichever
  // edit last re-planned it. Everything below then works unchanged, because nothing in
  // `rungInstant` or `tightestGap` requires that instant to be a deadline, only that every offset
  // in the plan is measured from the same place.
  //
  // What used to be here was `return null`, and it is what made "sort the loft out" a write-only
  // note: Otto took it, never mentioned it again, and the owner found out weeks later.
  const undated = dueAtMillis === null
  const plannedAt = params.plannedAtMillis ?? nowMillis
  const anchor = undated ? plannedAt : dueAtMillis

  const plan = undated
    ? planUndatedRungs(policy)
    : planRungs({
        kind,
        policy,
        dueAtMillis,
        plannedAtMillis: plannedAt,
        zone,
        override: params.plan ?? null,
        // Passed so a warning that quiet hours would push past its own deadline is dropped at plan
        // time rather than delivered late.
        quiet,
      })

  const rung = rungInstant(plan, nagCount, anchor, zone, nowMillis, routine)
  if (rung === null) return null
  const at = rung.at

  // The rung that lands ON the due instant is never moved, by spacing or by quiet hours, as long as
  // it is still ahead of us. That instant is the one the owner picked, so a reminder due 23:30
  // nudges at 23:30 even inside a quiet window. Explicit per-item intent beats a global default,
  // and a window that silently moved the owner's own chosen time would make the feature read as
  // broken rather than considerate. Once the due time is behind us we are picking the instant
  // ourselves, so the window applies again.
  //
  // Keyed on the OFFSET being zero rather than the index being zero: with lead rungs the due
  // instant sits at index `leadAt.length`, not at 0.
  //
  // Never taken for an undated reminder. Its anchor is an instant WE chose, not one they named, so
  // it has no claim on their quiet hours. The undated ladder has no rung on its anchor either — see
  // `UNDATED` — so today this could only fire by accident; the guard is here so that giving it one
  // later cannot silently reinstate a 3am nudge sent seconds after the owner finished typing.
  if (!undated && at === anchor && at >= nowMillis) return at

  // Nothing has gone out yet, so there is nothing to space this from. Without the first branch a
  // reminder created after its own due time would be pushed half an hour into the future instead
  // of being chased promptly.
  //
  // Otherwise: hold the rung off the heels of the one that just fired, THEN push it out of the quiet
  // window. That order is load-bearing. Flooring after the deferral could push a rung that had
  // legitimately cleared the window (say 21:55, with the window opening at 22:00) straight back
  // into it.
  const chosen =
    nagCount === 0 ? Math.max(at, nowMillis) : Math.max(at, nowMillis + spacingFloor(policy, plan, anchor))
  const deferred = deferPastQuietHours(chosen, zone, quiet)

  // Last, and only ever later: fan out the instants Otto picked for itself, so a backlog released at
  // one edge does not arrive as one burst. Everything above is untouched by it.
  return spreadSelfChosen({
    at: deferred,
    base: chosen,
    source: rung.source,
    dueAtMillis,
    key: params.spreadKey,
    zone,
    quiet,
  })
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
