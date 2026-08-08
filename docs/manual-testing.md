# Manual reliability testing (M1–M6)

These checks need a real device (or emulator) with the debug APK installed and USB debugging
on. `adb` lives in your Android SDK's `platform-tools`.

## ⚠️ Before installing over an existing build

Run the migration tests first. There is no `fallbackToDestructiveMigration`, so a migration that
does not reproduce Room's generated schema exactly throws at first database open — and on a phone
whose job is ringing alarms, that means the alarms stop and you find out by oversleeping.

```
./gradlew :app:connectedDebugAndroidTest --tests '*MigrationTest*'
```

That covers v1→v2, v2→v3, and the v1→v3 chain.

## Local ring (M1 / M3)
1. Open Otto, grant every permission the panel shows.
2. Tap **Arm test alarm (+60s)**, lock the screen. It should ring full-screen with a volume
   ramp + vibration, offering **Dismiss** and **Snooze**.
3. Snooze re-arms it 9 minutes out (snoozeCount increments); it rings again.

## Push ring (M2)
Use the FCM helper (`tools/send-push/README.md`):
```
node tools/send-push/send-push.mjs --token <DEVICE_TOKEN> --in 60 --label "Email"
```
If you set a pairing secret in the debug panel, append `--secret <SECRET>` — without a valid
`sig` the command is dropped.

## Reboot recovery (M1)
Arm a future alarm, reboot the phone, confirm it still fires (BootReceiver re-arms from Room).

## Doze (M4)
```
adb shell dumpsys deviceidle force-idle     # force Doze
# arm a +2min alarm (or send a push), then step Doze forward:
adb shell dumpsys deviceidle step
# the setAlarmClock alarm must still fire while Dozing
adb shell dumpsys deviceidle unforce        # restore
```

## Time / timezone change (M4)
Arm a future alarm, then change the date/time or timezone in Settings. `TimeChangeReceiver`
re-validates: future alarms stay armed, already-past ones become MISSED; a timezone change
also triggers a SYNC.

## Force-stop (M4)
Arm an alarm, then **Settings → Apps → Otto → Force stop**. Android cancels the alarm. Reopen
Otto: the on-open re-arm restores armed alarms (and the Reliability card explains the risk).

## Foreground-service ring survival (M4)
While an alarm is ringing, swipe Otto's ring screen off the recents list. The `RingService`
keeps the sound going (its foreground notification persists); tap the notification to reopen
and dismiss.

## Nudges (M6)

Everything below is a **notification**, never an alarm: no full-screen takeover, no looping
audio, always swipe-dismissible. If any of it rings, that is a bug in the channel mapping.

### The three levels
The quickest check needs no server at all — tap **Send test nudge** in the panel three times;
it cycles the levels. Or push one directly:
```
node tools/send-push/send-push.mjs --token <DEVICE_TOKEN> --type NUDGE \
  --nudge-id rem_test1 --title "Email Teal" --body "Still open" --level URGENT --secret <SECRET>
```
- `SILENT` — appears in the shade, no sound, no peek.
- `NORMAL` — sound, lands in the shade, does **not** take over the screen.
- `URGENT` — heads-up over whatever is on screen, with sound and vibration.

### Acting from the lock screen — the one that matters most
Lock the phone, send an `URGENT` nudge, and tap **Done** *without unlocking*. The notification
should clear immediately, and `adb logcat -s Otto` should show the event queued. The server
receives `NUDGE/DONE` and completes the reminder.

This is the whole point of using a broadcast receiver rather than an Activity. If it prompts you
to unlock, the plumbing has regressed.

### Replace in place
Send the same `--nudge-id` twice with a different `--body`. You must end up with **one**
notification carrying the newer text — not two. A chase ladder that stacks is unusable, so this
is the property the whole design hangs on.

### Withdrawal
```
node tools/send-push/send-push.mjs --token <T> --type CANCEL_NUDGE --nudge-id rem_test1 --secret <S>
```
Also happens automatically when you complete the reminder over WhatsApp — the point is that a
lock screen never keeps asking about something you have already dealt with.

### Snooze, offline
Turn on airplane mode, snooze a nudge, wait `snoozeMinutes`. It must re-appear with no network
at all. Turn airplane mode off and the `SNOOZED` event flushes to the server.

*(In deep Doze the re-show may run up to ~15 minutes late. That is expected — nudges use
`setAndAllowWhileIdle` deliberately, and must not be "fixed" with exact alarms.)*

### Reboot with one active and one snoozed nudge
```
adb reboot
```
The active one is re-posted, the snoozed one is re-scheduled, and the summary is rebuilt. Check
the alarms came back too — alarm recovery runs first and in its own try/catch precisely so a
nudge problem can never take it down.

### Do Not Disturb
Turn DND on and send an `URGENT` nudge. By default it is held. Then allow it via
**Settings → Notifications → Do Not Disturb → Apps/Priority → Reminders** and send again.
Otto never asks for notification-policy access, so `CATEGORY_REMINDER` plus that toggle is the
only path — and alarms get through regardless.

### Push rejection reporting
```
# Ten unknown pushes with a VALID secret -> the server sees exactly ONE PUSH/REJECTED that hour
for i in $(seq 1 10); do
  node tools/send-push/send-push.mjs --token <T> --type LAUNCH_ROCKET --force-unknown --secret <S>
done

# The same thing with a WRONG secret -> the server sees NOTHING at all
node tools/send-push/send-push.mjs --token <T> --type LAUNCH_ROCKET --force-unknown --secret wrong
```
The second case is a security check, not a tidiness one: reporting is downstream of the HMAC
gate so a forged push can never make this device emit an authenticated request.

### The summary and the tile
With nudges open, the shade shows a silent, ongoing "N things open" line and the quick-settings
tile reads `Otto · N open`. Resolve them all and both should disappear.

## Alarm regression pass — MANDATORY after any nudge change

The nudge tier shares a process, a database and a boot receiver with the alarm path. Re-run
**every** check above it before shipping: local ring, push ring, reboot recovery, Doze, time and
timezone change, force-stop, and foreground-service ring survival.

## Inspecting state
```
adb logcat -s Otto            # app logs (tag "Otto")
adb shell dumpsys alarm | grep otto     # scheduled alarms
```
