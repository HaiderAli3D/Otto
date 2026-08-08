import { DateTime } from 'luxon'
import { deferPastQuietHours, type QuietHours } from './quietHours.js'

/**
 * What a reminder's due time MEANS, and therefore where its rungs sit relative to it.
 *
 * The three cases are the three things an owner actually says, and they want opposite behaviour:
 *
 *   "get it done BY 4"      → deadline    — warn repeatedly in the run-up, chase hard once past.
 *   "the dentist is AT 4"   → appointment — prompt shortly before, check shortly after, stop.
 *   "REMIND ME AT 4"        → trigger     — say nothing beforehand, chase from that moment.
 *
 * Named as distinct English words rather than BY/AT/FROM because the owner says "at" for two of the
 * three, so a lexical enum would be a coin flip for the model choosing between them.
 */
export type TimingKind = 'deadline' | 'appointment' | 'trigger'

export const TIMING_KINDS: TimingKind[] = ['deadline', 'appointment', 'trigger']

/**
 * What a reminder with no stated timing is.
 *
 * `trigger` has ZERO lead rungs, which is what makes it the only safe migration default: every row
 * written before this column existed keeps the exact ladder it had.
 */
export const DEFAULT_TIMING_KIND: TimingKind = 'trigger'

export function isTimingKind(v: unknown): v is TimingKind {
  return typeof v === 'string' && (TIMING_KINDS as string[]).includes(v)
}

/**
 * How hard to chase, ordered from silent to unbearable. Array order IS the ordering.
 *
 * These name a PRIORITY, not a literal message count — the count falls out of the timing kind and
 * how much run-up there was. `relentless` on something due in ten minutes is a handful of messages;
 * on something due next week it is thirty.
 */
export type NagPolicy = 'off' | 'gentle' | 'persistent' | 'hard' | 'relentless'

export const NAG_POLICIES: NagPolicy[] = ['off', 'gentle', 'persistent', 'hard', 'relentless']

