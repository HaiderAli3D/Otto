# Contributing

Otto is one person's assistant that happens to be open source. That shapes what's realistic here,
so rather than leave you guessing:

- **Issues are welcome**, especially "this step of the setup didn't work on my machine". Setup
  friction is the most valuable bug report this project can get, because the author can only ever
  test the path they already know works.
- **PRs are welcome**, but please open an issue first for anything structural. Some of the odder
  decisions in here are load-bearing and the reasons are usually written down next to them.
- **Nothing is promised.** No SLA, no roadmap, no guarantee a PR gets merged. If you fork it and
  make it yours, that is a completely good outcome and the licence exists to let you.

## Before you change anything

Read the comment above the code first. This codebase explains *why* far more than *what*, and a
surprising number of the strange-looking choices are scar tissue from something that broke:

- `android/CLAUDE.md` — platform gotchas, the notification-channel rules, migration procedure
- `android/spec.md` — the full technical spec, §1–17
- `server/SETUP.md` — the setup walkthrough, including its failure modes

Two rules worth stating up front, because breaking either is silent and expensive:

1. **Never widen `AlarmScheduler` to serve something that isn't an alarm.** The nudge path has its
   own scheduler, receivers, intent actions and request-code band, deliberately. Giving the alarm
   interface a second caller with different needs is the most likely way to regress the one thing
   this app must never get wrong.
2. **Never hand-write a Room migration.** Bump the version, build once so KSP exports the schema
   JSON, then copy its `createSql` verbatim. There is no `fallbackToDestructiveMigration`, so a
   migration whose DDL doesn't reproduce the generated schema byte for byte throws on first open —
   and on this app that means somebody's alarms stop working.

## Running the tests

```bash
# Android — unit tests (no device needed)
cd android && ./gradlew :app:testDebugUnitTest

# Android — migration tests (needs a connected device or emulator)
cd android && ./gradlew :app:connectedAndroidTest

# Server
cd server && npm ci && npm run typecheck && npm test
```

The server suite is hermetic: it deliberately runs without an API key so every model-backed
surface exercises its deterministic fallback. Live integration is a separate `npm run smoke`.

## A note on secrets

This repo has never contained a credential and it should stay that way. Both `.gitignore` files
plus the root one form a deliberately redundant net covering `.env`, service accounts, keystores,
`google-services.json`, `local.properties` and SQLite files (including the `-wal` and `-shm`
sidecars, which do *not* match `*.sqlite` and routinely hold real data).

If you're adding a config surface, add the placeholder to `server/.env.example` and document it —
never a real value, not even temporarily, not even in a branch.
