import { readFileSync } from 'node:fs'
import { IANAZone } from 'luxon'
import { z } from 'zod'

// Load a local .env when present (no-op in prod, where env is injected by the host).
// Never under vitest: tests must see only what test/setup-env.ts pins, not this machine's .env.
if (!process.env.VITEST) {
  try {
    process.loadEnvFile()
  } catch {
    /* no .env file — env comes from the host */
  }
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

    // Claude agent (optional — endpoints/FCM work without it).
    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

    // WhatsApp Cloud API (optional — enables the inbound webhook + replies).
    META_APP_SECRET: z.string().optional(),
    META_VERIFY_TOKEN: z.string().optional(),
    META_WA_PHONE_NUMBER_ID: z.string().optional(),
    META_WA_ACCESS_TOKEN: z.string().optional(),
    // Comma-separated allowlist of owner WhatsApp numbers (any format; compared digits-only).
    // When unset, the server trusts the first number that messages it and rejects others.
    OWNER_WA_NUMBERS: z.string().optional(),

    // Google Calendar/Tasks (optional).
    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

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

export const config = {
  port: raw.PORT,
  publicOrigin: raw.PUBLIC_ORIGIN.replace(/\/$/, ''),
  databasePath: raw.DATABASE_PATH,
  defaultTimezone: raw.DEFAULT_TIMEZONE,
  logLevel: raw.LOG_LEVEL,
  adminToken: raw.ADMIN_TOKEN ?? null,
  firebase: { serviceAccount, projectId: serviceAccount.project_id },
  anthropic: raw.ANTHROPIC_API_KEY
    ? { apiKey: raw.ANTHROPIC_API_KEY, model: raw.ANTHROPIC_MODEL }
    : null,
  meta: metaComplete
    ? {
        appSecret: raw.META_APP_SECRET!,
        verifyToken: raw.META_VERIFY_TOKEN!,
        phoneNumberId: raw.META_WA_PHONE_NUMBER_ID!,
        accessToken: raw.META_WA_ACCESS_TOKEN!,
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
} as const

if (adminTokenRequired(config.publicOrigin, config.adminToken)) {
  throw new Error(
    'ADMIN_TOKEN is required when PUBLIC_ORIGIN is not localhost — /admin/devices exposes pairing secrets. Set ADMIN_TOKEN in the environment (see SETUP.md "Hardening").',
  )
}

export type Config = typeof config
