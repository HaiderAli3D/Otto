# CLAUDE.md — working agreements

Project context lives in [`AGENTS.md`](AGENTS.md) — what Otto is, the repository shape, how to
build and test each half, and the seven rules that are not style preferences. Read that first.
This file is only about how to *work* here.

## Shipping: on the go-ahead, go

When the owner gives the go-ahead — *"ship it"*, *"do it"*, *"commit and push"*, *"deploy it"*, or
any other plain yes — **carry the whole sequence out without stopping to ask.** Commit, push,
open or merge the PR, and deploy. Do not come back between the steps for permission you have
already been given.

In particular, do not ask:

- which branch to use, or whether to branch at all;
- whether to open a pull request or merge straight in;
- whether to deploy after merging;
- for confirmation of a step the owner has just named.

Pick the sensible option, say in one line what you picked, and keep going.

**What still holds.** None of these are questions — they are things to do, or to report:

- `cd server && npm run typecheck && npm test` before shipping server changes. If it is red, stop
  and say so with the output. Shipping a known-broken build is not what "no questions asked" means.
- Never commit a credential, and never put a live project id, hostname, phone number or key in a
  file *or a commit message*. This repository is public.
- Say plainly what happened afterwards — the commit, the branch, the PR, the deployed version, and
  anything you could not finish. Faithful reporting is not hedging.

If something genuinely blocks the sequence — a merge conflict, a failing deploy, a missing secret —
fix it if you can, and if you cannot, finish everything else and say exactly what is left.

## Changing the server's schema

`ensureSchema()` in [`server/src/db/client.ts`](server/src/db/client.ts) is the whole migration
mechanism — no migrations directory, no drizzle-kit step. Adding a column is **two edits**: the
field in `db/schema.ts`, and one `ensureColumn(table, column, ddl)` line beside the ones already
there.

Make it **nullable** and fall back at read time (`?? theOldColumn`). SQLite accepts
`ADD COLUMN ... NOT NULL` only with a constant default, and a nullable column needs no backfill —
so existing rows keep the behaviour they had and nothing re-indexes on deploy.

Verify against a database built with the OLD schema before shipping: create the previous table by
hand in a scratch file, run `ensureSchema()` over it, and confirm pre-existing rows still read back
and that a second boot is a no-op. The production volume is the only copy of the owner's data.

## Proving a change, and tests that pin the wrong behaviour

**Prove behaviour by running it, not by reading it.** A throwaway `tsx` script that calls
`ensureSchema()` against `DATABASE_PATH=':memory:'` and drives the real services turns a hypothesis
into evidence in a minute. The worst defects here are interactions between two individually-correct
modules, and no amount of reading finds those.

**A test that pins a defect gets changed in the same commit as the fix**, with the commit message
naming which assertion flipped and why. This suite stayed green through every bug it had; green is
not evidence on its own.

Two harness facts that make assertions pass for the wrong reason:

- **One in-memory DB per test FILE**, shared by every test in it. Device ids, WhatsApp numbers and
  outbox dedupe keys leak between tests — reuse an id and the next test inherits its rows.
- **`makeDevice` is not push-reachable**: appVersion `1.0.0`, no heartbeat, so `pushReachable()` is
  false for every device it builds. Anything about the FCM tier needs `reachable()` from
  `test/push.test.ts`, or it asserts the failure path while reading like the success one.

## Deploying the server

```bash
cd server && npm run typecheck && npm test        # must be green first
cd server && fly deploy -c fly.production.toml    # NOT bare `fly deploy`
```

**`-c fly.production.toml` is not optional.** The committed `fly.toml` is deliberately full of
placeholders because this repo is public, and `PUBLIC_ORIGIN` is one of them. Deploying with it
points the origin at a hostname that does not exist, and every Google reconnect link is built from
that value — so the one self-healing path out of a revoked grant goes dead, silently, until someone
notices. The real values live in `server/fly.production.toml`, which is gitignored and local-only.

The machine must stay resident: the alarm scheduler runs in-process, so never `fly scale count 0`
or enable scale-to-zero. A stopped machine misses alarms.

Operational detail, environment surface and first-time setup are in
[`server/SETUP.md`](server/SETUP.md).
