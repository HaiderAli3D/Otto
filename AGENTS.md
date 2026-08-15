# AGENTS.md — the Otto monorepo

Context for AI build sessions working at the repository root. Each half has its own, far more
detailed notes; **read the one for the half you're touching before you change anything.**

| | |
|---|---|
| `android/` | The Kotlin companion app. Deep context: [`android/CLAUDE.md`](android/CLAUDE.md). Full spec: [`android/spec.md`](android/spec.md). |
| `server/` | The Node/TypeScript server and AI agent. Setup and operational detail: [`server/SETUP.md`](server/SETUP.md). Env surface: [`server/.env.example`](server/.env.example). |
| `docs/` | [Building the app](docs/BUILDING-THE-APP.md), [manual device tests](docs/manual-testing.md). |

## What Otto is

A personal WhatsApp-based AI scheduling agent, for one owner and their phone. WhatsApp message →
server → OpenAI agent → FCM data push → the Android app arms a real device alarm that rings in
Doze, over the lockscreen, and after a reboot.

The load-bearing boundary: **the server speaks in absolute instructions** (*"arm alarm X at epoch
T with label L"*) and **the app never interprets intent, parses language, or computes times.**
That keeps all reasoning somewhere it can change without shipping a new APK. Do not erode it.

## Repository shape

The two halves were separate repos until they were merged, history intact, into this one —
`android/` by a directory move, `server/` via `git subtree`. Consequences worth knowing:

- Commits older than the merge show **root-level paths** for whichever half they touched.
  `git log --follow <path>` traces through it correctly.
- Some prose in `android/CLAUDE.md` and `android/spec.md` still says "other repo". The code is
  right; the wording is legacy.
- There is **no build-time link between the halves.** Nothing checks the server's FCM payloads
  against the app's parser. That gap is covered by
  `android/app/src/test/.../push/ServerPayloadContractTest.kt`, which holds payloads the server
  actually produced, signature included. If you change the wire format, change it there too.

## Building and testing

```bash
cd android && ./gradlew :app:assembleDebug          # needs JDK 17+, SDK 36, google-services.json
cd android && ./gradlew :app:testDebugUnitTest      # JVM unit tests
cd android && ./gradlew :app:connectedAndroidTest   # migration tests — needs a device

cd server && npm ci && npm run typecheck && npm test
```

`android/app/google-services.json` is gitignored and required — the build fails clearly without
it, deliberately. The server needs only `FIREBASE_SERVICE_ACCOUNT` to boot.

## Rules that are not style preferences

1. **Never widen `AlarmScheduler` to serve a nudge.** The nudge path has its own scheduler
   interface, receivers, intent actions and request-code band, all the way down. `reArmAll()`
   iterates the `alarms` table only, so nudges are structurally invisible to it.
2. **Never post a chase on the `otto_alarm` channel.** It is the one channel that must survive a
   mute. A test pins that `channelIdFor(level)` can never return it.
3. **Never hand-write a Room migration.** Bump the version, build once so KSP exports the schema
   JSON, copy its `createSql` verbatim. There is no `fallbackToDestructiveMigration`.
4. **Verify the HMAC before parsing the payload.** The rejection path emits an authenticated
   request, and `REQUEST_LOCATION` is downstream of the parser.
5. **`v` stays `"1"` forever.** New `type` values are the extension mechanism; bumping `v` makes
   every new push invisible to any device that hasn't updated.
6. **Room is the source of truth** on the app side. AlarmManager is derived state. If they
   disagree, Room wins.
7. **Never commit a credential.** `.gitignore` at the root plus one per half form a deliberately
   redundant net. This repo is public and has never contained a secret; keep it that way.

## This repository is public

Everything committed here is world-readable, including commit messages. Placeholders only:
`<your-project-id>`, `your-otto-server`, `https://otto.invalid/`. Never a live project id,
hostname, phone number, or key — not even in a branch.
