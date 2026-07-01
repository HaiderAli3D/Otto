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

Get the code and dependencies:

```bash
git clone <this-repo> otto-server && cd otto-server
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

## 3. Anthropic (Claude agent) — optional but needed for the "AI" part

Only required once you want to talk to Otto in natural language (§8). The REST endpoints and FCM
pushes work without it.

1. Go to the [Anthropic Console](https://console.anthropic.com/) → **API Keys** → create a key.
2. In `.env`:

   ```dotenv
   ANTHROPIC_API_KEY=sk-ant-...
   # ANTHROPIC_MODEL defaults to claude-opus-4-8 — leave unless you want another model.
   ```

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
  ANTHROPIC_API_KEY=sk-ant-... \
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

---

## 5. Point the phone at the server & prove the pipe (before WhatsApp)

This confirms Firebase + endpoints work end-to-end **without** WhatsApp or AI.

1. In the Otto app: **Settings → server URL** and enter your `PUBLIC_ORIGIN`. Debug builds allow
   this override.
2. **Open the app once.** It registers its FCM token with the server (`POST /devices/:id/token`),
   which creates the device row. Without this there is no device to push to.
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
§10 if it doesn't ring.

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

5. **Configure the webhook.** Redeploy/restart the server so the `META_*` vars load (the
   `/whatsapp/webhook` route only mounts when all four are present). Then in the App Dashboard →
   **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL:** `${PUBLIC_ORIGIN}/whatsapp/webhook`
   - **Verify token:** the exact `META_VERIFY_TOKEN` value from step 4.
   - Meta sends a `GET` challenge to that URL; the server echoes it back and the webhook saves.
   - Then under **Webhook fields**, **subscribe to the `messages` field**. (Without this you get
     no inbound messages.)

> **24-hour customer-service window:** WhatsApp only allows free-form replies within 24h of the
> user's last inbound message; outside it you must use pre-approved templates. Otto only ever
> *replies* to a message you just sent, so it always stays inside the window — no templates
> needed.

---

## 8. Use it

Message your Otto WhatsApp number (the test number from §7, or your production number once
approved). For example:

> "remind me to call mum at 6pm tomorrow"

Otto (the Claude agent) parses it, arms a **real alarm** on your phone via FCM, and at 6pm the
phone rings. Try "cancel that" or "what alarms do I have?" too.

If Otto replies *"Open the Otto app on your phone first so it can pair"*, it can't map your
WhatsApp number to a device yet — make sure you completed §5–6 on the same phone.

---

## 9. Google Calendar / Tasks (optional)

Lets Otto read/write your calendar and tasks. Set both `GOOGLE_*` vars.

1. In [Google Cloud Console](https://console.cloud.google.com/) (use the project behind
   `your-firebase-project`, or any project) → **APIs & Services → Library** → enable the **Google Calendar
   API** and the **Google Tasks API**.
2. **OAuth consent screen:** User type **External**, publishing status **Testing**. Add **yourself
   as a test user**. Add scopes **`.../auth/calendar.events`** and **`.../auth/tasks`**.
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

## 10. Troubleshooting

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

**WhatsApp not replying:**
- Webhook won't verify → the **Verify token** in Meta must exactly equal `META_VERIFY_TOKEN`, and
  the server must be reachable at `${PUBLIC_ORIGIN}/whatsapp/webhook` (restart after setting the
  `META_*` vars so the route mounts).
- No inbound messages → confirm you **subscribed to the `messages` field** (§7 step 5).
- `401` on inbound → `META_APP_SECRET` is wrong; Meta signs each POST with `X-Hub-Signature-256`
  and the server rejects a bad signature.
- No AI reply → is `ANTHROPIC_API_KEY` set? Check the boot log's `features.agent`.

**General:** raise detail with `LOG_LEVEL=debug`. On Fly, `fly logs`; on Docker, `docker logs otto`.

---

### Reference: environment variables

See [`.env.example`](./.env.example) for the full annotated list. Quick summary:

| Group | Vars | Required? |
| --- | --- | --- |
| Core | `PORT`, `PUBLIC_ORIGIN`, `DATABASE_PATH`, `DEFAULT_TIMEZONE`, `LOG_LEVEL` | Optional (have defaults) |
| Firebase | `FIREBASE_SERVICE_ACCOUNT` | **Required** |
| Claude | `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional — enables the agent |
| WhatsApp | `META_APP_SECRET`, `META_VERIFY_TOKEN`, `META_WA_PHONE_NUMBER_ID`, `META_WA_ACCESS_TOKEN` | Optional — set **all four** |
| Google | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | Optional — set **both** |
| Admin | `ADMIN_TOKEN` | Optional locally, **set in production** |
