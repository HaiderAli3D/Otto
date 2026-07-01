# Otto — Action Plans: get to "fully installable & operational"

Two plans in one file:

- **Part A — Agent plan:** the engineering work a fresh Claude agent must do to close every gap
  found in the verified gap-analysis, so the app is release-installable and fully functional.
- **Part B — Owner plan:** the human-only setup **you** must do (Firebase, keystore, server URL,
  on-device permissions, pairing, acceptance testing).

They interlock — see **Handoffs** at the end for who unblocks whom.

Source of truth for *why* each item exists: the verified audit (5 auditors, every claimed gap
re-checked against the code). File:line references are from that audit and may drift by a few
lines as edits land — treat them as "start here", not gospel.

---

## Current state (read first)

- Milestones **M1–M5 are committed**; `HEAD` is the "M5" commit. The **local alarm spine genuinely
  works and is build-verified**: `:app:assembleDebug` is green and **25 unit tests pass** across
  `AlarmTimingTest`, `AlarmRequestCodesTest`, `CommandParserTest`, `HmacVerifierTest`.
- What is **not** done: the app **cannot reach a real server** (a bug, not just the missing server
  repo), it is **not a shippable *release* build** (no signing), it has a handful of **correctness
  gaps** (SYNC can wipe alarms, SNOOZED never emitted, etc.), **Crashlytics** is commented out, and
  there are **no instrumentation tests** and large unit-test gaps.
- The **Otto server is a separate, unbuilt repo.** This plan makes the companion *correct and
  ready to connect*; it cannot make server round-trips real until that server exists (Part B §8).

---

# PART A — Action plan for a new Claude agent

## A0. Environment, build & verification (do this before and after every change)

- **JDK:** AGP 9.x needs JDK 17+. This machine's PATH `java` is 8, but Android Studio's **JBR 21**
  works: `JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"` (git-bash path form).
- **Android SDK:** platform 36 at `C:/Users/youruser/AppData/Local/Android/Sdk` (see `local.properties`).
- **`app/google-services.json` is present and real** (project `your-firebase-project`, package `com.otto.app`),
  gitignored. Do not commit it. The `google-services` plugin fails the build if it's missing — intended.
- **Gradle** 9.6.1 wrapper is cached; deps are in the warm `~/.gradle/caches`. **Crashlytics (A12)
  needs network** to `dl.google.com` for its artifact + plugin the first time.

Build & test:
```bash
export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
sh ./gradlew :app:assembleDebug :app:testDebugUnitTest --console=plain --stacktrace
# Force a REAL (non-cached) test run when you need to trust the result:
sh ./gradlew :app:cleanTestDebugUnitTest :app:testDebugUnitTest --no-build-cache --rerun-tasks --console=plain
```

## A-Guardrails

- **Never regress** the green build or the 25 passing tests. Run A0 after each change.
- **Follow existing conventions** (see `CLAUDE.md`): Kotlin + Hilt, Room-as-source-of-truth,
  inject `Clock`, hand-written fakes over mocking libs, **commit per logical change** with a clear
  message ending in the repo's `Co-Authored-By` trailer. Work on a branch, not `main`, unless told.
- **Prefer extracting pure functions** out of Android glue and unit-testing them (that's how the
  codebase already tests timing/parsing) over adding heavy instrumentation where a pure test suffices.
- **Stop and surface** anything in "Decisions that need the owner" (end of Part A) rather than guessing.
- Some items depend on the owner (server URL, keystore, Crashlytics-in-console, pairing secret).
  Where blocked, **scaffold the code to read the owner-provided input** and mark it clearly.

## A1 — Phase 0: make the app reachable (unblocks the entire server half) — **P0**

