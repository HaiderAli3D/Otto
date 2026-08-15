# Building the Otto app

The phone half. This gets you from a fresh clone to an Otto app installed on your Android
phone, wired to your own Firebase project, pointed at your server, and paired.

> **Why you have to build it yourself.** There is no downloadable APK and there cannot be one.
> Firebase Cloud Messaging binds to a specific Firebase project at *build* time, via a
> `google-services.json` that only you can generate — and that binding is exactly what connects
> *your* server to *your* phone. A prebuilt APK would be bound to somebody else's project and
> would never receive a single one of your alarms.
>
> The upside: it's a normal Android build. If you've ever opened a project in Android Studio and
> pressed Run, you already know how to do this.

**Time:** 30–60 minutes if Android Studio is already installed, 1–2 hours if not.

---

## 1. What you need

| | |
|---|---|
| **An Android phone** | Android 8.0 (API 26) or newer. This is the phone Otto will ring. |
| **Android Studio** | Any recent version. [Download](https://developer.android.com/studio). |
| **JDK 17 or newer** | Required by Android Gradle Plugin 9.x. Android Studio's bundled JBR (21) works — you only need to think about this if you build from the command line. |
| **Android SDK Platform 36** | Install via Android Studio → **SDK Manager** → *SDK Platforms* → **Android 16 (API 36)**. |
| **A Firebase project** | Free. Created in the next step. |

Gradle itself is handled by the committed wrapper — you don't need to install it.

---

## 2. Create your Firebase project and register the app

This is the same Firebase project the server uses. If you've already done §2 of
[server/SETUP.md](../server/SETUP.md), reuse that project — do **not** make a second one.

1. Open the [Firebase console](https://console.firebase.google.com/) → **Add project**. Name it
   anything. Google Analytics is not needed.
2. Inside the project, click the **Android** icon to add an Android app.
3. **Android package name** must be exactly:

   ```
   com.otto.app
   ```

   This is not cosmetic — it must match `applicationId` in
   [`android/app/build.gradle.kts`](../android/app/build.gradle.kts), or Firebase will refuse to
   deliver to the app. Nickname and debug signing certificate can both be left blank.
4. Download **`google-services.json`** and put it here:

   ```
   android/app/google-services.json
   ```

   It's gitignored, so you won't commit it by accident.

> **The build fails loudly without this file, on purpose.** A missing `google-services.json`
> aborts the Google Services Gradle plugin with a clear error. That's better than building an app
> that silently can never receive a push.

---

## 3. Build it

### With Android Studio (easiest)

Open the **`android/`** directory as the project — not the repository root. Wait for the Gradle
sync, plug in your phone with USB debugging on, and press **Run**.

### From the command line

```bash
cd android
./gradlew :app:assembleDebug
```

If Gradle complains about the Java version, point it at a JDK 17+:

```bash
JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew :app:assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`. Install it with
`adb install -r <that path>`, or copy it to the phone and tap it.

> ⚠️ **Installing over an existing Otto build?** Run `./gradlew :app:connectedAndroidTest` first.
> There is deliberately no `fallbackToDestructiveMigration`, so a bad database migration throws on
> first open — which on this app means your alarms stop working. The migration tests catch that
> before your phone does.

---

## 4. Grant the permissions

Open the app. The main screen is a control panel: every permission Otto needs has a visible
state and a one-tap button to grant it. Work down the list until nothing says *Missing*.

| Permission | Why | Notes |
|---|---|---|
| **Notifications** | Every alarm and nudge is a notification | Android 13+ runtime prompt |
| **Exact alarms** | `setAlarmClock()` needs it — it is *not* exempt | Usually auto-granted, since Otto is a genuine alarm app |
| **Full-screen intent** | Lets a ringing alarm take the lockscreen | Granted at install for sideloaded apps; the app deep-links to Settings if not |
| **Battery optimisation exemption** | Materially improves push delivery in Doze | Prompted once. **Grant this one.** |
| **Location** *(optional)* | Only for leave-by journey timing | Two steps — see below |

### The location grant is two steps, and that's deliberate

If you want leave-by alarms priced from where you actually are:

1. Grant **foreground** location first (the app asks for coarse and fine together — Android
   ignores a fine-only request from API 31).
2. Then grant **"Allow all the time"** separately, via the Settings deep link the app opens.

They cannot be combined. Asking for a foreground permission and background location in one call
makes Android grant *neither*, and from Android 11 "Allow all the time" has no dialog at all.

Otto asks your phone for a location **once, when it needs it** — never continuously — and posts a
visible notification every single time saying it happened and what for.

### One Android limitation you should know about

**Force-stopping the app breaks alarms**, and no code can fix that. Android cancels every pending
alarm and stops push delivery until the app is next opened. That includes swiping it away on some
OEM launchers and aggressive battery managers on Samsung, Xiaomi and similar. Otto detects the
state on next open, warns you, and re-arms from its database — but the window between is real.

---

## 5. Point it at your server and pair

By this stage you need the server running with a public HTTPS origin — see
[server/SETUP.md](../server/SETUP.md) §4.

1. In the app: **Settings** → set the **server URL** to your `PUBLIC_ORIGIN`.

   Debug builds allow this because they're compiled with the placeholder
   `https://otto.invalid/` and `ALLOW_URL_OVERRIDE = true`. Release builds compile the real URL in
   and disable the override (see §7). HTTPS only — cleartext is off.
2. Open the app once. It registers its FCM token and timezone with the server, which creates the
   device row.
3. On the server, fetch the pairing secret:

   ```bash
   curl -H "x-admin-token: $ADMIN_TOKEN" https://<your-origin>/admin/devices
   ```

4. Copy the `hmacSecret` and paste it into the app's **Settings → Pair**.

After pairing, both directions are **fail-closed**: the app permanently drops any push that isn't
correctly signed, and the server rejects unsigned calls from that device. If you clear the app's
data you'll need to re-paste the secret; a full reinstall mints a fresh `deviceId`, which starts
unpaired again.

### Prove it works

```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" \
     -H "content-type: application/json" \
     -d '{"inSeconds": 30, "label": "Hello from Otto"}' \
     https://<your-origin>/admin/test-alarm
```

Lock the phone, put it in your pocket, and wait 30 seconds. If it rings, everything downstream
of this guide is done.

There's also an **Arm test alarm (+60s)** button in the app that exercises the local ring path
with no server and no push at all — useful for isolating which half is broken.

---

## 6. Sending pushes by hand (optional)

[`android/tools/send-push/`](../android/tools/send-push/) is a small Node helper that sends a
signed FCM data message straight to your device, bypassing the server entirely. Handy for testing
a command type in isolation. It needs a Firebase service-account JSON and the device's FCM token,
which the app displays and lets you copy.

---

## 7. Release builds (optional)

Debug builds are perfectly usable day to day. If you want a release APK:

1. **Server URL** — add to `android/local.properties`:

   ```properties
   otto.serverBaseUrl=https://<your-origin>/
   ```

   Release builds compile this in and disable the in-app override.

2. **Signing** — copy `android/keystore.properties.example` to `android/keystore.properties` and
   fill it in. Without it the release build falls back to the debug key, which still produces an
   installable APK — fine for a phone that's only ever yours.

```bash
cd android && ./gradlew :app:assembleRelease
```

---

## Troubleshooting

**The build fails with a Google Services error.** `android/app/google-services.json` is missing or
its package name isn't `com.otto.app`. Re-download it from the Firebase console.

**The app crashes instantly on launch.** Make sure you haven't removed the Crashlytics Gradle
plugin from `android/app/build.gradle.kts`. It injects a build-ID resource that Crashlytics
hard-asserts on during startup; without it the process dies before any Otto code runs, with
`IllegalStateException: The Crashlytics build ID is missing`. This is documented at length in
[`android/CLAUDE.md`](../android/CLAUDE.md) because it shipped once.

**Alarms don't arrive from the server, but the local test alarm works.** The push path is broken,
not the alarm path. Check that the server's `FIREBASE_SERVICE_ACCOUNT` is from the *same* Firebase
project as your `google-services.json`, and that the device is paired.

**Everything worked, then stopped.** Check whether the app was force-stopped — Settings → Apps →
Otto. Re-open the app to re-arm.

**The alarm rings quietly.** Otto raises the device alarm stream to maximum while ringing and
restores it after. If it's still quiet, check the phone's alarm volume and whether an OEM
"adaptive sound" feature is intervening.

---

## Where to go next

- [server/SETUP.md](../server/SETUP.md) — the server, WhatsApp, Calendar and Maps
- [docs/manual-testing.md](manual-testing.md) — the device tests that can't be automated
- [android/spec.md](../android/spec.md) — the full technical specification
