import { readFileSync } from 'node:fs'
import { IANAZone } from 'luxon'
import { z } from 'zod'
import { parseQuietHours } from './lib/quietHours.js'

// Load a local .env when present (no-op in prod, where env is injected by the host).
// Never under vitest: tests must see only what test/setup-env.ts pins, not this machine's .env.
if (!process.env.VITEST) {
  try {
    process.loadEnvFile()
  } catch {
    /* no .env file — env comes from the host */
  }
}

/** What both schedule defaults accept as a deliberate "no window / no review", vs. a typo. */
const OFF_SPECS = new Set(['', 'off', 'none'])

/**
 * Is this a usable QUIET_HOURS_DEFAULT?
 *
 * `parseQuietHours` returns null for BOTH "off" and "22-00:07" — it is a 3am-safe reader, so garbage
 * has to degrade to "no quiet hours" rather than throw. Boot is the one place that can afford to
 * tell the two apart, and must: a typo'd window would otherwise silently disable quiet hours
 * forever, and the owner would only find out when a nudge landed at 04:00.
 */
function isQuietHoursSpec(value: string): boolean {
  if (OFF_SPECS.has(value.trim().toLowerCase())) return true
  return parseQuietHours(value) !== null
}

/** A weekly slot as a luxon weekday (1 = Monday … 7 = Sunday) plus a LOCAL wall-clock time. */
export type WeeklyReviewSlot = { weekday: number; hour: number; minute: number } | null

const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']

/**
 * Parse `"SUN:18:00"`. `"off"`, `""` and anything unparseable all give null — same never-throws
 * contract as `parseQuietHours`, and for the same reason: this value reaches the scheduler.
 *
 * Exported from config.ts (like `adminTokenRequired`) so it is unit-testable without booting, and so
 * the weekly-review feature branch reads the owner's column with the exact parser boot validated.
 */
