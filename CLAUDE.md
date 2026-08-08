# CLAUDE.md — Otto Android companion app

Context for AI build sessions. The authoritative product spec is `spec.md`; this file
captures the decisions and conventions a future session needs before touching code.

## What this repo is

The **Android companion app only** for Otto, a personal WhatsApp-based AI scheduling
agent. The agent/server live in other repos. This app's single job: receive a
high-priority FCM **data** message from the server and arm a **real device alarm** that
rings reliably even when backgrounded, in Doze, or after reboot.

- Sideloaded to the owner's phone only (not Play). Restricted permissions are free to use.
- Android-only, native Kotlin. No cross-platform frameworks.
- The app never decides *when* to ring. The server sends absolute instructions
  ("arm alarm X at epoch T"); the app just executes them.

## Current status

**All five milestones (M1–M5) are implemented and build-verified.** M1 alarm spine; M2
server sync (registration, reporting, SYNC/PING, HMAC); M3 ring (snooze, volume ramp,
vibration, multi-alarm); M4 reliability (`RingService` foreground service, `TimeChangeReceiver`,
force-stop recovery, warning card); M5 polish (settings/pairing screen, self-heartbeat,
`NextAlarmTileService` quick-settings tile, structured `OttoLog`). A Node FCM test-push helper
lives in `tools/send-push/`; device-only checks are scripted in `docs/manual-testing.md`.

**M6 — the nudge tier (`feat/nudge-tier`, 99 unit tests, `assembleDebug` green).** The app could
previously do exactly one thing: ring at full volume, bypass DND and take the lockscreen. So
"chase me about this" and "wake me up" were the same request, and the server's only alternative
was a WhatsApp message capped by Meta's 24h reply window. M6 adds a graded notification tier
(three nudge channels plus an ongoing "N things open" summary), `NUDGE`/`CANCEL_NUDGE` FCM types,
Done/Snooze buttons that work **from the lockscreen without unlocking**, a `device_events` outbox
reporting them back, a local snooze re-show that works offline, and a standing periodic heartbeat
(there was none) carrying whether the owner has muted Otto. Room is at **v3**
(`MIGRATION_2_3`, schema `3.json`). See "Notification channels" below and the M6 section of
`docs/manual-testing.md`.

⚠️ **`connectedAndroidTest` must pass before installing over an existing build.** There is no
`fallbackToDestructiveMigration`, so a migration whose DDL does not reproduce the generated schema
byte for byte throws at first open — and on this app that means the owner's alarms stop working.
Never hand-write migration DDL: bump the version, build once so KSP exports the schema JSON, then
copy its `createSql` verbatim.

**Track-1 correctness hardening (merged to `main`) — 6 fixes done, build
green:** (1) SYNC is fail-safe — the pure `net/SyncReconciler.kt` never cancels
alarms on an empty/errored response; (2) a new append-only `alarm_events` outbox (`ReportWorker`
drains+deletes events, not current state) so SNOOZED and every transition reach the server
(dedupe on `(alarmId,event,atMillis)`); (3) heartbeat on app open; (4) a persisted `requestCode`
column replaces `alarmId.hashCode()` (Room **v2**, `data/Migrations.kt` `MIGRATION_1_2`; schemas
exported to `app/schemas/`; `AlarmScheduler.cancel(Int)`); (5) stuck-RANG → MISSED in `reArmAll`,
gated on `RingService.isActive()` so a live ring is never mis-flagged; (6) HMAC fails closed once
paired via `push/HmacGate.kt` + a persisted `hasEverPaired` latch. A `core/ReportTrigger` seam
keeps `AlarmRepository` off WorkManager (JVM-testable). This is Track 1 of a two-track effort;
Track 2 builds a separate Node/TS **Otto server** (WhatsApp + AI agent + FCM sender +
register/report/sync/heartbeat endpoints) — see the approved plan referenced in session notes.

**Release-ready:** `signingConfigs.release` reads a gitignored `keystore.properties` (falls back to
the debug key so `assembleRelease` still builds); release `SERVER_BASE_URL` is compiled from
`otto.serverBaseUrl` in `local.properties`/`-P`; `usesCleartextTraffic="false"`; the Settings URL
override is HTTPS-only; `versionName = 1.0.0`. Both `assembleDebug` and `assembleRelease` are green.
The **Otto server** now exists as a sibling repo at `../otto-server` (Node/TS, SQLite, Fastify) — its
`SETUP.md` is the turnkey owner walkthrough (Meta/Firebase/OpenAI/Google/hosting/pairing). As of
2026-08-08 the server's agent runs on the **OpenAI Responses API** with `gpt-5.6-luna`
(`OPENAI_API_KEY` / `OPENAI_MODEL`); it was previously Anthropic Claude Sonnet 5.
Still deferred: R8 minify. (Crashlytics is no longer deferred — see below.)

