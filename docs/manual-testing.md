# Manual reliability testing (M1–M4)

These checks need a real device (or emulator) with the debug APK installed and USB debugging
on. `adb` lives in your Android SDK's `platform-tools`.

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

## Inspecting state
```
adb logcat -s Otto            # app logs (tag "Otto")
adb shell dumpsys alarm | grep otto     # scheduled alarms
```