export function parseWeeklyReview(spec: string | null | undefined): WeeklyReviewSlot {
  if (!spec) return null
  const trimmed = spec.trim()
  if (OFF_SPECS.has(trimmed.toLowerCase())) return null
  const m = /^([A-Za-z]{3}):(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (!m) return null
  const weekday = WEEKDAYS.indexOf(m[1]!.toUpperCase()) + 1
  if (weekday === 0) return null
  const hour = Number(m[2])
  const minute = Number(m[3])
  if (hour > 23 || minute > 59) return null
  return { weekday, hour, minute }
}

/** Same "deliberate off vs. typo" split as `isQuietHoursSpec`. */
function isWeeklyReviewSpec(value: string): boolean {
  if (OFF_SPECS.has(value.trim().toLowerCase())) return true
  return parseWeeklyReview(value) !== null
}

const raw = z
  .object({
    PORT: z.coerce.number().default(3000),
    PUBLIC_ORIGIN: z.string().url().default('http://localhost:3000'),
    DATABASE_PATH: z.string().default('./data/otto.sqlite'),
    DEFAULT_TIMEZONE: z
      .string()
      .default('UTC')
      .refine((z) => IANAZone.isValidZone(z), (z) => ({ message: `DEFAULT_TIMEZONE "${z}" is not a valid IANA zone` })),
    LOG_LEVEL: z.string().default('info'),

    // FCM (required — the whole point is pushing to the phone).
    FIREBASE_SERVICE_ACCOUNT: z.string().min(1, 'FIREBASE_SERVICE_ACCOUNT is required (path or inline JSON)'),

    // The agent (optional — endpoints/FCM work without it; every surface falls back to a
    // deterministic template when this is unset).
    //
    // This is api.openai.com. It is NOT the STT credential further down, which points at an
    // OpenAI-COMPATIBLE endpoint (Groq) and takes a Groq key. The two are never interchangeable,
    // and swapping them fails as a quiet 401 on a path that degrades silently.
    OPENAI_API_KEY: z.string().optional(),
    OPENAI_MODEL: z.string().default('gpt-5.6-luna'),

    // WhatsApp Cloud API (optional — enables the inbound webhook + replies).
    META_APP_SECRET: z.string().optional(),
    META_VERIFY_TOKEN: z.string().optional(),
    META_WA_PHONE_NUMBER_ID: z.string().optional(),
    META_WA_ACCESS_TOKEN: z.string().optional(),
    // Comma-separated allowlist of owner WhatsApp numbers (any format; compared digits-only).
    // When unset, the server trusts the first number that messages it and rejects others.
    OWNER_WA_NUMBERS: z.string().optional(),
    // An APPROVED WhatsApp message template, the only legal way to speak first once the 24h window
    // has shut (optional). Nested under `meta` below, never beside it.
    META_TEMPLATE_NAME: z.string().optional(),
    META_TEMPLATE_LANG: z.string().default('en'),

    // Google Calendar/Tasks (optional).
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

    // Speech-to-text for WhatsApp voice notes (optional). Any OpenAI-compatible
    // /audio/transcriptions endpoint; the default base URL is Groq's Whisper.
    STT_API_KEY: z.string().optional(),
    STT_BASE_URL: z.string().default('https://api.groq.com/openai/v1'),
    STT_MODEL: z.string().default('whisper-large-v3-turbo'),

    // Google Maps (optional). ONE key for two APIs, which must BOTH be enabled on it:
    //   Routes API  — real travel time for leave-by alarms and journeys (services/travel.ts)
    //   Places API (New) — turning "the gym" into an address        (services/places.ts)
    // Deliberately not two keys. They are the same Google Cloud project, the same billing account
    // and the same restriction list, so a second variable would only add a way to configure half
    // of a feature — the state every other integration here makes unrepresentable.
    GOOGLE_MAPS_API_KEY: z.string().optional(),

    // Server-wide fallbacks for the per-device settings columns (device_settings). Both are
    // validated HERE, at boot, rather than where they are read — which is a scheduler job at 3am.
    QUIET_HOURS_DEFAULT: z
      .string()
      .default('22:00-07:00')
      .refine(isQuietHoursSpec, (v) => ({ message: `QUIET_HOURS_DEFAULT "${v}" is not "HH:MM-HH:MM" or "off"` })),
    WEEKLY_REVIEW_DEFAULT: z
      .string()
      .default('SUN:18:00')
      .refine(isWeeklyReviewSpec, (v) => ({ message: `WEEKLY_REVIEW_DEFAULT "${v}" is not "DDD:HH:MM" or "off"` })),

    // Optional admin auth for /admin routes (recommended in production).
    ADMIN_TOKEN: z.string().optional(),
  })
  .parse(process.env)

type ServiceAccount = { project_id: string; client_email: string; private_key: string }

function loadServiceAccount(value: string): ServiceAccount {
  const text = value.trim().startsWith('{') ? value : readFileSync(value, 'utf8')
  const json = JSON.parse(text) as Partial<ServiceAccount>
  if (!json.project_id || !json.client_email || !json.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is missing project_id/client_email/private_key')
  }
  return json as ServiceAccount
}

const serviceAccount = loadServiceAccount(raw.FIREBASE_SERVICE_ACCOUNT)

/**
 * /admin/devices exposes per-device pairing secrets, so an admin token is mandatory the moment
 * the server is reachable beyond localhost. Pure so it's unit-testable; config.ts cannot import
 * the logger (circular), so violations throw at boot instead.
 */
export function adminTokenRequired(publicOrigin: string, adminToken: string | null): boolean {
  if (adminToken) return false
  let host: string
  try {
    host = new URL(publicOrigin).hostname
  } catch {
    return true // unparseable origin: fail closed
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  return !local
}

const metaComplete =
  raw.META_APP_SECRET && raw.META_VERIFY_TOKEN && raw.META_WA_PHONE_NUMBER_ID && raw.META_WA_ACCESS_TOKEN

const googleComplete = raw.GOOGLE_OAUTH_CLIENT_ID && raw.GOOGLE_OAUTH_CLIENT_SECRET

const sttComplete = raw.STT_API_KEY

const mapsComplete = raw.GOOGLE_MAPS_API_KEY

export const config = {
  port: raw.PORT,
  publicOrigin: raw.PUBLIC_ORIGIN.replace(/\/$/, ''),
  databasePath: raw.DATABASE_PATH,
  defaultTimezone: raw.DEFAULT_TIMEZONE,
  logLevel: raw.LOG_LEVEL,
  adminToken: raw.ADMIN_TOKEN ?? null,
  firebase: { serviceAccount, projectId: serviceAccount.project_id },
  openai: raw.OPENAI_API_KEY ? { apiKey: raw.OPENAI_API_KEY, model: raw.OPENAI_MODEL } : null,
  meta: metaComplete
    ? {
        appSecret: raw.META_APP_SECRET!,
        verifyToken: raw.META_VERIFY_TOKEN!,
        phoneNumberId: raw.META_WA_PHONE_NUMBER_ID!,
        accessToken: raw.META_WA_ACCESS_TOKEN!,
        // NESTED inside meta, not beside it: a template send needs the phone number id and the
        // access token, so "template configured but WhatsApp isn't" must be unrepresentable rather
        // than a state some future caller has to remember to check for.
        template: raw.META_TEMPLATE_NAME ? { name: raw.META_TEMPLATE_NAME, lang: raw.META_TEMPLATE_LANG } : null,
      }
    : null,
  // Digits-only owner numbers (e.g. "+44 7700 900000" → "447700900000"); empty = trust-on-first-use.
  ownerWaNumbers: (raw.OWNER_WA_NUMBERS ?? '')
    .split(',')
    .map((n) => n.replace(/\D/g, ''))
    .filter((n) => n.length > 0),
  google: googleComplete
    ? {
        clientId: raw.GOOGLE_OAUTH_CLIENT_ID!,
        clientSecret: raw.GOOGLE_OAUTH_CLIENT_SECRET!,
        redirectUri: `${raw.PUBLIC_ORIGIN.replace(/\/$/, '')}/oauth/google/callback`,
      }
    : null,
  stt: sttComplete
    ? { apiKey: raw.STT_API_KEY!, baseUrl: raw.STT_BASE_URL.replace(/\/$/, ''), model: raw.STT_MODEL }
    : null,
  maps: mapsComplete ? { apiKey: raw.GOOGLE_MAPS_API_KEY! } : null,
  // Raw strings, not parsed windows: the per-device column is also a raw string, so both sides go
  // through the same parser at the point of use and can never disagree about what "off" means.
  quietHoursDefault: raw.QUIET_HOURS_DEFAULT,
  weeklyReviewDefault: raw.WEEKLY_REVIEW_DEFAULT,
} as const

if (adminTokenRequired(config.publicOrigin, config.adminToken)) {
  throw new Error(
    'ADMIN_TOKEN is required when PUBLIC_ORIGIN is not localhost — /admin/devices exposes pairing secrets. Set ADMIN_TOKEN in the environment (see SETUP.md "Hardening").',
  )
}

export type Config = typeof config
