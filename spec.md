# Otto Android Companion — Technical Specification

| | |
|---|---|
| Project | Otto Android companion app |
| Component | Native Android client (this repo only) |
| Version | 1.0 (draft) |
| Status | For build kickoff |
| Platform | Android, native Kotlin |
| Owner | Haider |

This document specifies the Otto Android companion app in full. It is the
reference for every build session. The kickoff prompt covers Milestone 1; this
spec covers the whole project so later milestones inherit consistent decisions.

---

## 1. Purpose and scope

Otto is a personal WhatsApp-based AI scheduling agent. The agent and its backend
run on a server outside this repo. This repo is only the Android companion app.

The companion exists for one reason: a server cannot ring a phone. Calendar
events and reminders sync or arrive over WhatsApp without any app on the device.
A true alarm (loud, full-screen, dismiss to stop) must be scheduled by code
running on the phone. The companion is that code.

### In scope (this repo)
- Receiving commands from the Otto server via Firebase Cloud Messaging.
- Arming, cancelling, and ringing real device alarms that survive Doze, screen
  lock, and reboot.
- Persisting alarm state locally as the on-device source of truth.
- Reporting alarm outcomes and the device push token back to the server.
- A minimal UI to pair the device, manage permissions, and test the alarm path.

### Out of scope (other repos, do not build here)
- The Otto server, agent loop, and tool calling.
- The WhatsApp Cloud API integration and the reminder follow-up loop.
- Google Calendar and Google Tasks access.
- Any reminder, scheduling, or calendar logic. The companion never decides
  when an alarm should fire. It only does what the server tells it.

---

## 2. System context

```
Otto server  ──FCM data message──▶  Companion app  ──arms──▶  Android OS
   ▲                                      │                   (AlarmManager)
   │                                      │                        │
   └────────HTTPS event reports───────────┘                   fires at time
                                                                   │
                                                              Ring screen
```

The companion is a leaf in the wider Otto system. Its only inbound channel is
FCM. Its only outbound channel is HTTPS to the server. It holds no agent logic
and stores no user calendar data.

The boundary to hold firm: the server speaks in absolute instructions
("arm alarm X at epoch T with label L"). The companion never interprets intent,
parses natural language, or computes times. That keeps all reasoning on the
server where it can be changed without shipping a new APK.

---

## 3. Goals and non-goals

### Goals
- An armed alarm rings at the correct time with the screen off, the device
  locked, and the app backgrounded or swiped away.
- Alarms survive a reboot.
- The server can arm and cancel alarms remotely and learn the outcome.
- The app degrades gracefully and visibly when a permission is missing, rather
  than failing silently.

### Non-goals
- Cross-platform support. Android only.
- Offline alarm creation by the user inside the app (beyond the test button).
  Otto creates alarms; the app executes them.
- A rich alarm-clock product. The UI is a control panel, not a consumer alarm
  app.

---

## 4. Tech stack

| Concern | Choice | Rationale |
|---|---|---|
| Language | Kotlin | Native, no abstraction tax on OS integration |
| UI | Jetpack Compose | UI is tiny; Compose is the least boilerplate |
| Async | Coroutines + Flow | Standard, integrates with Room and WorkManager |
| Push | Firebase Cloud Messaging | High-priority data messages wake the app in Doze |
| Alarm | `AlarmManager.setAlarmClock()` | Only alarm type exempt from Doze; status-bar icon |
| Ring | Full-screen-intent notification + Activity | Rings over the lockscreen; permission auto-granted for alarm apps |
| Persistence | Room | Typed, observable, survives process death and reboot |
| Boot re-arm | `BOOT_COMPLETED` receiver | AlarmManager drops all alarms on restart |
| Background jobs | WorkManager | Reliable, deferrable token registration and reporting |
| Networking | Retrofit + OkHttp + kotlinx.serialization | Small, well understood |
| DI | Open decision (see section 14) | Hilt or manual; pick once and document |
| minSdk / targetSdk | 26 / latest stable | 26 covers the needed APIs; target latest for policy |

Do not substitute frameworks. The reliability of the alarm path depends on
these specific APIs behaving as documented, and cross-platform wrappers leak
exactly here.

