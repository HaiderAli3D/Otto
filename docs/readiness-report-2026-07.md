# Otto readiness review — 2026-07-02

End-to-end review of both repos with the goal: **sideload the app, pair it, message Otto on
WhatsApp, get replies and alarms that ring reliably.** Scope: fix everything found, build + test
both repos, full device-auth hardening, implement recurrence.

- App: `C:\programming\gits\Otto` — branch `fix/app-correctness-track1`
- Server: `C:\programming\gits\otto-server` — branch `fix/server-hardening-track1`

## Verdict

**Ready for on-device bring-up.** The full loop is implemented, hardened, and build-verified on
both sides. All 27 verified review findings are fixed; recurring alarms are implemented. Two
items are deliberately deferred (below), neither blocking the core loop. The only remaining work
is **owner setup + on-device acceptance testing**, which can't be done headlessly.

Verification (re-run clean this session):
- **App:** 67 unit tests pass; `assembleDebug`, `assembleRelease`, and `compileDebugAndroidTest` all green.
- **Server:** 65 tests pass; `typecheck` and full `tsc` build green; boots without import cycles.

## What was found and fixed

Method: 3 exploration agents mapped both repos and confirmed all 7 cross-repo contract seams
match exactly. A 6-dimension, adversarially-verified review (2-of-3 refuter votes) surfaced 27
confirmed defects (9 candidates rejected). Fixes landed in two waves, committed per component.

### Highest-severity (would break the core loop or leak access)
- **WhatsApp any-sender takeover (server).** The webhook authenticated Meta's signature but not
  the *sender*; any stranger who messaged the business number was routed to the owner's device
  with full agent + Google access, and could overwrite the owner's number link. Fixed with an
  `OWNER_WA_NUMBERS` allowlist (or trust-on-first-use when unset), no link overwrite, wamid
  dedupe, and per-user serialization.
- **Agent crash that wiped the conversation (server).** After 6 tool steps the final model call
  omitted `tools` while the history held tool_use/tool_result blocks — a guaranteed API 400 that
  reset the whole session and replied "I hit a snag." Fixed by keeping `tools` with
  `tool_choice: none`.
- **Timezone never captured (both).** Alarm times were interpreted in the server's
  `DEFAULT_TIMEZONE`, not the phone's — "6pm" could ring at the wrong hour. The app now reports
  its IANA zone on registration/heartbeat (and on a timezone change); the server stores and uses it.
- **Mid-ring reschedule corruption (app).** Re-arming a ringing alarm left the ring sounding and
  let the stale ring screen's Dismiss flip the rescheduled alarm to terminal DISMISSED (so it
  never fired). Fixed: `arm()` refreshes the ring; Dismiss/Snooze act only while still RANG.
- **SYNC re-ringing finished alarms (app).** Reconciliation blindly re-armed alarms the phone had
  already dismissed/cancelled (server view lags), and cancelled locally-snoozed ones. Fixed: skip
  locally terminal/RANG rows; never cancel an alarm with a pending outbox event.
- **Event-ordering corruption (both).** The outbox drained past failures (out of order) and the
  server applied every event unconditionally, so a replayed ARMED could resurrect a cancelled
  alarm or kill the watchdog for a newer re-arm. Fixed: strict in-order drain (break on failure)
  + server ignores duplicate/stale events.
- **Silent-networking trap (app).** A server URL without a trailing slash made Retrofit throw
  inside a swallowed try/catch — total networking no-op. Now normalized everywhere.
- **Unauthenticated device/admin endpoints (both).** Device routes now require a request
  signature once paired (fail-closed, mirroring the FCM push HMAC); `ADMIN_TOKEN` is mandatory
  off-localhost (the server refuses to boot without it), guarding the pairing-secret endpoint.
- **OAuth account-binding forgery (server).** The Google callback used the raw deviceId as
  `state`; now an unguessable single-use nonce.

### Medium / low (correctness, robustness, hygiene)
Snooze trigger now reaches the server; state-write + outbox-insert made atomic; FCM
token-clearing narrowed to genuinely-dead tokens; `cancel_alarm` reports delivery; ISO parsing
rejects embedded offsets and surfaces bad calendar bounds; FCM calls time out; scheduler skips
overlapping ticks; graceful shutdown drains in-flight arms; arm-ack give-up notifies the owner;
WhatsApp send retries; non-text messages get a reply; unsupported FCM schema versions are
ignored; release logging gated to warn/error; battery-exemption prompted once; dead code removed.

