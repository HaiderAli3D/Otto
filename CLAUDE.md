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

**Milestone 1 (alarm spine)** in progress. M2–M5 are out of scope until M1 ships.
See `spec.md` §13 for the milestone breakdown.

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
  schema and safely logs/ignores other `type`s; `SYNC`/`PING` and HMAC (`sig`) are M2.
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
  2025). M1 doesn't need it; when M2 needs the HMAC secret, use **DataStore + Tink**, not
  security-crypto.
- **Room stays on the 2.x stable line** (3.0 is RC). `room-ktx` is merged into
  `room-runtime`; `work-runtime-ktx` likewise into `work-runtime`.

## Package structure (`com.otto.app`)

```
OttoApp                Application: @HiltAndroidApp + WorkManager Configuration.Provider
di/                    Hilt modules
push/                  OttoFcmService, FcmCommand + parser
alarm/                 AlarmScheduler (iface) + impl, AlarmReceiver
ring/                  AlarmRinger (iface) + SimpleRinger, RingActivity
data/                  AlarmEntity, AlarmState, AlarmDao, OttoDatabase, AlarmRepository
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
§7 for the full contract.

```json
{ "message": { "token": "<device token>", "android": { "priority": "high" },
  "data": { "v": "1", "type": "ARM_ALARM", "alarmId": "alm_...",
            "triggerAtMillis": "1751200000000", "label": "Email Teal",
            "allowWhileIdle": "true" } } }
```

Rules: idempotent on `alarmId`; past times within a grace window (default 60s) still
fire, older are marked MISSED; unknown fields ignored; unknown `type` logged and dropped.

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