**Crashlytics — enabled, and the Gradle plugin is MANDATORY.** `implementation(libs.firebase.crashlytics)`
is active in `app/build.gradle.kts`, alongside `alias(libs.plugins.firebase.crashlytics)`
(`com.google.firebase.crashlytics` 3.0.7, catalog key `firebaseCrashlyticsPlugin`; verified compatible
with AGP 9.2.1). `OttoLog.w/e` forward breadcrumbs/non-fatals to `FirebaseCrashlytics.getInstance()`.

⚠️ **Do not remove that plugin, and do not re-derive that it's optional under R8-off.** An earlier
revision of this file claimed "no Gradle plugin is needed while R8/minify is off — the plugin only
uploads the R8 mapping file." **That is false and it shipped a 100%-reproducible launch crash.** The
plugin *also* injects a build-ID resource that `CrashlyticsCore.onPreExecute()` hard-asserts on; without
it, `FirebaseInitProvider` throws
`IllegalStateException: The Crashlytics build ID is missing` during application bind, killing the
process before `OttoApp` or any Otto code runs (observed on-device 2026-08-02, Samsung SM-XXXXX /
Android 16). Two things hid it: it needs a real `app/google-services.json` to reach Firebase init, so
it is structurally unreachable headlessly (all 67 unit tests pass regardless); and `OttoLog`'s
`runCatching` guard only wraps Otto's *own* calls into Crashlytics — it cannot protect auto-init, which
runs earlier and outside that guard.

Actual crash *upload* to the Firebase console is still unconfirmed. See `spec.md` §13.

## Stack (do not substitute — see `spec.md` §4)

Kotlin · Jetpack Compose · Coroutines/Flow · Firebase Cloud Messaging (high-priority
**data** messages) · `AlarmManager.setAlarmClock()` · full-screen-intent notification +
Activity · Room (source of truth) · WorkManager · Retrofit + OkHttp +
kotlinx.serialization · Hilt.

## Key decisions (kickoff Q&A + research)

These were settled at kickoff. Change them only with a clear reason.

- **DI = Hilt.** `@HiltAndroidApp` app; `@AndroidEntryPoint` on the FCM service and the
  receivers; `@HiltWorker` for WorkManager. Adds a `di/` package of modules.
- **applicationId / namespace = `com.otto.app`.** The Firebase Android app MUST be
  registered with this exact package name so `google-services.json` matches.
- **M1 commands = `ARM_ALARM` + `CANCEL_ALARM`.** The parser recognises the full v1
  schema and safely logs/ignores other `type`s; `SYNC`/`PING` and HMAC (`sig`) are M2;
  `NUDGE`/`CANCEL_NUDGE` are M6 (see the contract section below — six types now).
- **compileSdk / targetSdk = 36 (Android 16); minSdk = 26.**

### Platform realities the code depends on (verified mid-2026)

- **`setAlarmClock()` requires an exact-alarm permission** (it is NOT exempt — it only
  takes a PendingIntent). We declare `USE_EXACT_ALARM` (auto-granted to genuine alarm
  apps on API 33+) **plus** `SCHEDULE_EXACT_ALARM` capped at `maxSdkVersion="32"`.
  Still gate on `AlarmManager.canScheduleExactAlarms()` defensively.
- **Full-screen intent has no runtime permission dialog.** Check
  `NotificationManager.canUseFullScreenIntent()` (API 34+) and, if false, deep-link via
  `Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT`. Sideloaded ⇒ OS grants it at
  install; no Play Store to revoke it.
- **PendingIntents** must use `FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT` (API 31+).
  Idempotency per `alarmId` comes from a stable request code (PendingIntent equality
  ignores extras).
- **Data-only FCM** must set `android.priority = "high"` to wake a Dozing device, and
  must omit the `notification` block so `onMessageReceived` always fires.
- **Hilt + WorkManager:** `Configuration.Provider.workManagerConfiguration` is a Kotlin
  *property* with a computed `get()` (WorkManager 2.9+), and the manifest removes the
  default `WorkManagerInitializer` meta-data. Needs BOTH `com.google.dagger:hilt-compiler`
  AND `androidx.hilt:hilt-compiler` on `ksp`.
- **Receivers** (`AlarmReceiver`, `BootReceiver`) get deps via Hilt **`EntryPointAccessors`**,
  not `@AndroidEntryPoint`. A Kotlin `BroadcastReceiver` can't call `super.onReceive()` (the
  base method is abstract → "Abstract member cannot be accessed directly"), so the
  field-injection path doesn't compile. They define a `@EntryPoint` interface in
  `SingletonComponent` and use `goAsync()` for DB work (finish within ~10s).
