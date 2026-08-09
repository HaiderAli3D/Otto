# Otto server

The **server half of Otto**, a personal WhatsApp-based AI scheduling agent. This service
receives WhatsApp messages, runs an OpenAI agent to understand them, and pushes **FCM data
messages** to the Otto Android app, which arms a **real device alarm** that rings even when
the phone is backgrounded, in Doze, or locked.

> The Android app is a **separate repo**. Its only job is to receive a push and ring a real
> alarm — it never decides *when* to ring. This server sends the absolute instructions.

## Architecture (one line)

```
WhatsApp  →  this server (OpenAI agent)  →  FCM  →  phone rings a real alarm
```

Single-user by design (one owner, their phone), but everything is keyed by `deviceId` so more
devices can pair later. State lives in one SQLite file (`DATABASE_PATH`, auto-created on boot).
The alarm scheduler runs **in-process**, so the server must stay resident (do not scale to zero).

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness: `{ ok: true, ts }`. |
| `GET /admin/devices` | Owner-only: lists each device's `hmacSecret` (pairing secret), `hasToken`, `timezone`, `authEnforced`. |
| `POST /admin/test-alarm` | Owner-only: arm a real alarm now-ish. Body `{ deviceId?, inSeconds?, label? }`. |
| `POST /admin/cancel` | Owner-only: cancel an alarm. Body `{ deviceId, alarmId }`. |
| `POST /admin/sync` | Owner-only: push SYNC — the app re-fetches and re-arms the server's alarm list. Body `{ deviceId? }`. |
| `POST /admin/ping` | Owner-only: no-ring liveness check — the app answers with a heartbeat. Body `{ deviceId? }`. |
| `POST /devices/:id/token`, `.../heartbeat`, `.../alarms`, `POST /alarms/:id/events` | Called by the app. Signed once paired (see SETUP.md §11 Hardening). |
| `POST/GET /whatsapp/webhook` | Meta WhatsApp Cloud API webhook (only mounted when `META_*` are set). |
| `GET /oauth/google/start?deviceId=...` | Google Calendar/Tasks OAuth (only mounted when `GOOGLE_*` are set). |

`/admin/*` requires the `x-admin-token` header; `ADMIN_TOKEN` is mandatory whenever
`PUBLIC_ORIGIN` is not localhost (the server refuses to boot without it). Device endpoints
require a request signature once the device has paired (fail-closed per device).

## Run locally

Requires **Node 20+**.

```bash
npm install
cp .env.example .env         # then edit .env
# Minimum to prove the pipe: fill FIREBASE_SERVICE_ACCOUNT (required).
# Add OPENAI_API_KEY to enable the agent.
npm run dev                  # tsx watch — reloads on change
```

Other scripts:

```bash
npm run build   # tsc → dist/
npm start       # node dist/index.js (after build)
npm test        # vitest run
```

## Deploy & connect your phone

See **[SETUP.md](./SETUP.md)** — a numbered, turnkey walkthrough that takes a solo owner from
zero to "message Otto on WhatsApp and my phone rings". It covers Firebase, OpenAI, getting a
public HTTPS origin (Fly.io / VPS+Caddy / Cloudflare tunnel), pairing the phone, and the Meta
WhatsApp + Google Calendar setup.