---

## 5. Architecture

### 5.1 Runtime flow

```
FCM push ─▶ OttoFcmService ─▶ AlarmScheduler ─▶ AlarmManager (OS)
                  │                  │                  │
              persist            persist            at trigger time
                  ▼                  ▼                  ▼
             Room store ◀──── (source of truth)   AlarmReceiver ─▶ RingActivity

BOOT_COMPLETED ─▶ BootReceiver ─▶ read Room ─▶ AlarmScheduler (re-arm all)
```

The Room store is the source of truth. The scheduler and AlarmManager are
derived state that can be rebuilt from Room at any time (on boot, after an app
update, after a force-stop recovery). This is the single most important
invariant in the app: if Room and AlarmManager disagree, Room wins and the
scheduler reconciles.

### 5.2 Proposed package structure

```
website.haiders.otto
├── app/            OttoApp (Application), DI wiring
├── push/           OttoFcmService, command parsing, token handling
├── alarm/          AlarmScheduler (iface + impl), AlarmReceiver, AlarmCommand
├── ring/           AlarmRinger (iface), SimpleRinger, RingActivity
├── data/           AlarmEntity, AlarmDao, OttoDatabase, AlarmRepository
├── net/            OttoApi (Retrofit), DTOs, RegistrationWorker, ReportWorker
├── boot/           BootReceiver, TimeChangeReceiver
├── permissions/    PermissionState, permission helpers
├── ui/             Compose screens, ViewModels
└── core/           Clock abstraction, dispatchers, Result types, logging
```

(Replace `website.haiders.otto` with your preferred application id.)

### 5.3 Patterns
- Light MVVM. One ViewModel for the single control screen. No architecture
  ceremony beyond what the screen needs.
- Inject a `Clock` everywhere time is read, so scheduler logic is unit-testable
  without waiting in real time.
- All scheduler and ring entry points are idempotent and keyed by `alarmId`.

---

## 6. Data model

### 6.1 AlarmEntity (Room)

| Field | Type | Notes |
|---|---|---|
| `alarmId` | String, PK | Server-generated stable id |
| `triggerAtMillis` | Long | Absolute epoch ms, UTC |
| `label` | String | Shown on the ring screen |
| `state` | Enum | ARMED, RANG, DISMISSED, SNOOZED, CANCELLED, MISSED |
| `allowWhileIdle` | Boolean | Defaults true for alarms |
| `snoozeCount` | Int | 0 until snooze ships (M3) |
| `createdAtMillis` | Long | First seen |
| `updatedAtMillis` | Long | Last state change |
| `reportedToServer` | Boolean | False until the outcome is acknowledged |

### 6.2 State machine

```
        arm
  ─────────────▶ ARMED ───fire──▶ (ringing) ──dismiss──▶ DISMISSED
                   │                  │
              cancel │            snooze │ (M3)
                   ▼                  ▼
               CANCELLED          re-ARMED (+N min, snoozeCount++)

  ARMED ──missed (fired but never shown, e.g. force-stop)──▶ MISSED
```

DISMISSED, CANCELLED, and MISSED are terminal. Terminal alarms are kept until
their outcome is reported to the server, then may be pruned by a retention job.

### 6.3 Local key-value (DataStore)
- Current FCM token and last successful registration timestamp.
- Server base URL override (debug only).
- One-time flags (battery-exemption prompt shown).

---

## 7. FCM command contract

This is the interface between the server and the companion. Treat it as a
versioned contract. The server owns it; the app must tolerate unknown fields and
reject unknown `type` values safely.

### 7.1 Message shape

Use data-only messages with high priority. Notification messages are handled by
the system tray when the app is backgrounded and will not reliably run the
command code. Every value in `data` is a string (FCM constraint).

```json
{
  "message": {
    "token": "<device FCM token>",
    "android": { "priority": "high" },
    "data": {
      "v": "1",
      "type": "ARM_ALARM",
      "alarmId": "alm_8f2c...",
      "triggerAtMillis": "1751200000000",
      "label": "Email Teal",
      "allowWhileIdle": "true",
      "sig": "<HMAC-SHA256 of canonical payload>"
    }
  }
}
```

