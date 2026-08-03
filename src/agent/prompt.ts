import type Anthropic from '@anthropic-ai/sdk'
import type { Device } from '../services/devices.js'
import { renderFacts } from '../services/facts.js'
import { listReminders } from '../services/reminders.js'
import { nowIsoInZone } from '../services/time.js'
import { reminderEvidence, renderRecord } from '../services/signals.js'
import { PERSONA, WRITING } from './persona.js'
import {
  ALARMS_VS_REMINDERS,
  CAPABILITIES,
  IDENTITY,
  LEAVE_BY,
  MEMORY,
  PROACTIVE,
  REMINDER_LOOP,
  REPLYING,
  THE_RECORD,
  TIME,
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
  REMINDER_LOOP,
  MEMORY,
  PROACTIVE,
  THE_RECORD,
  TIME,
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
        renderOpenReminders(device),
        renderRecord(device.deviceId),
      ].join('\n\n'),
    },
  ]
}

/** The live chase-list. Small, always accurate, and worth a tool round-trip on most turns. */
function renderOpenReminders(device: Device): string {
  const open = listReminders(device.deviceId, { state: 'open' })
  if (open.length === 0) return 'You are not currently chasing the owner about anything.'
  const now = Date.now()
  const lines = open.map(
    (r) => `- ${r.title} [${r.reminderId}] (${reminderEvidence(r, device.timezone, now)})`,
  )
  return `Open reminders you are chasing:\n${lines.join('\n')}`
}