- **`EncryptedSharedPreferences` is deprecated** (androidx.security:security-crypto, Apr
  2025). The M2 HMAC secret is stored by `SecretStore`, which encrypts it with a
  hardware-backed **Android Keystore AES/GCM** key and keeps the ciphertext in DataStore.
  (Deliberate change from the original "DataStore + Tink" plan: Keystore AES/GCM is
  dependency-free with a stable API since 23, and is exactly what Tink wraps — chosen so the
  crypto path compiles with certainty without on-device Tink-API testing.)
- **HMAC (`sig`) canonical form** — server, Android `HmacVerifier`, and the `tools/send-push`
  helper must all agree: every `data` field **except** `sig`, sorted by key, joined as
  `key=value` with `&`, then HMAC-SHA256 with the shared secret, lowercase hex. A unit test
  pins the Kotlin output to a vector cross-checked against node + openssl. Until a secret is
  provisioned (pairing, M5) the FCM service accepts commands unverified; once set, a
  missing/forged `sig` is dropped.
- **Room stays on the 2.x stable line** (3.0 is RC). `room-ktx` is merged into
  `room-runtime`; `work-runtime-ktx` likewise into `work-runtime`.

## Package structure (`com.otto.app`)

```
OttoApp                Application: @HiltAndroidApp + WorkManager Configuration.Provider
di/                    Hilt modules
push/                  OttoFcmService, FcmCommand + parser
alarm/                 AlarmScheduler (iface) + impl, AlarmReceiver
ring/                  AlarmRinger (iface) + SimpleRinger, RingActivity, NotificationChannels
nudge/                 NudgeController, NudgeNotifications, NudgeScheduler (iface) + impl,
                       NudgeActionReceiver, NudgeAlarmReceiver, NudgeLevel/Action/Timing
data/                  AlarmEntity, AlarmState, AlarmDao, OttoDatabase, AlarmRepository,
                       NudgeEntity, NudgeState, NudgeDao, NudgeRepository, DeviceEventEntity
data/prefs/            OttoPreferences (DataStore)
net/                   OttoApi (Retrofit), DTOs, RegistrationWorker
boot/                  BootReceiver
permissions/           PermissionState + helpers
ui/                    MainActivity, OttoScreen, OttoViewModel, theme/
core/                  Clock, DispatcherProvider, Logger, constants
```

Invariant: **Room is the source of truth.** The scheduler + AlarmManager are derived
state, rebuildable from Room (boot, app update, recovery). If they disagree, Room wins.
Everything keyed by `alarmId`; arm/cancel/ring are idempotent.

The nudge path has a narrower version of the same rule: **the phone is authoritative for what is
on screen right now; the server stays authoritative for what is open.** `nudges` is not a mirror
of the owner's reminders and must not become one — there is no sync endpoint and no reconciler,
because the push carries everything a notification needs. Drift is corrected by three mechanisms
only: a `CANCEL_NUDGE` push, the nudge's own `expiresAtMillis`, and a sweep of terminal rows.

**`nudge/` is deliberately separate from `alarm/`, all the way down.** Its own scheduler
interface, its own receivers, its own intent actions, its own request-code band. Never widen
`AlarmScheduler` to serve a nudge — that interface is the alarm path's contract and giving it a
second caller with different needs is the most likely way to regress the one thing this app must
never get wrong. `reArmAll()` iterates the `alarms` table only, so nudges are structurally
invisible to it.

## Build prerequisites & how to build

- **JDK 17+ required to run Gradle** (AGP 9.x). The machine's PATH `java` may be older;
  Android Studio's bundled JBR (21) works. For a CLI build set `JAVA_HOME` to a 17+ JDK.
