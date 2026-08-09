#!/usr/bin/env node
/*
 * Otto FCM test-push helper (spec §15).
 *
 * Sends a high-priority, DATA-ONLY message to a device via the FCM HTTP v1 API — the same
 * shape the Otto server sends. Data-only (no `notification` block) guarantees the app's
 * onMessageReceived runs in every state; `android.priority:"high"` wakes a Dozing device.
 *
 * Usage:
 *   node send-push.mjs --token <DEVICE_FCM_TOKEN> [options]
 *
 * Options:
 *   --token <t>            Device FCM token (required). Copy it from the Otto app.
 *   --type <T>            ARM_ALARM (default) | CANCEL_ALARM | NUDGE | CANCEL_NUDGE |
 *                         REQUEST_LOCATION | SYNC | PING.
 *
 * Alarm options (ARM_ALARM / CANCEL_ALARM):
 *   --alarm-id <id>      Alarm id (default: a generated "alm_test_<ts>").
 *   --in <seconds>        Fire N seconds from now (default 60). Ignored for CANCEL_ALARM.
 *   --at <epochMillis>    Absolute trigger time (overrides --in).
 *   --label <text>        Alarm label (default "Test push").
 *   --allow-while-idle <b>  true | false (default true).
 *
 * Nudge options (NUDGE / CANCEL_NUDGE):
 *   --nudge-id <id>      Nudge id (default: a generated "rem_test_<ts>"). Pushing the SAME id
 *                         twice replaces the notification in place rather than stacking — that is
 *                         the property a chase ladder depends on, so it is worth testing directly.
 *   --title <text>        Notification title (default "Otto").
 *   --body <text>         Notification body (default "This is a test nudge.").
 *   --level <L>           SILENT | NORMAL (default) | URGENT.
 *   --actions <csv>       DONE,SNOOZE (default). Pass "" for a plain notification with no buttons.
 *   --snooze-minutes <n>  How long Snooze defers it (default 30).
 *   --expires-in <secs>   Self-cancel after N seconds.
 *   --ongoing <b>         true | false (default false).
 *
 * Location options (REQUEST_LOCATION):
 *   --request-id <id>     Request id (default: a generated "loc_test_<ts>"). REQUIRED on the wire —
 *                         an answer the server cannot match to its own question is no answer.
 *   --max-age <secs>      Accept a cached fix this recent (default 120; the app clamps at 1800).
 *   --high-accuracy <b>   true | false (default false). true asks for GPS rather than balanced.
 *   --reason <text>       Shown to the owner on the notification the app posts while it looks.
 *   --expires-in <secs>   Give up after N seconds; the app answers EXPIRED instead of late.
 *
 *   The useful test is with the SCREEN OFF and the phone Dozing:
 *     adb shell dumpsys deviceidle force-idle
 *   Then send, and watch for the otto_quiet notice plus a POST to /devices/{id}/location. A
 *   phone without "Allow all the time" answers BACKGROUND_DENIED — which is a pass, not a failure.
 *
 *   --secret <hmacKey>    If set, adds the M2 `sig` (HMAC-SHA256 over the canonical payload).
 *   --key <path>          Service-account JSON. Default: $GOOGLE_APPLICATION_CREDENTIALS,
 *                         else ./service-account.json next to this script.
 *   --dry-run             Print the request body and exit without sending.
 *   -h, --help            Show this help.
 *
 * Get a service-account key: Firebase Console → Project Settings → Service accounts →
 * "Generate new private key". Save it as tools/send-push/service-account.json (gitignored).
 */
import { GoogleAuth } from 'google-auth-library'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') { args.help = true; continue }
    if (a === '--dry-run') { args.dryRun = true; continue }
    if (a.startsWith('--')) { args[a.slice(2)] = argv[++i] }
  }
  return args
}

function usage() {
  // Print the header comment block as help.
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const block = src.split('*/')[0].replace(/^[\s\S]*?\/\*/, '').replace(/^\s?\*?/gm, '')
  console.log(block.trim())
}

/**
 * Canonical HMAC form (must match the Android client's verification):
 * all data fields except `sig`, sorted by key, joined as `key=value` with `&`,
 * HMAC-SHA256 with the shared secret, lowercase hex.
 */
function computeSig(data, secret) {
  const canonical = Object.keys(data)
    .filter((k) => k !== 'sig')
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join('&')
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
}

const KNOWN_TYPES = ['ARM_ALARM', 'CANCEL_ALARM', 'NUDGE', 'CANCEL_NUDGE', 'REQUEST_LOCATION', 'SYNC', 'PING']