- [ ] **Dynamic Retrofit base URL.** Today `di/NetworkModule.kt:~44` hardwires
  `.baseUrl(BuildConfig.SERVER_BASE_URL)` and the stored `OttoPreferences.serverUrlOverride` is only
  read for *display* (`OttoViewModel`, `SettingsViewModel`) — never by `net/`/`di/`. So the debug URL
  override does nothing and no build can point at a real server.
  - Approach: add a `@Singleton ServerUrlProvider` seeded from `serverUrlOverride` (fallback
    `BuildConfig.SERVER_BASE_URL`), kept fresh by collecting the prefs `Flow`. Add an OkHttp
    `Interceptor` that rewrites the outgoing request's scheme/host/port to the current base when the
    request targets the placeholder host. Keep Retrofit's static `baseUrl` as the seed.
  - Also let **release** compile a real URL from a Gradle property: read `otto.serverBaseUrl` from
    `local.properties`/`-P` into the `SERVER_BASE_URL` buildConfigField (default stays
    `https://otto.invalid/`). Decide whether release keeps `ALLOW_URL_OVERRIDE=false` or allows it.
  - Acceptance: a unit test on the interceptor/URL resolution (placeholder → override host); setting
    an override in Settings changes where workers POST. Workers still no-op on the placeholder host.
  - Commit: `Resolve server base URL dynamically from prefs/override`.

## A2 — Phase 1: correctness ("flawless") — **P1**

- [ ] **SYNC must fail safe (highest-risk bug).** `net/SyncWorker.kt:~51-59` arms the server's alarms
  then **cancels every local ARMED alarm not in the server set** — an empty/failed/partial response
  silently cancels *all* the user's alarms.
  - Extract the reconcile diff into a **pure function** `reconcile(local, server) -> {toArm, toCancel}`.
    Guard: if the fetch failed, deserialized to empty on error, or returned no body, perform **zero
    cancellations** (arm-only or no-op) and `Result.retry()` rather than treating "empty" as "cancel all".
  - Tests: server adds/removes/keeps; empty list → `toCancel` empty; overlapping ids; fetch failure → retry.
  - Commit: `Make SYNC reconciliation fail-safe on empty/errored responses`.
- [ ] **Emit real SNOOZED.** `data/AlarmRepository.snooze():~79` goes ringing→`ARMED` directly, so the
  `SNOOZED` enum value (`AlarmState.kt:13`) and the §7.4 SNOOZED report event are dead and the server
  can't tell snooze from a fresh arm. Transition **ringing → SNOOZED** (so `ReportWorker` emits it),
  bump `snoozeCount`, then re-ARM at `now + snoozeIntervalMinutes` (fixed interval per the §14 decision).
  Update `AlarmController.snooze():~48-57`. Add a test asserting a SNOOZED event precedes the re-ARM.
  - Commit: `Report SNOOZED as its own state/event on snooze`.
- [ ] **Heartbeat on app open.** `ui/MainActivity.onCreate:~41-43` enqueues Registration+Sync but not
  Heartbeat (§7.4 requires "on PING and on app open"). Add `HeartbeatWorker.enqueue(this)`. Trivial.
  - Commit: `Send heartbeat on app open (spec §7.4)`.
- [ ] **Collision-proof request codes.** `alarm/AlarmRequestCodes.kt:14-15` uses `alarmId.hashCode()`
  for both the PendingIntent request code and the notification id; two ids colliding under 32-bit hash
  clobber each other's OS alarm/notification. Replace with a **stable per-id integer persisted in Room**
  (new `requestCode` column assigned from a counter, or a small mapping table). Update
  `AlarmSchedulerImpl` arm+cancel to use it (cancel must rebuild the identical PendingIntent). Requires
  a Room migration (see A17). Test: distinct ids never collide; stable across re-arm.
  - Commit: `Persist stable per-alarm request codes to remove hash collisions`.
- [ ] **Reclassify stuck-RANG alarms.** `AlarmController.reArmAll():~76-93` only inspects `getAllArmed()`.
  A process killed mid-ring leaves the alarm `RANG` forever (`AlarmReceiver.kt:~57`). In `reArmAll`, also
  scan `RANG` alarms whose trigger is well past a threshold and mark them `MISSED`. Add a test.
  - Commit: `Reconcile alarms stuck in RANG after a mid-ring kill`.