export function isNagPolicy(v: unknown): v is NagPolicy {
  return typeof v === 'string' && (NAG_POLICIES as string[]).includes(v)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/**
 * A rung's distance BEFORE the due time. A number is milliseconds; an object is calendar days.
 *
 * The union is not decoration. `due - 24*3600_000` is 23 or 25 wall-clock hours on the two DST
 * nights of the year, so a "day before" heads-up for a 09:00 Monday deadline would land at 08:00 or
 * 10:00 on the Sunday. Anything a person would describe in days is therefore expressed in days and
 * resolved through luxon; anything they would describe in hours stays in milliseconds, which is
 * correct — "six hours before" really does mean six elapsed hours.
 */
export type Offset = number | { daysBefore: number }

/** The declarative shape of one ladder, before it meets a clock. */
export type RungPlan = {
  /** Strictly before the due time, furthest first. */
  lead: Offset[]
  /** Milliseconds at or after the due time, ascending. `0` is the due instant itself. */
  chase: number[]
  /** What happens after the last `chase` entry. */
  tail: 'stop' | 'daily'
  /** Ceiling on POST-DUE rungs only, so a long run-up never eats the chase budget. */
  maxChases: number
}

/** A ladder resolved against a specific due time, zone and creation moment. */
export type ResolvedPlan = {
  /** Absolute instants of the surviving lead rungs, ascending. */
  leadAt: number[]
  chase: number[]
  tail: 'stop' | 'daily'
  maxChases: number
  /** How many lead rungs the clock pruned — reported back so Otto can say so. */
  droppedAsTooLate: number
}

/**
 * A lead rung must be at least this far out to be worth scheduling.
 *
 * Anything closer is a message the owner reads seconds after asking for the reminder, which reads
 * as a bug rather than a warning.
 */
export const MIN_LEAD_GAP_MS = 10 * MINUTE

/** Backstop against a typo'd table or an absurd explicit plan; far above any real ladder. */
export const ABSOLUTE_MAX_RUNGS = 40

const d = (daysBefore: number): Offset => ({ daysBefore })

/**
 * The ladders, as data.
 *
 * Read a row as: warn at each `lead` distance before the due time, then chase at each `chase`
 * distance after it, then `tail`. The `lead` column is a SUPERSET — the clock prunes whatever has
 * already gone by, so one table serves a deadline three weeks out and the same deadline set forty
 * minutes beforehand without a single lead-time bucket or branch.
 *
 * `trigger` × `gentle` and `trigger` × `persistent` reproduce the pre-timing ladder exactly, which
 * is what lets every ladder test that predates this file pass unedited.
 *
 * `appointment` stops rather than going daily at every intensity. An appointment an hour gone is
 * the past, and chasing the past once a day is precisely what `deadline` is for. The reminder still
 * stays OPEN and still shows in lists, digests and the brief — same as any exhausted ladder.
 */
const TABLE: Record<TimingKind, Record<Exclude<NagPolicy, 'off'>, RungPlan>> = {
  deadline: {
    gentle: {
      lead: [d(1), 2 * HOUR, 20 * MINUTE],
      chase: [0, 1 * HOUR],
      tail: 'daily',
      maxChases: 4,
    },
    persistent: {
      lead: [d(3), d(1), 4 * HOUR, 1 * HOUR, 20 * MINUTE],
      chase: [0, 20 * MINUTE, 1 * HOUR, 3 * HOUR],
      tail: 'daily',
      maxChases: 8,
    },
    hard: {
      lead: [d(7), d(3), d(1), 6 * HOUR, 3 * HOUR, 1 * HOUR, 30 * MINUTE, 10 * MINUTE],
      chase: [0, 10 * MINUTE, 30 * MINUTE, 1 * HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR],
      tail: 'daily',
      maxChases: 14,
    },
    relentless: {
      lead: [d(7), d(3), d(1), 12 * HOUR, 6 * HOUR, 3 * HOUR, 1 * HOUR, 30 * MINUTE, 15 * MINUTE, 5 * MINUTE],
      chase: [
        0,
        5 * MINUTE,
        15 * MINUTE,
        30 * MINUTE,
        1 * HOUR,
        2 * HOUR,
        3 * HOUR,
        5 * HOUR,
        8 * HOUR,
        12 * HOUR,
      ],
      tail: 'daily',
      maxChases: 24,
    },
  },
  appointment: {
    gentle: {
      lead: [30 * MINUTE],
      chase: [0, 15 * MINUTE],
      tail: 'stop',
      maxChases: 2,
    },
    persistent: {
      lead: [2 * HOUR, 30 * MINUTE, 10 * MINUTE],
      chase: [0, 10 * MINUTE, 30 * MINUTE],
      tail: 'stop',
      maxChases: 3,
    },
    hard: {
      lead: [d(1), 3 * HOUR, 1 * HOUR, 30 * MINUTE, 15 * MINUTE, 5 * MINUTE],
      chase: [0, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, 1 * HOUR],
      tail: 'stop',
      maxChases: 5,
    },
    relentless: {
      lead: [d(1), 6 * HOUR, 3 * HOUR, 1 * HOUR, 30 * MINUTE, 15 * MINUTE, 10 * MINUTE, 5 * MINUTE],
      chase: [0, 3 * MINUTE, 10 * MINUTE, 20 * MINUTE, 30 * MINUTE, 45 * MINUTE, 1 * HOUR, 2 * HOUR],
      tail: 'stop',
      maxChases: 8,
    },
  },
  trigger: {
    // No lead rungs at ANY intensity: "remind me at 4" means say nothing until 4.
    gentle: { lead: [], chase: [0, 2 * HOUR], tail: 'daily', maxChases: 3 },
    persistent: { lead: [], chase: [0, 30 * MINUTE, 2 * HOUR, 6 * HOUR], tail: 'daily', maxChases: 8 },
    hard: {
      lead: [],
      chase: [0, 10 * MINUTE, 30 * MINUTE, 1 * HOUR, 2 * HOUR, 4 * HOUR],
      tail: 'daily',
      maxChases: 12,
    },
    relentless: {
      lead: [],
      chase: [0, 5 * MINUTE, 15 * MINUTE, 30 * MINUTE, 1 * HOUR, 2 * HOUR, 3 * HOUR, 5 * HOUR, 8 * HOUR],
      tail: 'daily',
      maxChases: 20,
    },
  },
}

/** The table row for a pair, untouched by any clock. Exported for tests and for tool previews. */
export function tableFor(kind: TimingKind, policy: Exclude<NagPolicy, 'off'>): RungPlan {
  return TABLE[kind][policy]
}

/**
 * The smallest gap this particular ladder asks for between two consecutive rungs.
 *
 * The spacing floor in `nagLadder.ts` exists to stop a quiet-hours pile-up, and its whole
 * justification is that it constrains nothing a ladder would have done on its own. That was true
 * when every ladder's tightest gap was thirty minutes; it stopped being true the moment the tables
 * gained rungs twenty, ten and three minutes apart. A floor wider than this number does not space a
 * pile-up — it silently rewrites the schedule, and the visible symptom is a lead rung shunted
 * forward onto the due instant so a warning and the deadline itself arrive together.
 *
 * Returns `Infinity` for a single-rung ladder, so callers keep their own default.
 */
export function tightestGap(plan: ResolvedPlan, dueAtMillis: number): number {
  const instants = [...plan.leadAt, ...plan.chase.map((ms) => dueAtMillis + ms)]
  let tightest = Number.POSITIVE_INFINITY
  for (let i = 1; i < instants.length; i++) {
    const gap = instants[i]! - instants[i - 1]!
    if (gap > 0 && gap < tightest) tightest = gap
  }
  return tightest
}

/** An explicit per-reminder schedule, as the model supplies it and as it is stored. */
export type NagPlanSpec = {
  /** Minutes BEFORE the due time. Positive; the field name carries the direction. */
  leadMinutes?: number[]
  /** Minutes AFTER the due time. Positive, `0` = at the due instant. */
  chaseMinutes?: number[]
  keepChasingDaily?: boolean
}

export const MAX_OFFSET_MINUTES = 30 * 24 * 60
export const MAX_EXPLICIT_LEAD = 12
export const MAX_EXPLICIT_CHASE = 24
/** How many daily tail rungs an explicit `keepChasingDaily` plan is allowed before it gives up. */
const EXPLICIT_DAILY_TAIL_RUNGS = 14

export type OffsetIssues = { clamped: number; droppedForCount: number }

export type OffsetResult =
  | { ok: false; error: string }
  | ({ ok: true; minutes: number[] } & OffsetIssues)

/**
 * Validate one explicit offset array: reject, clamp, dedupe, sort, cap.
 *
 * Rejection is all-or-nothing with the offending field named, matching how `setPreferences` handles
 * a bad value: a partially-applied schedule is worse than none, because the owner is told their
 * instruction landed and only some of it did.
 *
 * Everything else is repaired rather than refused, and each repair is COUNTED so the caller can put
 * it in the tool result. Otto is instructed to confirm from what happened rather than from what was
 * asked, and it can only do that if the repairs come back with the answer.
 */
export function normaliseOffsets(field: string, raw: unknown, order: 'lead' | 'chase'): OffsetResult {
  if (!Array.isArray(raw)) return { ok: false, error: `${field} must be an array of minutes` }
  const seen = new Set<number>()
  const kept: number[] = []
  let clamped = 0
  for (let i = 0; i < raw.length; i++) {
    const v: unknown = raw[i]
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
      return { ok: false, error: `${field}[${i}] must be a whole number of minutes and not negative, got ${String(v)}` }
    }
    let minutes = v
    if (minutes > MAX_OFFSET_MINUTES) {
      minutes = MAX_OFFSET_MINUTES
      clamped++
    }
    if (seen.has(minutes)) continue
    seen.add(minutes)
    kept.push(minutes)
  }

  // Cap by keeping the entries NEAREST the due time — for both directions that is the smallest
  // magnitudes. A capped ladder that dropped its closest warnings would keep only the ones far
  // enough out to have been forgotten.
  const cap = order === 'lead' ? MAX_EXPLICIT_LEAD : MAX_EXPLICIT_CHASE
  kept.sort((a, b) => a - b)
  const droppedForCount = Math.max(0, kept.length - cap)
  const capped = kept.slice(0, cap)

  // Lead rungs run furthest-first so they read as a countdown; chase rungs run nearest-first.
  capped.sort((a, b) => (order === 'lead' ? b - a : a - b))
  return { ok: true, minutes: capped, clamped, droppedForCount }
}

