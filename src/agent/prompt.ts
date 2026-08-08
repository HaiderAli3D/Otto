import type Anthropic from '@anthropic-ai/sdk'
import { formatQuietHours } from '../lib/quietHours.js'
import { describeRoutine } from '../lib/routine.js'
import { describeBudget } from '../services/budget.js'
import type { Device } from '../services/devices.js'
import { renderFacts } from '../services/facts.js'
import { leadCountFor, listReminders } from '../services/reminders.js'
import { quietHoursFor, quietNow, routineFor } from '../services/settings.js'
import { nowIsoInZone } from '../services/time.js'
import { reminderEvidence, renderRecord } from '../services/signals.js'
import { PERSONA, WRITING } from './persona.js'
import {
  ACCOUNTABILITY,
  ALARMS_VS_REMINDERS,
  CAPABILITIES,
  IDENTITY,
  LEAVE_BY,
  MEMORY,
  PREFERENCES,
  PROACTIVE,
  REMINDER_LOOP,
  REMINDER_TIMING,
  REPLYING,
  ROUTINE,
  THE_RECORD,
  TIME,
  VOICE_AND_PHOTOS,
} from './promptSections.js'

/**
 * Frozen instruction block. Any edit invalidates the prompt cache for every user, which is fine —
 * it happens on deploy, not per request.
 *
 * Identity comes from `persona.ts` so the digest composer and the nudge writer get the same Otto.
 * Everything else comes from `promptSections.ts`, one const per section, so that parallel feature
 * branches each add their own section and one line here instead of all rewriting one long literal.
 *
 * This array IS the running order the model reads — it is the only place that order is decided, so
 * put a new section where it belongs in the argument rather than on the end. The join is `\n\n`
 * because every section is stored trimmed, exactly as it was when this was a single template
 * literal; keep it that way or the rendered prompt shifts and the cache is thrown away.
 */
const CORE = [
  IDENTITY,
  PERSONA,
  CAPABILITIES,
  ALARMS_VS_REMINDERS,
  LEAVE_BY,
  REMINDER_TIMING,
  REMINDER_LOOP,
  MEMORY,
  PROACTIVE,
  PREFERENCES,
  ROUTINE,
  ACCOUNTABILITY,
  THE_RECORD,
  TIME,
  VOICE_AND_PHOTOS,
  REPLYING,
  WRITING,
].join('\n\n')

/**
 * System prompt as three blocks, ordered stable → volatile.
 *
 * Render order is tools → system → messages, so the cache breakpoint on the FACTS block caches
 * tools + CORE + facts together. The clock MUST stay in the trailing block: the previous version
 * interpolated a per-second timestamp near the top, which invalidated the whole prefix on every
 * single request. That one line is the difference between ~$90/month and ~$25/month.
 */
export function systemPrompt(device: Device): Anthropic.TextBlockParam[] {
  return [
    { type: 'text', text: CORE },
    {
      type: 'text',
      text: renderFacts(device.deviceId),
      cache_control: { type: 'ephemeral' },
    },
    {
      // Volatile tail, deliberately AFTER the breakpoint so it can change every turn for free.
      // Open reminders live here rather than in the cached block precisely because they change
      // often — and having them always present is what lets the conversation reset safely. The
      // record belongs here for the same reason: those counters move on almost every turn, and in
      // front of the breakpoint they would re-bill the whole prefix each time.
      type: 'text',
      text: [
        `Current local time: ${nowIsoInZone(device.timezone)} (timezone ${device.timezone}).`,
        renderQuietHours(device),
        renderRoutine(device),
        renderOpenReminders(device),
        renderRecord(device.deviceId),
        describeBudget(device),
      ]
        .filter((s): s is string => s !== null)
        .join('\n\n'),
    },
  ]
}

/**
 * One line about the do-not-disturb window, in the VOLATILE tail rather than the cached block.
 *
 * The window itself changes rarely, but "are we in it right now" changes every few hours, and the
 * model needs the second half to answer "will you nudge me tonight?" honestly. Anything that moves
 * per turn in front of the cache breakpoint re-bills the whole prefix.
 */
function renderQuietHours(device: Device): string {
  const quiet = quietHoursFor(device)
  if (quiet === null) return 'Quiet hours: off. Nothing you schedule is being held back.'
  const now = quietNow(device) ? ' You are inside them right now.' : ''
  return `Quiet hours: ${formatQuietHours(quiet)} local.${now}`
}

/**
 * The owner's sleep routine, when they have stated one.
 *
 * Null when they haven't, rather than a default: telling Otto a confident bedtime nobody mentioned
 * is worse than saying nothing, because it will act on it and then be caught having invented it.
 *
 * Values live here in the volatile tail and the RULE lives in the cached `ROUTINE` section, for the
 * usual reason — anything per-device in front of the breakpoint re-bills the whole prefix.
 */
function renderRoutine(device: Device): string | null {
  const routine = routineFor(device)
  return routine === null ? null : describeRoutine(routine)
}

/** The live chase-list. Small, always accurate, and worth a tool round-trip on most turns. */
function renderOpenReminders(device: Device): string {
  const open = listReminders(device.deviceId, { state: 'open' })
  if (open.length === 0) return 'You are not currently chasing the owner about anything.'
  const now = Date.now()
  const lines = open.map(
    (r) => `- ${r.title} [${r.reminderId}] (${reminderEvidence(r, device.timezone, now, leadCountFor(device, r))})`,
  )
  return `Open reminders you are chasing:\n${lines.join('\n')}`
}
