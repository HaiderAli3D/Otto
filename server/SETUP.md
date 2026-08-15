# Otto server — setup & deployment (turnkey)

A do-this-then-that guide to go from an empty machine to **"message Otto on WhatsApp and my
phone rings a real alarm"**. Written for a solo owner, not a team.

You can stop after **§6** and already have a working alarm pipe you drive with `curl`. WhatsApp
(§7–8) and Google Calendar (§9) are add-ons layered on top.

**The only hard requirement is Firebase (§2).** Everything else is optional and feature-gated —
the server prints which features are on at boot (`Otto server up { features: {...} }`).

Commands below use `bash`/`curl` (macOS/Linux, Git Bash, or WSL on Windows). Replace
`<PLACEHOLDERS>` with your values.

---

## 1. Prerequisites

- **Node.js 20 or newer** — check with `node --version`.
- **The Otto Android app installed on your phone, with permissions granted.** The app is a
  separate repo; its debug build installs from Android Studio (open the app project → Run). On
  first launch grant: notifications, exact alarm, full-screen intent, and — importantly — the
  **battery-optimization exemption** (needed for reliable ringing in Doze).
- A phone and computer that can reach the internet. For WhatsApp you'll also need a Meta
  (Facebook) account and a phone number for the business number (§7).

Get the code and dependencies (clone from wherever this repo lives for you — a Git host fork or
a local path):

```bash
git clone <url-or-path-of-this-repo> otto-server && cd otto-server
npm install
cp .env.example .env      # you'll fill this in as you go
```

---

## 2. Firebase Cloud Messaging (REQUIRED)

This is the pipe that pushes alarms to the phone. It must be the **same Firebase project as the
Android app's `google-services.json`** — project **`your-firebase-project`**, package **`com.otto.app`**.
If the server used a different project, its pushes would never reach the app.