/** JSON for the `reminders.nag_plan` column. `null` in that column means "use the table". */
export function serializeNagPlan(spec: NagPlanSpec): string {
  return JSON.stringify(spec)
}

/**
 * Read a stored plan back. Never throws and returns null on anything unexpected.
 *
 * Same 3am-safe contract as `parseQuietHours`: a row corrupted by a bad write or an older shape
 * must degrade to "use the table" rather than take down whichever scheduler tick touched it. A
 * thrown error here would stop the nudge chain for that reminder permanently.
 */
export function parseNagPlan(text: string | null | undefined): NagPlanSpec | null {
  if (!text) return null
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
    const o = raw as Record<string, unknown>
    const nums = (v: unknown): number[] | undefined =>
      Array.isArray(v) && v.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
        ? (v as number[])
        : undefined
    const spec: NagPlanSpec = {}
    const lead = nums(o.leadMinutes)
    const chase = nums(o.chaseMinutes)
    if (lead) spec.leadMinutes = lead
    if (chase) spec.chaseMinutes = chase
    if (typeof o.keepChasingDaily === 'boolean') spec.keepChasingDaily = o.keepChasingDaily
    if (spec.leadMinutes === undefined && spec.chaseMinutes === undefined) return null
    return spec
  } catch {
    return null
  }
}