- **Android SDK Platform 36** installed.
- **AGP 9 gotchas (these are verified by an actual build — don't "fix" them blindly):**
  AGP 9.2 defaults `android.newDsl=true`, which is incompatible with the standalone Kotlin
  Gradle plugin, so `gradle.properties` sets `android.newDsl=false` (+ `builtInKotlin=false`).
  The newest androidx `core`/`lifecycle` (1.19.0 / 2.11.0) require **compileSdk 37** (a
  preview), so we pin `core 1.16.0` / `lifecycle 2.9.x`, which compile against SDK 36 —
  bumping them means bumping compileSdk. Verified build: `:app:assembleDebug` + the 18 unit
  tests pass on JBR 21.
- **`google-services.json`** goes at **`app/google-services.json`** (gitignored, provided
  per-environment). Register the Firebase Android app with package name `com.otto.app`.
  The build fails clearly if the file is missing — that is intended (`spec.md` §16).
- `BuildConfig.SERVER_BASE_URL` defaults to the placeholder `https://otto.invalid/`;
  debug builds may override it from the UI (`ALLOW_URL_OVERRIDE`).

Build (CLI, once `google-services.json` is in place):
```
JAVA_HOME="<jdk17+>" ./gradlew :app:assembleDebug
```
Or just open in Android Studio and Run.

## FCM command contract (server → app)

Data-only, high priority. All `data` values are strings (FCM constraint). See `spec.md`
§7 for the full contract. **Six types:** `ARM_ALARM`, `CANCEL_ALARM`, `NUDGE`, `CANCEL_NUDGE`,
`SYNC`, `PING`.

```json
{ "message": { "token": "<device token>", "android": { "priority": "high" },
  "data": { "v": "1", "type": "ARM_ALARM", "alarmId": "alm_...",
            "triggerAtMillis": "1751200000000", "label": "Email Teal",
            "allowWhileIdle": "true" } } }
```

`NUDGE` carries `nudgeId`, `title`, `body` (required) plus `level` (`SILENT|NORMAL|URGENT`),
`actions` (CSV of `DONE,SNOOZE,LATER,OPEN`), `snoozeMinutes`, `expiresAtMillis`, `ongoing`.
`CANCEL_NUDGE` carries only `nudgeId`. Built server-side by `src/fcm/commands.ts` `nudgeData` /
`cancelNudgeData`, and pinned end-to-end by `push/ServerPayloadContractTest.kt`, which holds
payloads the server actually produced — signature included — because nothing at build time checks
one repo against the other.

Rules: idempotent on `alarmId` / `nudgeId`; past times within a grace window (default 60s) still
fire, older are marked MISSED; unknown fields ignored; unknown `type` logged, dropped, **and
reported back** as a `PUSH/REJECTED` device event.

⚠️ **`v` stays `"1"` forever.** The parser drops any payload whose `v` mismatches, so bumping it
would make every new push invisible to a device that has not updated — the silent failure the
rejection reporting exists to remove. New `type` values are the extension mechanism.

⚠️ **The HMAC is verified BEFORE the payload is parsed.** That ordering is a security requirement,
not tidiness: the rejection path emits an authenticated HTTPS request, so parsing first would let
anyone holding the FCM token use this device as a probing and amplification oracle. Nothing is
ever reported about a push that failed the gate.

The canonical HMAC form is generic over the whole `data` map (every key except `sig`, sorted), so
adding fields or types needs **no crypto change on either side**. That genericity is pinned by a
tampering test rather than assumed.

## Notification channels

| id | importance | used for |
|---|---|---|
| `otto_alarm` | HIGH, bypass-DND, silent (the ringer plays audio itself) | a ringing alarm |
| `otto_nudge_urgent` | HIGH | heads-up chase, sound + vibration — **not** an alarm |
| `otto_nudge` | DEFAULT | the everyday rung: sound, no peek |
| `otto_quiet` | LOW | silent but visible: confirmations, FYIs |
| `otto_status` | LOW, no badge | the ongoing "N things open" summary |

Two platform facts the design depends on, both easy to get wrong:

1. **Channel settings become the user's at creation.** `createNotificationChannel` updates only
   name/description/group on an existing channel and ignores importance, sound and vibration. So
   creation is idempotent (call it unconditionally — an early return there once meant new channels
   were never created on upgrade, which would have shipped the whole tier dead on arrival), and a
   channel needing different behaviour needs a **new id**.
2. **`setBypassDnd(true)` is inert without `ACCESS_NOTIFICATION_POLICY`,** which this app does not
   request. Alarms clear DND because they are `CATEGORY_ALARM` on the alarm stream. Nudges use
   `CATEGORY_REMINDER`, which the owner can allow through DND from Android's own Priority
   settings with no app permission. Do not design anything here around bypass working.

**Never post a chase on `otto_alarm`.** It is the one channel that has to survive a mute, and
`channelIdFor(level)` is an exhaustive `when` over the three nudge levels with a test pinning that
it can never return the alarm channel.

Nudges schedule their local re-show with `setAndAllowWhileIdle` — never `setAlarmClock` (which
raises the system alarm icon and hard-wakes Doze) and never `setExactAndAllowWhileIdle` (which
spends the exact-alarm budget on something that does not need second accuracy). Deep Doze may run
it ~15 minutes late; that is accepted, not a bug to fix with exact alarms.

## Conventions

- Light MVVM, one ViewModel for the control screen.
- Inject a `Clock` wherever time is read so scheduler logic is unit-testable.
- Prefer hand-written fakes over mocking libraries in tests (spec calls for a fake
  `Clock` and a fake AlarmManager wrapper).
- Git: commit per component with clear messages.

## M1 definition of done (`spec.md` §13)

- "Arm test alarm (+60s)" rings full-screen with the screen off and locked.
- A manual FCM data message arms an alarm that rings.
- After reboot, future ARMED alarms are restored from Room and fire.
- The UI shows every permission state and can grant each one.