### 7.2 Command types

| `type` | Effect |
|---|---|
| `ARM_ALARM` | Arm or replace the alarm with `alarmId` at `triggerAtMillis`. Idempotent. |
| `CANCEL_ALARM` | Cancel `alarmId` if present. No-op if unknown. |
| `NUDGE` | Post a notification — never an alarm. Carries `nudgeId`, `title`, `body`, plus `level`, `actions`, `snoozeMinutes`, `expiresAtMillis`, `ongoing`. Pushing the same `nudgeId` updates one notification in place. |
| `CANCEL_NUDGE` | Withdraw a nudge by `nudgeId`. |
| `REQUEST_LOCATION` | Take ONE location fix and POST it back. Carries `requestId` (required), `maxAgeSeconds`, `expiresAtMillis`, `highAccuracy`, `reason`. Answers exactly once — no interval, no duration, no stop command, and nothing left running. |
| `SYNC` | Reconcile. App fetches the authoritative alarm list from the server and arms/cancels to match. |
| `PING` | Liveness check. App reports a heartbeat with token and app version. |

### 7.3 Rules
- Idempotency: `alarmId` is the key. Arming an existing id replaces its time and
  label; it never creates a duplicate PendingIntent.
- Past times: if `triggerAtMillis` is at or before now, fire within a short grace
  window (configurable, default 60s). If older than the grace window, mark
  MISSED and report it rather than ringing late.
- Integrity (M2): `sig` is an HMAC over a canonical ordering of the data fields
  using a shared secret provisioned at pairing. Reject messages that fail the
  check. This prevents a leaked token alone from arming alarms.
- Forward compatibility: ignore unknown fields; drop and log unknown `type`. A dropped `type` is
  also REPORTED back as a `PUSH/REJECTED` device event, because a contract mismatch is otherwise
  invisible on both sides — the server records a successful send and the phone records a drop.
- Version gating: the server must not send a `type` the installed app predates. `NUDGE` requires
  app ≥ 1.1.0, `REQUEST_LOCATION` ≥ 1.2.0 (`otto-server/src/services/push.ts`). This matters most
  for `REQUEST_LOCATION`, which has no fallback transport: a nudge that cannot be pushed goes over
  WhatsApp, while an unanswerable location request just leaves the agent waiting.
- Location, specifically: the app answers one `REQUEST_LOCATION` and posts the result — or the
  reason there is not one — to `POST /devices/{deviceId}/location`. It registers no location
  updates and writes no coordinate to its database, so there is no location history to keep or
  delete. Every fix posts a visible notification on `otto_quiet` naming what it was for.

### 7.4 App to server reports (HTTPS)

| Endpoint | When |
|---|---|
| `POST /devices/{deviceId}/token` | On first launch and every token refresh |
| `POST /alarms/{alarmId}/events` | On ARMED, RANG, DISMISSED, SNOOZED, MISSED, CANCELLED |
| `POST /devices/{deviceId}/heartbeat` | On PING and on app open |

Reports carry `{ event, atMillis, appVersion }`. Token registration and
heartbeat additionally carry an optional `timezone` (IANA zone id, e.g.
`Europe/London`) so the server knows the device's current zone when composing
wall-clock instructions. Reports are queued through WorkManager so they survive
network loss and retry with backoff. The server uses RANG and DISMISSED to know
whether a real-world alarm was acted on.

---

## 8. Alarm and ring behaviour

- Arming uses `setAlarmClock(AlarmClockInfo(triggerAtMillis, showIntent), op)`.
  This is wall-clock (RTC) based, so the system handles DST and manual time
  changes correctly.
- Firing: `AlarmReceiver` receives the broadcast, marks the alarm ringing in
  Room, and posts a full-screen-intent notification (category `alarm`,
  importance high) whose full-screen intent launches `RingActivity`.
- `RingActivity` sets `showWhenLocked` and `turnScreenOn`, plays the alarm
  stream, and shows the label with a dismiss control. M1 uses the default alarm
  ringtone via `RingtoneManager`. M3 adds volume ramp, vibration pattern, and
  snooze.