/** Where one lead offset actually lands. Calendar days go through luxon; hours are elapsed hours. */
function leadInstant(dueAtMillis: number, offset: Offset, zone: string): number {
  if (typeof offset === 'number') return dueAtMillis - offset
  return DateTime.fromMillis(dueAtMillis, { zone }).minus({ days: offset.daysBefore }).toMillis()
}

/**
 * Resolve a ladder against a real due time, applying any explicit override and pruning lead rungs
 * that are already too close to be worth sending.
 *
 * `plannedAtMillis` — NOT `nowMillis` — is what the prune is measured against, and the distinction
 * is the whole determinism guarantee. `nextNagAt` is re-entered every time a rung fires, with a
 * fresh clock; if the prune moved with it, the mapping from `nagCount` to a rung would shift under
 * the ladder and rungs would be silently revisited or skipped. Anchoring it to the moment the
 * schedule was PLANNED makes the same `nagCount` mean the same rung for the life of the reminder.
 *
 * Supplying one explicit array and not the other composes: explicit lead with table chase, or the
 * reverse. That is the useful case ("warn me a week and a day before, then chase me normally") and
 * it costs nothing to support.
 */
export function planRungs(params: {
  kind: TimingKind
  policy: NagPolicy
  dueAtMillis: number
  plannedAtMillis: number
  zone: string
  override?: NagPlanSpec | null
  quiet?: QuietHours
}): ResolvedPlan {
  const { kind, dueAtMillis, plannedAtMillis, zone } = params
  const policy = params.policy === 'off' ? 'gentle' : params.policy
  const base = TABLE[kind][policy]
  const override = params.override ?? null

  // A trigger says nothing before its instant by definition, so an explicit lead array is ignored
  // rather than honoured — the tool description says so, and silently obeying it here would make
  // "remind me at 4" start talking at 3.
  const overrideLead = kind === 'trigger' ? undefined : override?.leadMinutes
  const lead: Offset[] = overrideLead ? overrideLead.map((m) => m * MINUTE) : base.lead

  let chase = base.chase
  let tail = base.tail
  let maxChases = base.maxChases
  if (override?.chaseMinutes) {
    chase = override.chaseMinutes.map((m) => m * MINUTE)
    tail = override.keepChasingDaily ? 'daily' : 'stop'
    maxChases = chase.length + (tail === 'daily' ? EXPLICIT_DAILY_TAIL_RUNGS : 0)
  }

  // A lead rung has to survive two tests, and the second one is easy to miss.
  //
  // It must be far enough out to be worth sending at all (`cutoff`) — and it must still land
  // BEFORE the thing it is warning about once quiet hours have had their say. A "heads up, the
  // dentist is in two hours" pushed out of a 22:00–07:00 window arrives four hours after the
  // dentist, which is worse than not warning at all: it is a message that reads as a mistake and
  // teaches the owner that the warnings are noise.
  //
  // Judged here rather than at fire time so the surviving set is a pure function of the plan, and
  // the nagCount → rung mapping stays stable across every re-entry. Deferral is idempotent, so
  // storing the raw instant and re-deferring later gives the same answer.
  const cutoff = plannedAtMillis + MIN_LEAD_GAP_MS
  const quiet = params.quiet ?? null
  const resolved = lead.map((o) => leadInstant(dueAtMillis, o, zone))
  const leadAt = resolved
    .filter((at) => at >= cutoff && deferPastQuietHours(at, zone, quiet) < dueAtMillis)
    .sort((a, b) => a - b)

  return {
    leadAt,
    chase,
    tail,
    maxChases,
    droppedAsTooLate: resolved.length - leadAt.length,
  }
}