- [ ] **HMAC fail-closed once paired (security).** `push/OttoFcmService.kt:~43-49` executes commands
  **unverified** when `secretStore.getSecret()==null`. Add a persisted `hasEverPaired` flag: before first
  pairing accept unsigned (bootstrap); once a secret has ever been set, **reject** unsigned/failed-sig
  commands. **Confirm this policy with the owner** (see decisions). Test the gate both ways.
  - Commit: `Fail closed on unsigned FCM commands once the device has paired`.

## A3 — Phase 2: release-build readiness — **P1**

- [ ] **Release signing config.** No `signingConfig` exists (`build.gradle.kts:~38-46`); an unsigned
  release APK won't install. Add `signingConfigs { create("release") { ... } }` reading a **gitignored
  `keystore.properties`** (`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) with a graceful
  fallback when the file is absent (so debug/CI still build). Assign it to the release build type. Add
  `keystore.properties` to `.gitignore` (`*.jks/*.keystore` are already ignored). Owner provides the
  keystore (Part B §3).
  - Commit: `Add release signing config from keystore.properties`.
- [ ] **Log/minify strategy for release.** `OttoLog.kt:~22-32` gates only `d()` on `BuildConfig.DEBUG`;
  `i()/w()/e()` emit in release, and `isMinifyEnabled=false`. Choose: **(a)** gate `i/w/e` on `DEBUG`
  (simplest, low risk), and/or **(b)** enable R8 (`isMinifyEnabled=true` + `isShrinkResources=true`) and
  validate the keep rules in `proguard-rules.pro` for Hilt/Room/kotlinx-serialization/Retrofit/Firebase,
  plus a rule stripping `Log`. Recommended: (a) now; (b) only if you can fully verify a minified build.
  - Commit: `Strip non-debug logging from release builds`.
- [ ] **HTTPS / no cleartext.** No `usesCleartextTraffic`/network-security-config anywhere, and the
  Settings URL override (`SettingsScreen.kt:~91-103`) accepts any scheme. Set
  `android:usesCleartextTraffic="false"` (or a network security config) in the manifest and validate the
  override is `https://`. Commit: `Enforce HTTPS-only traffic`.
- [ ] **Bump `versionName`.** `build.gradle.kts:~22` still says `0.1.0-m1` at M5. Set a real version
  (e.g. `1.0.0`, `versionCode` 1→N). Commit: `Bump version to 1.0.0`.

## A4 — Phase 3: observability — **P2**

- [ ] **Wire Crashlytics** (explicit M5 deliverable, currently commented out at `build.gradle.kts:~81-84`;
  `OttoLog.kt:~9-11` has placeholder hooks). Add the Crashlytics Gradle plugin to the version catalog +
  root + app `plugins {}`, uncomment the `firebase-crashlytics` dependency (catalog entry already exists),
  apply, and forward `OttoLog.w/e` as non-fatals + breadcrumbs. **Needs network** to `dl.google.com` and
  Crashlytics enabled in the Firebase console (Part B §1). Verify a clean build.
  - Commit: `Wire Firebase Crashlytics for crash + non-fatal reporting`.

## A5 — Phase 4: tests & schema debt — **P2**

- [ ] **Fakeable AlarmManager seam + `AlarmSchedulerImpl` test.** Extract a thin `AlarmGateway`
  interface (or inject `AlarmManager`) so `setAlarmClock`/`cancel` are fakeable; test replace-vs-duplicate
  on the same `alarmId` and cancel PendingIntent equality. (`AlarmSchedulerImpl.kt:~29/53/69`.)
- [ ] **`AlarmControllerTest`** (fake scheduler/repository/clock — all already interfaces): past-grace→MISSED
  & not scheduled; future→scheduled+ARMED; cancel skips terminal states; `reArmAll` re-arms only future;
  snooze of missing id → false; snooze emits SNOOZED.
- [ ] **Worker tests** (add `androidx.work:work-testing` + a fake `OttoApi`): Registration/Report/Sync/
  Heartbeat — `Result.retry` on transient failure, success on 2xx, `ReportWorker` marks reported only on
  CAS success, `SyncWorker` uses the A2 fail-safe reconcile.
- [ ] **State-machine tests:** `AlarmState.isTerminal` for every value; terminal states not overwritten;
  MISSED never re-armed.
- [ ] **`androidTest` source set** (none exists today): add `androidx.test`, `room-testing`,
  `work-testing`, and (for the ring UI) `espresso`/`uiautomator`. Write the three §15 instrumentation
  suites: Room DAO round-trips **+ migrations**, `BootReceiver` re-arm, `RingActivity` over the lockscreen.
- [ ] **Schema/migrations:** set `@Database(exportSchema = true)` + a schema dir (`ksp { arg("room.schemaLocation", ...) }`),
  commit the exported JSON, and add a `MigrationTestHelper` test (also covers the A5 request-code column migration).
- [ ] **FCM HMAC-gate integration test:** unsigned accepted before pairing vs dropped after (ties to A2).

Commit tests in logical groups (e.g. `Add AlarmController + worker unit tests`, `Add Room/boot/ring instrumentation tests`).

## A6 — Definition of Done (agent)

- `:app:assembleDebug` **and** `:app:assembleRelease` are green; release APK is **signed**.
- All unit tests + new instrumentation tests pass (`connectedDebugAndroidTest` on a device/emulator).
- SYNC cannot cancel alarms on an empty/errored response; SNOOZED is emitted; heartbeat fires on open;
  request codes can't collide; stuck-RANG is reconciled; HMAC fails closed once paired.
- Server base URL is configurable (debug override works; release reads a real URL); Crashlytics reports.
- HTTPS enforced; non-debug logging stripped; `versionName` bumped.
- `CLAUDE.md` updated to reflect the new state; every change committed with clear messages.
- Anything still requiring the owner is listed explicitly in the final handoff message.

## A7 — Decisions that need the owner (surface, don't guess)

1. **Real server base URL** (and whether release allows the in-app override). *Blocks A1 end-to-end verification.*
2. **HMAC policy:** confirm "fail closed once paired". *A2.*
3. **Minify:** enable R8 for release, or keep unminified sideload + just gate logs. *A3.*
4. **Release keystore** details (owner generates; agent only reads `keystore.properties`). *A3 / Part B §3.*
5. **True M5 pairing handshake** (QR/deep-link/server exchange) — larger design, depends on the server;
   keep the manual-secret-paste path until then.

---

# PART B — Action plan for the owner (you)

These are the steps only you can do. Do them roughly in order; ⚑ marks things that block the agent.

### 1. Firebase (mostly done)
- `app/google-services.json` for project **your-firebase-project / com.otto.app** is already in place. ✔
- In the **Firebase console**: enable **Crashlytics** for the app (needed for Part A A4). ⚑ (for A4)
- Make sure the **Otto server** has a **service-account JSON** with the *Firebase Cloud Messaging API*
  enabled so it can send FCM **HTTP v1** pushes (`.../messages:send`). The legacy server key is dead.

### 2. Provide the real server URL ⚑ (blocks A1 verification)
- Once the Otto server is deployed, give the agent the base URL (e.g. `https://otto.example.com/`).
- For release builds, add it to **`local.properties`** (gitignored):
  `otto.serverBaseUrl=https://otto.example.com/`
- For debug, you can also just type it into the app's **Settings → server URL** field.

### 3. Create a release keystore ⚑ (blocks A3 signing)
```bash
keytool -genkeypair -v -keystore otto-release.jks -alias otto \
  -keyalg RSA -keysize 4096 -validity 10000
```
- Create **`keystore.properties`** in the repo root (gitignored — the agent adds it to `.gitignore`):
  ```
  storeFile=otto-release.jks
  storePassword=********
  keyAlias=otto
  keyPassword=********
  ```
- **Back up the keystore and passwords somewhere safe.** If you lose them you can never ship an update
  with the same app identity to your phone (you'd have to uninstall/reinstall and lose data).

### 4. Build & install on your phone
- Easiest: open the project in **Android Studio** (it uses its bundled JDK 21) and **Run** onto a
  connected phone. For a signed release APK: **Build → Generate Signed App Bundle / APK → APK → release**.
- CLI alternative (needs JDK 17+):
  ```bash
  export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
  ./gradlew :app:assembleRelease
  adb install -r app/build/outputs/apk/release/app-release.apk
  ```
- On the phone, allow **"Install unknown apps"** for your file manager/Android Studio if prompted.

### 5. Grant permissions on-device (the app shows each with a button — tap them all)
- **Notifications** (POST_NOTIFICATIONS) — required or nothing shows.
- **Alarms & reminders / exact alarms** — auto-granted for an alarm app; the panel will confirm.
- **Full-screen intent** — if the panel shows it as off, use its button to the settings toggle.
- **Battery optimization: exempt Otto.** ⚑ Critical for Doze delivery.
- ⚑ **Do NOT "Force stop" Otto, and exclude it from aggressive OEM battery managers** (Xiaomi/Samsung/
  Huawei "app sleep"/"deep sleep"). A force-stop kills both FCM delivery and pending alarms until you
  reopen the app — this is an Android limitation, not a bug.

### 6. Pair the device (until the real handshake exists)
- When the server gives you the **HMAC shared secret**, open **Settings → Pair** and paste it.
- Verify the status flips to **paired** (after Part A A2, unsigned commands are then rejected).

### 7. Run the acceptance matrix (`docs/manual-testing.md`)
- "Arm test alarm (+60s)" → lock the phone, screen off → it rings full-screen. ✔ core M1
- Send a test FCM data push → an alarm arms and rings.
- Arm a future alarm, **reboot**, confirm it still fires.
- Doze: `adb shell dumpsys deviceidle force-idle`, then push, confirm it rings.
- Change the device time forward past an alarm; confirm correct handling.
- Force-stop in Settings, reopen, confirm the reliability warning.
- Clear the FCM token; confirm re-registration.

### 8. Stand up / point at the Otto server (separate repo — the other half of "operational")
This companion is a leaf: it only *executes* server instructions. For true end-to-end operation the
server must:
- send **high-priority, data-only** FCM v1 messages matching the contract in `spec.md` §7 (no
  `notification` block; `android.priority:"high"`; string values);
- **HMAC-sign** each payload with the shared secret using the canonical form (`spec.md` §7.3 / `CLAUDE.md`);
- implement the **register / report / sync / heartbeat** endpoints (`OttoApi` / `spec.md` §7.4);
- for **SYNC**, return the authoritative alarm list (after Part A A2 the app treats an empty/errored
  response as "change nothing", so transient server errors won't wipe your alarms).

---

## Handoffs (who unblocks whom)

| Item | Owner provides | Agent does |
|---|---|---|
| Server URL | real base URL → `local.properties` / Settings (B2) | dynamic baseUrl + release plumbing (A1) |
| Release signing | keystore + `keystore.properties` (B3) | `signingConfigs.release` reading it (A3) |
| Crashlytics | enable in Firebase console (B1) | wire dep/plugin + `OttoLog` hooks (A4) |
| HMAC policy | confirm "fail closed once paired" (B/decision) | implement the gate (A2) |
| Pairing secret | paste into Settings (B6) | (later) real handshake (A7.5) |
| On-device acceptance | run the matrix (B7) | fix anything it surfaces |

**Bottom line:** the agent can complete A1–A6 to make the app correct, signed, and installable now
(using placeholders where owner input is pending). It becomes *fully operational* only once you supply
the server URL + keystore (B2–B3) and the Otto server is live (B8).