- A short-lived foreground service backs the ring (M4) so the sound is not
  killed if the Activity is dismissed by the system under memory pressure.
- Multiple alarms: each has its own `alarmId`, PendingIntent request code, and
  notification id. Simultaneous alarms stack; the most recent takes the screen.
- Timezone: the app is timezone-agnostic. All times are absolute epoch ms. If
  the user changes timezone, the meaning of "9am" is the server's concern; the
  companion fires at the absolute instant it was given.

---

## 9. Permissions and system integration

| Permission | Type | Android | Strategy |
|---|---|---|---|
| `INTERNET` | Normal | all | Declared |
| `POST_NOTIFICATIONS` | Runtime | 13+ | Request in-context at setup; block ringing UX explanation if denied |
| `USE_EXACT_ALARM` | Restricted | 13+ | Declared. Auto-granted for alarm apps. Free to use when sideloaded |
| `SCHEDULE_EXACT_ALARM` | Special | 12+ | Fallback path: check `canScheduleExactAlarms()`, deep-link to settings if needed |
| `USE_FULL_SCREEN_INTENT` | Special | 14+ | Declared. Auto-granted because the core function is alarms |
| `RECEIVE_BOOT_COMPLETED` | Normal | all | Declared; required to re-arm after reboot |
| `VIBRATE` | Normal | all | Declared for the ring pattern |
| Battery optimization exemption | Special | 6+ | Prompt once via `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`; improves FCM delivery in Doze |

Graceful degradation: every permission has a visible state in the UI with a
one-tap path to grant it. If exact-alarm capability is unavailable, the app says
so plainly rather than pretending an alarm is armed. Never silently downgrade a
true alarm to an inexact one without telling the user.

---

## 10. Reliability and edge cases

These are the failure modes that make or break an alarm app. Each must have a
defined behaviour.

| Case | Behaviour |
|---|---|
| Reboot | `BootReceiver` reloads Room and re-arms all future ARMED alarms |
| App update | App-update broadcast triggers the same re-arm path as boot |
| Force-stop by user | The OS cancels pending alarms and stops FCM delivery until next launch. Detect on next open, reconcile from server, and warn the user that force-stopping breaks alarms |
| Doze | High-priority FCM wakes the app long enough to arm; `setAlarmClock` then fires regardless of Doze |
| Manual time or timezone change | `TimeChangeReceiver` (`TIME_SET`, `TIMEZONE_CHANGED`) revalidates all armed alarms against Room |
| Duplicate push | Idempotent on `alarmId`; a repeat ARM replaces, does not duplicate |
| Push arrives while ringing | New alarm is armed normally; does not interrupt the current ring unless it is also due |
| Token rotation | `onNewToken` enqueues re-registration; alarms already armed are unaffected |
| Network loss during report | WorkManager retries with exponential backoff until acknowledged |
| Missed fire (fired but never shown) | Marked MISSED, reported, surfaced in the UI |

Known platform limitation to document for the user: an OS-level force-stop
(Settings, swipe-away on some OEMs, aggressive battery managers) prevents both
FCM delivery and pending alarms. The mitigation is the battery-optimization
exemption plus a clear warning. This is an Android constraint, not a bug to fix
in code.

---

## 11. Security

- Pairing provisions a `deviceId` and a shared secret used for the optional
  payload HMAC. The secret is stored in `EncryptedSharedPreferences`.
- The app trusts FCM project authentication for delivery and adds the HMAC check
  (M2) so a leaked token alone cannot arm alarms.
- No user calendar, message, or account data is stored on device. Room holds
  only alarm times and labels.
- All server traffic is HTTPS. Certificate pinning is optional and deferred.
- Logs never contain the shared secret or full tokens.

---

## 12. UI specification

One screen for M1, expandable later. Sections:

1. Pairing status: deviceId, paired or not, server base URL (debug builds only).
2. FCM token: shown and copyable, for sending test pushes.
3. Permission panel: each permission with granted or missing state and a grant
   button. Battery-optimization exemption included.
4. Armed alarms: live list from Room (label, fire time, state), newest first.
5. Test controls: "Arm test alarm (+60s)" exercising the scheduler with no push;
   "Send self heartbeat" for the report path.

