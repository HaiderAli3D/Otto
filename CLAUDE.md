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