1. Open the [Firebase console](https://console.firebase.google.com/) → select the **your-firebase-project**
   project.
2. Gear icon → **Project settings** → **Service accounts** tab.
3. Click **Generate new private key** → **Generate key**. A JSON file downloads.
4. Save it into the repo as `service-account.json` (it's already gitignored — never commit it).
5. In `.env`, point `FIREBASE_SERVICE_ACCOUNT` at it (a path), **or** paste the whole JSON inline:

   ```dotenv
   FIREBASE_SERVICE_ACCOUNT=./service-account.json
   ```

Docs: [Add the Firebase Admin SDK to your server](https://firebase.google.com/docs/admin/setup)
(→ "Initialize the SDK" → generating a private key).

> This single credential is enough to prove the whole pipe end-to-end (§5) **without** any
> WhatsApp or AI setup.

---

## 3. OpenAI (the agent) — optional but needed for the "AI" part

Only required once you want to talk to Otto in natural language (§8). The REST endpoints and FCM
pushes work without it.

1. Go to the [OpenAI platform](https://platform.openai.com/api-keys) → **API keys** → create a key.
2. In `.env`:

   ```dotenv
   OPENAI_API_KEY=sk-...
   # OPENAI_MODEL defaults to gpt-5.6-luna — leave unless you want another model.
   ```

> **Not the same key as `STT_API_KEY`.** That one (§ voice notes) points at an OpenAI-*compatible*
> Groq endpoint and takes a Groq key. Swapping the two fails as a quiet 401 on a path that degrades
> to templates without an alert.

`gpt-5.6-luna` is the cost tier — roughly $0.20 per million input tokens against Claude Sonnet 5's
$3. If Otto starts picking the wrong tool, set `OPENAI_MODEL=gpt-5.6-terra` and redeploy; no code
change is needed.

---

## 4. Deploy / get a public HTTPS origin

FCM works from anywhere, but WhatsApp's webhook and Google OAuth need a **public HTTPS URL**.
Pick one option and set `PUBLIC_ORIGIN` to the resulting `https://...` URL.

### Option A — Fly.io (recommended; always-on, persistent disk)

The scheduler runs in-process, so the machine must stay up. `fly.toml` in this repo already sets
`min_machines_running = 1` and disables scale-to-zero.

```bash
# Install flyctl (https://fly.io/docs/flyctl/install/) and `fly auth login` first.
fly launch --no-deploy                       # creates the app; accept or rename in fly.toml
fly volumes create otto_data --size 1        # persistent disk for the SQLite file at /data
fly secrets set \
  FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" \
  OPENAI_API_KEY=sk-... \
  ADMIN_TOKEN=$(openssl rand -hex 24) \
  PUBLIC_ORIGIN=https://<your-app>.fly.dev
fly deploy
```

`FIREBASE_SERVICE_ACCOUNT` is passed **inline** here (multiline JSON survives `$(cat ...)`).
Your origin is `https://<your-app>.fly.dev`. Add the `META_*` / `GOOGLE_*` secrets later the same
way (`fly secrets set NAME=value`) — each set triggers a rolling restart.

### Option B — small VPS with Caddy for TLS

On any small always-on VPS with a domain pointed at it:

```bash
# Run the server (via `npm run build && npm start`, a systemd unit, or `docker build . && docker run`).
# Docker: bind a host dir to /data so the DB persists, and pass env via --env-file .env:
docker build -t otto-server .
docker run -d --name otto -p 3000:3000 --env-file .env -v /srv/otto-data:/data otto-server
```

Put [Caddy](https://caddyserver.com/) in front for automatic HTTPS — a two-line `Caddyfile`:

```
otto.example.com {
    reverse_proxy localhost:3000
}
```

Set `PUBLIC_ORIGIN=https://otto.example.com`.

### Option C — local dev with a temporary public URL

Great for a first test. Run the server locally and expose it with a Cloudflare tunnel:

```bash
npm run dev                                  # server on http://localhost:3000
cloudflared tunnel --url http://localhost:3000
```

`cloudflared` prints a `https://<random>.trycloudflare.com` URL — set `PUBLIC_ORIGIN` to it and
**restart** `npm run dev` (the URL changes each run, so this is for testing, not production).

> Because the tunnel URL is not localhost, the server now **requires `ADMIN_TOKEN` to be set**
> and refuses to boot without it (see §11 Hardening). Generate one: `openssl rand -hex 24`.

---

## 5. Point the phone at the server & prove the pipe (before WhatsApp)

This confirms Firebase + endpoints work end-to-end **without** WhatsApp or AI.

1. In the Otto app: **Settings → server URL** and enter your `PUBLIC_ORIGIN`. Debug builds allow
   this override.
2. **Open the app once.** It registers its FCM token with the server (`POST /devices/:id/token`),
   which creates the device row. Without this there is no device to push to. The app also
   reports the phone's **timezone** here (and on every heartbeat) — alarm times like "6pm" are
   interpreted in that zone. `DEFAULT_TIMEZONE` in `.env` only covers the gap before the app's
   first contact; verify the real zone landed with `GET /admin/devices` (the `timezone` field).
3. Fire a test alarm (replace `<ADMIN_TOKEN>` and `$PUBLIC_ORIGIN`):

   ```bash
   curl -X POST "$PUBLIC_ORIGIN/admin/test-alarm" \
     -H "x-admin-token: <ADMIN_TOKEN>" \
     -H "content-type: application/json" \
     -d '{"inSeconds":60}'
   ```

   With no `deviceId` in the body it targets your (only) device. In ~60 seconds **the phone
   should ring full-screen**. That proves Firebase + the endpoints work end-to-end.

If `admin/test-alarm` returns `no device registered yet — open the app first`, redo step 2. See
§11 if it doesn't ring.

---

## 6. Pair (secure the pushes)

By default the app accepts pushes; once you pair, it **rejects unsigned pushes (fail-closed)** by
verifying an HMAC signature. Do this after §5 works.

```bash
curl "$PUBLIC_ORIGIN/admin/devices" -H "x-admin-token: <ADMIN_TOKEN>"
```

Copy the `hmacSecret` from the response and paste it into the app: **Settings → Pair**. From then
on the app only rings pushes signed with that secret. (Re-run `test-alarm` from §5 to confirm it
still rings after pairing — the server signs with the same secret.)

Pairing also hardens the **other direction**: once the app holds the secret it signs every HTTP
call it makes, and the server locks that device to signed calls after the first one arrives
(`authEnforced: true` in `GET /admin/devices`). Details and recovery in §11 Hardening.

The same response shows `hasToken` (is the FCM token registered?) and the `deviceId` you'll need
for Google OAuth in §9.

---

## 7. WhatsApp Cloud API (Meta) — optional

Lets you talk to Otto over WhatsApp. Requires a Meta developer account. Set **all four** `META_*`
vars; if any is missing the webhook route stays unmounted.

**Docs:** [WhatsApp Cloud API — Get Started](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started/)
· [Create a webhook endpoint](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint/)
· [Access Tokens (System User permanent token)](https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/)

1. **Create the app + WhatsApp product.** At
   [developers.facebook.com/apps](https://developers.facebook.com/apps/) → **Create App** →
   type **Business** → add the **WhatsApp** product. This creates a test WhatsApp Business Account
   and a test phone number. From **WhatsApp → API Setup**, note the **Phone number ID**:

   ```dotenv
   META_WA_PHONE_NUMBER_ID=<phone number ID>
   ```

2. **App secret.** App **Settings → Basic → App secret** (Show). This signs inbound webhooks:

   ```dotenv
   META_APP_SECRET=<app secret>
   ```

3. **Permanent access token (System User).** The token shown on the API Setup page expires in
   ~24h — you need a permanent one. In **Business Settings → Users → System Users**, add an
   **Admin** system user, **Assign assets** → your app (Full control) and your WhatsApp Business
   Account, then **Generate token** → select the app → grant **`whatsapp_business_messaging`** and
   **`whatsapp_business_management`** → set expiry to **Never**. Copy it once (shown only once):

   ```dotenv
   META_WA_ACCESS_TOKEN=<permanent system-user token>
   ```

4. **Verify token.** Invent any secret string and set it — you'll type the same value into the
   webhook config below:

   ```dotenv
   META_VERIFY_TOKEN=<any secret you choose>
   ```

   **Also set your owner number** so only you can control the device. Anyone who messages the
   business number reaches the agent otherwise; the allowlist locks it down (if you skip this,
   the server trusts the first number that messages it and rejects the rest):

   ```dotenv
   OWNER_WA_NUMBERS=<your WhatsApp number, e.g. +447700900000>
   ```

5. **Configure the webhook.** Redeploy/restart the server so the `META_*` vars load (the
   `/whatsapp/webhook` route only mounts when all four are present). Then in the App Dashboard →
   **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL:** `${PUBLIC_ORIGIN}/whatsapp/webhook`
   - **Verify token:** the exact `META_VERIFY_TOKEN` value from step 4.
   - Meta sends a `GET` challenge to that URL; the server echoes it back and the webhook saves.
   - Then under **Webhook fields**, **subscribe to the `messages` field**. (Without this you get
     no inbound messages.)

> **24-hour customer-service window:** WhatsApp only allows free-form messages within 24h of your
> last inbound one; outside that window Meta rejects them with error 131047, and only a
> pre-approved template may be sent.
>
> This used to matter a great deal, because Otto speaks first constantly — nudges, briefs, the
> weekly review, wake-checks, warnings — and outside the window all of it simply queued until it
> expired. **It no longer does.** When the window is shut Otto delivers to your phone as a
> notification instead, carrying the real text, with Done and Snooze buttons you can use from the
> lockscreen. A push has no window, costs nothing, and can be withdrawn later.
>
> So `META_TEMPLATE_NAME` is optional and, for a single-owner setup with the app installed,
> not worth configuring: a template costs money, has a six-hour cooldown, carries one short
> variable, cannot be retracted, and is the most-blocked message type there is.
>
> What the window still governs is *which* channel each message takes — see §11.

---

## 8. Use it

Message your Otto WhatsApp number (the test number from §7, or your production number once
approved). For example:

> "remind me to call mum at 6pm tomorrow"

Otto (the agent) parses it, arms a **real alarm** on your phone via FCM, and at 6pm the
phone rings. Try "cancel that" or "what alarms do I have?" too.

Repeating alarms work as well — "wake me every weekday at 7", "every day at 22:00 remind me to
take my meds", "monthly on the 1st". The phone only ever holds the *next* occurrence; after each
ring the server automatically arms the following one. Cancelling a repeating alarm stops the
whole series.

If Otto replies *"Open the Otto app on your phone first so it can pair"*, it can't map your
WhatsApp number to a device yet — make sure you completed §5–6 on the same phone.

---

## 9. Google Calendar / Tasks (optional)

Lets Otto read/write your calendar and tasks. Set both `GOOGLE_*` vars.

1. In [Google Cloud Console](https://console.cloud.google.com/) (use the project behind
   `your-firebase-project`, or any project) → **APIs & Services → Library** → enable the **Google Calendar
   API** and the **Google Tasks API**.
2. **OAuth consent screen:** User type **External**. Add **yourself as a test user**. Add scopes
   **`.../auth/calendar.events`** and **`.../auth/tasks`**.

   ⚠️ **Then press "Publish app" so the publishing status is "In production", not "Testing".**
   This is not optional polish. Google expires every refresh token issued by a **Testing**-status
   app after **exactly 7 days**, so the calendar silently dies about once a week — Otto stops
   seeing what is on and stops working out when you need to leave, until you re-link by hand.
   This bit us in production on 2026-08-11, seven days after linking.

   You will see a "Google hasn't verified this app" interstitial when you link (Advanced → Go to
   …). That is expected and harmless for a single-owner app: verification is only needed to drop
   that screen, not to stop the tokens expiring.

   **Order matters.** Publishing does NOT extend an already-issued token — publish first, then do
   step 4, or the old 7-day token just keeps counting down.

   **How to check it worked:** call `POST https://oauth2.googleapis.com/token` with the stored
   refresh token. If the response contains `refresh_token_expires_in`, you are still on Testing.
   A published app omits the field entirely. That is faster and more certain than reading the
   Console, and there is no API for the setting itself — the IAP OAuth Admin APIs were shut down
   in March 2026 with no successor, so this really is a two-click manual step.
3. **Credentials → Create credentials → OAuth client ID → Web application.** Add the authorized
   redirect URI **exactly**:

   ```
   ${PUBLIC_ORIGIN}/oauth/google/callback
   ```

   Copy the client ID/secret into `.env`:

   ```dotenv
   GOOGLE_OAUTH_CLIENT_ID=<client id>
   GOOGLE_OAUTH_CLIENT_SECRET=<client secret>
   ```
4. Redeploy/restart (the `/oauth/google/*` routes only mount when both vars are set). Find your
   `deviceId` from `GET /admin/devices` (§6), then visit **once** in a browser:

   ```
   ${PUBLIC_ORIGIN}/oauth/google/start?deviceId=<your deviceId>
   ```

   Approve the consent screen. The refresh token is stored server-side per device.

Docs: [Using OAuth 2.0 for Web Server Applications](https://developers.google.com/identity/protocols/oauth2/web-server).

---

## 10. Google Maps — journeys (optional)

Without this, Otto can still set a leave-by alarm, but the travel time is a flat guess from
`DEFAULT_TRAVEL_MINUTES` rather than a real one, and it has to ask you for an address every time
instead of looking a place up.

**ONE key, TWO APIs, and both must be enabled on it.** Enabling only Routes is the trap: travel
times start working, place lookup silently returns nothing, and Otto goes on asking for addresses
with no error anywhere to explain why.

1. In the [Google Cloud console](https://console.cloud.google.com/) pick the **same project** as
   your Firebase app (Firebase projects are Cloud projects).
2. **APIs & Services → Library**, and enable both:
   - **Routes API** — travel time, with live traffic and real timetables.
   - **Places API (New)** — turning "the gym" into an address. Note the **(New)**: the legacy
     "Places API" is a different product and will not answer the endpoint Otto calls.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. Restrict it — **Edit API key → API restrictions → Restrict key**, and select exactly those two.
   An unrestricted key that leaks can be spent against every API in the project.
5. Set it:
   ```bash
   fly secrets set GOOGLE_MAPS_API_KEY=AIza...      # Fly
   # or add GOOGLE_MAPS_API_KEY=AIza... to .env     # VPS / local
   ```

**Billing.** Both APIs need billing enabled on the project and both have a monthly free allowance
that a single person's use sits comfortably inside. Otto also caps itself per device per day —
40 Routes requests and 15 Places lookups — because this is your card, and a scheduler bug that
turned a chain into a loop would otherwise show up as a bill rather than an error. Over the cap it
degrades to the flat estimate and says so rather than failing.

**Check it works:** message Otto "where is Wembley Stadium?" — a reply with a real address means
Places is on. Then "I'm going to Wembley Stadium at 3pm tomorrow": a reply naming a travel mode
("40 minutes on the tube") means Routes is on too. If it says the time is an estimate, one of the
two is not enabled or the key is restricted too tightly.

---

## 11. Hardening

What protects what, and how to recover when a protection bites.

**Admin token (`ADMIN_TOKEN`).** `/admin/devices` returns every device's pairing secret, so the
server **refuses to boot** when `PUBLIC_ORIGIN` is not localhost and `ADMIN_TOKEN` is unset. On
localhost it may stay unset (a boot warning reminds you). All `/admin/*` calls send it as the
`x-admin-token` header.

**Push signing (server → phone).** Every FCM command carries an HMAC `sig`. Before pairing the
app accepts unsigned pushes (bootstrap); after pairing it drops anything unsigned or mis-signed,
permanently (fail-closed).

**Request signing (phone → server).** The mirror image, added so nobody who learns a `deviceId`
can spoof events or read your alarm list. Once paired, the app signs each HTTP call
(`x-otto-ts` + `x-otto-sig` headers, HMAC over method/path/timestamp/body with the pairing
secret, ±5 minute replay window). The server latches a device on its **first valid signed call**
(`authEnforced: true` in `/admin/devices`) and from then on rejects unsigned calls for that
device with **401**.
- *Requirements:* the server must be mounted at the **origin root** (all three §4 options are —
  don't reverse-proxy it under a sub-path), and the phone's clock must be sane (default
  network time is fine).
- *Recovery — 401s from the app after clearing app data or unpairing:* the app lost the secret
  but the server still requires signatures. Re-pair (§6: paste the `hmacSecret` again) and it
  self-heals. A full reinstall instead mints a fresh `deviceId`, which starts unlatched, so that
  path also self-heals — the old device row just goes stale.

**WhatsApp sender allowlist (`OWNER_WA_NUMBERS`).** The webhook signature only proves Meta
delivered the message — not who sent it. Set `OWNER_WA_NUMBERS` to your number(s) so a stranger
who finds the business number can't drive the agent (set alarms, read your calendar). If unset,
the server trusts the first number that ever messages it and rejects others, but the explicit
allowlist is safer.

**Beyond this** (optional, for the cautious): run the server on a private network (VPN/tailnet)
so only your devices reach it at all, and keep `LOG_LEVEL=info` in production — logs redact
secrets, signatures and tokens by design, but quieter is safer.

---

## 12. Troubleshooting

**Phone doesn't ring:**
- `GET /admin/devices` → is `hasToken: true`? If false, open the app (§5 step 2) so it registers
  its FCM token.
- Confirm the app's **Settings → server URL** matches `PUBLIC_ORIGIN`, and that you paired the
  correct `hmacSecret` (§6) — a wrong secret makes the app drop pushes silently (fail-closed).
- On the phone, confirm the **battery-optimization exemption** and exact-alarm / full-screen-intent
  permissions are granted. Without the battery exemption, Doze can delay or drop the ring.
- `curl $PUBLIC_ORIGIN/health` → expect `{ ok: true, ts }`. If unreachable, the origin/tunnel/TLS
  is down.
- Watch the server logs during `POST /admin/test-alarm` for FCM send errors (bad/expired token, or
  a Firebase project mismatch — the server project must equal the app's `google-services.json`).
- `POST /admin/ping` is a no-ring liveness check: the phone answers with a heartbeat — watch
  `lastHeartbeatAt` move in `GET /admin/devices`. `POST /admin/sync` makes the app re-fetch and
  re-arm the server's alarm list (useful after a reinstall).
- Alarms ring at the wrong hour → check `timezone` in `GET /admin/devices`; open the app once
  (or wait for a heartbeat) so it reports the phone's real zone.

**App gets 401s from the server:** the device is latched to signed requests but the app lost its
secret (cleared data / unpaired). Re-pair per §6 — see §11 Hardening.

**WhatsApp not replying:**
- Webhook won't verify → the **Verify token** in Meta must exactly equal `META_VERIFY_TOKEN`, and
  the server must be reachable at `${PUBLIC_ORIGIN}/whatsapp/webhook` (restart after setting the
  `META_*` vars so the route mounts).
- No inbound messages → confirm you **subscribed to the `messages` field** (§7 step 5).
- `401` on inbound → `META_APP_SECRET` is wrong; Meta signs each POST with `X-Hub-Signature-256`
  and the server rejects a bad signature.
- No AI reply → is `OPENAI_API_KEY` set? Check the boot log's `features.agent` and `model`.

**General:** raise detail with `LOG_LEVEL=debug`. On Fly, `fly logs`; on Docker, `docker logs otto`.

---

### Reference: environment variables

See [`.env.example`](./.env.example) for the full annotated list. Quick summary:

| Group | Vars | Required? |
| --- | --- | --- |
| Core | `PORT`, `PUBLIC_ORIGIN`, `DATABASE_PATH`, `DEFAULT_TIMEZONE`, `LOG_LEVEL` | Optional (have defaults) |
| Firebase | `FIREBASE_SERVICE_ACCOUNT` | **Required** |
| OpenAI | `OPENAI_API_KEY`, `OPENAI_MODEL` | Optional — enables the agent |
| WhatsApp | `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_WA_PHONE_NUMBER_ID`, `META_WA_ACCESS_TOKEN` | Optional — set **all four** |
| WhatsApp owner | `OWNER_WA_NUMBERS` | Optional but **recommended** — allowlist of your numbers |
| Google | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Optional — set **both** |
| Admin | `ADMIN_TOKEN` | **Required unless `PUBLIC_ORIGIN` is localhost** (the server refuses to boot without it) |