Design language is functional and calm. This is an internal control panel, so
clarity beats decoration. M5 may add a proper pairing flow (scan a code from the
server) and a settings screen.

---

## 13. Milestones

### M1 — Alarm spine (local)
Push to arm to ring, plus reboot re-arm and the test UI. No server required;
validated with the test button and a manual FCM push. This is the kickoff
milestone.

Definition of done:
- "Arm test alarm (+60s)" rings full-screen with the screen off and locked.
- A manual FCM data message arms an alarm that rings.
- After reboot, future alarms are restored from Room and fire.
- The UI shows every permission state and can grant each one.

### M2 — Server sync
Token registration, alarm event reporting, `CANCEL_ALARM`, `SYNC` reconciliation,
and payload HMAC verification. WorkManager-backed reporting with retry.

### M3 — Ring experience
Branded full-screen ring, snooze, vibration patterns, volume ramp, and correct
handling of multiple simultaneous alarms.

### M4 — Reliability hardening
Foreground service for the ring, force-stop detection and user warning, time and
timezone change handling, missed-alarm detection and reporting, and a Doze test
pass using adb.

### M5 — Polish and observability
Crashlytics, structured logging, a real pairing flow, a settings screen, and an
optional quick-settings tile to show the next alarm.

---

## 14. Open decisions

These need a call before or during the relevant milestone. The build should
surface them rather than guess.

- DI: Hilt or manual constructor injection. The app is small enough that manual
  may be cleaner; Hilt helps if the graph grows. Pick once, document in
  CLAUDE.md.
- Snooze semantics: fixed interval, or interval supplied by the server per
  alarm. Affects the M3 data model.
- Whether the companion ever surfaces non-alarm reminders, or stays alarm-only.
  Current assumption: alarm-only.
- Multi-device: one phone for now. If more devices pair later, the server keys
  reports by `deviceId`, which the contract already supports.

---

## 15. Testing strategy

### Unit
- Scheduler arm/cancel/replace logic against a fake `Clock` and a fake
  AlarmManager wrapper.
- Command parsing: valid, past-time, unknown type, missing fields, bad HMAC.
- State machine transitions.

### Instrumentation
- Room DAO round-trips and migrations.
- BootReceiver re-arm path.
- RingActivity launches over the lockscreen.

### Manual test matrix
| Scenario | How |
|---|---|
| Ring with screen locked | Arm +60s, lock, wait |
| Ring in Doze | `adb shell dumpsys deviceidle force-idle`, then arm via push |
| Survive reboot | Arm a future alarm, `adb reboot`, confirm it fires |
| Time change | Change device time forward past an alarm, confirm correct handling |
| Force-stop behaviour | Force-stop in Settings, confirm the warning on reopen |
| Token refresh | Clear FCM token, confirm re-registration |

### Sending a test push (FCM v1)
Get an OAuth2 access token from the service-account credentials, then POST to
`https://fcm.googleapis.com/v1/projects/<project-id>/messages:send` with the
data-only body from section 7.1. A small helper script in `/tools` should wrap
this so test pushes are one command.

---

## 16. Build and configuration

- Gradle with the Kotlin DSL and version catalogs.
- `google-services.json` lives in the app module root. The build fails clearly
  if it is missing.
- `BuildConfig.SERVER_BASE_URL` defaults to an obvious placeholder so the app
  builds and runs before the server exists. Debug builds allow an override from
  the UI.
- Build types: debug (verbose logging, URL override) and release (signed for
  sideload, logging stripped).
- Git: initialise on first scaffold, commit per component with clear messages,
  and keep `CLAUDE.md` in the repo root mirroring this spec's decisions.

---

## 17. Glossary

- Arm: register an alarm with the OS so it will fire at a time.
- Ring: the full-screen, audible alarm experience when an alarm fires.
- Doze: Android's deep idle state that defers most background work.
- Full-screen intent: a notification that can launch an Activity over the
  lockscreen, permitted for alarm and calling apps.
- Reconcile: bring the device's armed alarms into agreement with the server's
  authoritative list.