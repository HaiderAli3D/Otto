# Otto FCM test-push helper

Sends a high-priority **data-only** message to your device through the FCM HTTP v1 API —
the same shape the Otto server will send. This is how you exercise the push → arm → ring
path before the server exists (spec §15).

## One-time setup

1. Get a service-account key: **Firebase Console → Project Settings → Service accounts →
   Generate new private key**. Save it here as `service-account.json` (gitignored).
   Alternatively set `GOOGLE_APPLICATION_CREDENTIALS` to its path, or pass `--key <path>`.
2. Install the one dependency:
   ```
   cd tools/send-push
   npm install
   ```

## Usage

Copy the **FCM token** from the Otto app's control panel, then:

```bash
# Arm an alarm 60s from now
node send-push.mjs --token <DEVICE_FCM_TOKEN> --in 60 --label "Email Teal"

# Arm at an absolute time (epoch millis)
node send-push.mjs --token <T> --at 1751200000000 --label "Standup"

# Cancel an alarm
node send-push.mjs --token <T> --type CANCEL_ALARM --alarm-id alm_test_123

# See exactly what would be sent, without sending
node send-push.mjs --token <T> --in 90 --dry-run

# Include the M2 integrity signature
node send-push.mjs --token <T> --in 60 --secret <SHARED_SECRET>
```

Run `node send-push.mjs --help` for all options.

## The message it sends

Data-only (no `notification` block, so `onMessageReceived` always runs) and high priority
(wakes a Dozing device):

```json
{ "message": {
    "token": "<device token>",
    "android": { "priority": "high" },
    "data": { "v": "1", "type": "ARM_ALARM", "alarmId": "alm_test_…",
              "triggerAtMillis": "1751200000000", "label": "Email Teal",
              "allowWhileIdle": "true" } } }
```

## HMAC signature (M2)

With `--secret`, the tool adds a `sig` field. The canonical form (which the Android client
verifies against) is:

> all `data` fields **except** `sig`, sorted by key, joined as `key=value` with `&`, then
> `HMAC-SHA256(secret, canonical)` rendered as lowercase hex.