function buildData(args) {
  const type = args.type || 'ARM_ALARM'
  if (!KNOWN_TYPES.includes(type)) {
    // Deliberately still SENDABLE via an explicit unknown type, because "what does the app do with
    // a type it has never heard of?" is a real thing to test — the app reports it back. Use
    // --force-unknown for that; a plain typo should fail here rather than silently do nothing.
    if (!args['force-unknown']) {
      throw new Error(`Unsupported --type "${type}" (use one of ${KNOWN_TYPES.join(', ')}, or --force-unknown)`)
    }
    return { v: '1', type }
  }

  if (type === 'SYNC' || type === 'PING') return { v: '1', type }

  if (type === 'REQUEST_LOCATION') {
    // Field-for-field what otto-server's `requestLocationData` produces. Optional fields are OMITTED
    // rather than sent empty, matching the server, so a payload from this helper and one from the
    // real sender sign identically — which is the only reason testing with this proves anything.
    const data = { v: '1', type, requestId: args['request-id'] || `loc_test_${Date.now()}` }
    data.maxAgeSeconds = String(args['max-age'] ?? 120)
    data.highAccuracy = String(args['high-accuracy'] === 'true')
    if (args['expires-in']) data.expiresAtMillis = String(Date.now() + Number(args['expires-in']) * 1000)
    if (args.reason) data.reason = String(args.reason).slice(0, 120)
    return data
  }

  if (type === 'NUDGE' || type === 'CANCEL_NUDGE') {
    const nudgeId = args['nudge-id'] || `rem_test_${Date.now()}`
    if (type === 'CANCEL_NUDGE') return { v: '1', type, nudgeId }
    const data = {
      v: '1',
      type,
      nudgeId,
      title: args.title || 'Otto',
      body: args.body || 'This is a test nudge.',
      level: args.level || 'NORMAL',
      // An explicitly empty string is meaningful and NOT the same as omitting the field: the app
      // reads absent as "use the default buttons" and empty as "no buttons at all".
      actions: args.actions === undefined ? 'DONE,SNOOZE' : args.actions,
      snoozeMinutes: args['snooze-minutes'] || '30',
    }
    if (args['expires-in']) {
      data.expiresAtMillis = String(Date.now() + parseInt(args['expires-in'], 10) * 1000)
    }
    if (args.ongoing) data.ongoing = args.ongoing
    return data
  }

  const alarmId = args['alarm-id'] || `alm_test_${Date.now()}`
  if (type === 'CANCEL_ALARM') {
    return { v: '1', type, alarmId }
  }
  const triggerAtMillis = args.at
    ? String(parseInt(args.at, 10))
    : String(Date.now() + (args.in ? parseInt(args.in, 10) : 60) * 1000)
  return {
    v: '1',
    type,
    alarmId,
    triggerAtMillis,
    label: args.label || 'Test push',
    allowWhileIdle: args['allow-while-idle'] || 'true',
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { usage(); return }

  if (!args.token) {
    console.error('ERROR: --token <DEVICE_FCM_TOKEN> is required. Copy it from the Otto app.\n')
    usage()
    process.exitCode = 2
    return
  }

  const keyPath = args.key || process.env.GOOGLE_APPLICATION_CREDENTIALS || resolve(HERE, 'service-account.json')
  let serviceAccount
  try {
    serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8'))
  } catch (e) {
    console.error(`ERROR: could not read service-account JSON at "${keyPath}".`)
    console.error('Firebase Console → Project Settings → Service accounts → Generate new private key,')
    console.error('then save it as tools/send-push/service-account.json (gitignored) or pass --key <path>.')
    process.exitCode = 2
    return
  }
  const projectId = serviceAccount.project_id
  if (!projectId) {
    console.error('ERROR: service-account JSON has no project_id.')
    process.exitCode = 2
    return
  }

  const data = buildData(args)
  if (args.secret) data.sig = computeSig(data, args.secret)

  const message = { message: { token: args.token, android: { priority: 'high' }, data } }

  if (args.dryRun) {
    console.log(`[dry-run] POST https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`)
    console.log(JSON.stringify(message, null, 2))
    return
  }

  const auth = new GoogleAuth({ credentials: serviceAccount, scopes: [FCM_SCOPE] })
  const accessToken = await auth.getAccessToken()

  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  })
  const body = await res.text()
  if (res.ok) {
    console.log(`OK (${res.status}): ${body}`)
    const subject = data.alarmId ?? data.nudgeId ?? ''
    const when = data.triggerAtMillis ? ` for ${new Date(Number(data.triggerAtMillis)).toLocaleString()}` : ''
    console.log(`Sent ${data.type} ${subject}${when}.`)
  } else {
    console.error(`FAILED (${res.status}): ${body}`)
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message || e)
  process.exitCode = 1
})