### New feature: recurring alarms
"Wake me every weekday at 7", "every day at 22:00", "monthly on the 1st". The phone still holds
only the next occurrence (per spec — it never decides *when*); the server owns the series
(minimal RRULE, DST-correct via luxon), arming the next occurrence after each ring via an
event-driven path with a scheduler backstop, race-guarded so it advances exactly once.
Cancelling the pending alarm ends the series.

### Observability
Crashlytics is now enabled (the dependency resolves on this machine) and `OttoLog.w/e` forward
breadcrumbs/non-fatals, guarded so a missing SDK can never crash the app. **Crash upload itself
must be confirmed on a device against the Firebase console** — it can't be verified headlessly.

## Deferred (documented, not blocking)

1. **Direct-boot reboot survival.** After an *unattended* reboot that sits locked past an alarm
   time, alarms currently re-arm only at first unlock (Room/DataStore are credential-encrypted, so
   `BOOT_COMPLETED` is deferred until unlock). A correct fix needs a device-protected-storage
   migration for the minimal re-arm data plus a direct-boot-aware receiver — and, critically,
   **on-device validation of the boot path**, which can't be done headlessly. Shipping untested
   boot-path code is riskier than the narrow gap, so this is deferred with a clear plan. (This is
   the one spec §3/§10 item not fully met; it degrades gracefully — a phone unlocked before the
   alarm time is unaffected.)
2. **v1→v2 stale PendingIntent.** Only affects a phone upgraded in-place from a v1 build; no v1
   was ever released (this is versionCode 1), so it's moot for a fresh install.

## Deviation from the approved plan

The plan's Phase 4 called for writing the two spec §15 instrumentation suites (BootReceiver
re-arm, RingActivity over lockscreen) compile-verified. On inspection these need a Hilt test
scaffold that doesn't exist *and* a real device to validate anything — a compile-only stub that
can never be run gives false confidence and adds maintenance surface. They're listed as owner
device-run follow-ups below instead. The existing `MigrationTest` remains the one instrumentation
test (device-run).

## Owner checklist — bring-up on your phone

Server (see `otto-server/SETUP.md`, now updated):
1. Firebase service account → `.env` (§2). Set `ADMIN_TOKEN` (required off-localhost) and
   `OWNER_WA_NUMBERS` to your number. Add `ANTHROPIC_API_KEY` for the agent.
2. Get a public HTTPS origin (Fly.io / VPS+Caddy / cloudflared) and set `PUBLIC_ORIGIN`.
3. Configure the four `META_*` WhatsApp vars + the webhook (§7); subscribe to the `messages` field.

App:
4. Set `otto.serverBaseUrl` in `local.properties` (release) or use Settings → server URL (debug),
   then install (`assembleDebug` from Android Studio, or the release APK).
5. Grant permissions: notifications, exact alarm, full-screen intent, and the
   **battery-optimization exemption** (now prompted on first launch) — essential for Doze.
6. Open the app once (registers the FCM token + reports timezone), then pair: `GET /admin/devices`
   → paste `hmacSecret` into Settings → Pair.

Verify (the manual matrix in `docs/manual-testing.md`, plus):
7. `POST /admin/test-alarm` → phone rings full-screen in ~60s (screen off + locked).
8. Message Otto on WhatsApp: "remind me to call mum at 6pm" → reply + alarm; "every weekday at 7"
   → recurring; "what alarms do I have?" / "cancel that".
9. Reboot **and unlock** → future alarms restored and fire (note the direct-boot deferral above).
10. Doze test (`adb shell dumpsys deviceidle force-idle`), time/timezone change, force-stop
    behaviour, foreground-ring survival (swipe from recents).
11. Confirm a Crashlytics non-fatal appears in the Firebase console after triggering an
    `OttoLog.e` path.

Recommended device-run test additions (spec §15, not yet written): BootReceiver re-arm and
RingActivity-over-lockscreen instrumentation suites (`./gradlew :app:connectedDebugAndroidTest`,
alongside the existing `MigrationTest`).
