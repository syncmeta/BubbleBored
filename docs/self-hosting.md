# Self-hosting guide

PendingBot runs end-to-end on your own machine without any third-party
account. The default mode is:

- **SQLite** on local disk (no Turso, no Postgres)
- **Local filesystem** for image attachments (no S3 / R2)
- **Invite-code login** (no Clerk) — admin bootstrap link printed on first run

This is what `bun run dev` gives you out of the box. Set the right env
vars later and the same code switches into hosted mode adapter-by-adapter.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- An [OpenRouter](https://openrouter.ai) API key — the one piece you
  can't replace, since it's how the bot talks to LLMs

## Quickstart

```bash
git clone https://github.com/syncmeta/PendingBot.git
cd PendingBot
bun install                     # installs everything in the monorepo

cd apps/api
cp .env.example .env
# edit .env — only OPENROUTER_API_KEY is required
bun run dev
```

The first time you run, the console prints something like:

```
========================================================================
  No admin account yet — open this link to create the first one:
  http://localhost:3456/i/abc123def456...
========================================================================
```

Open the link in a browser → you're logged in as the admin. From there
the web UI works as documented in the main README.

## Where state lives

By default everything goes under `apps/api/data/`:

- `bubblebored.sqlite` — chat history, users, audit log, everything
- `uploads/yyyy-mm/<uuid>.<ext>` — attached images

To put state somewhere else (e.g. on a separate disk), set `DATA_DIR`:

```bash
DATA_DIR=/srv/pendingbot bun run dev
```

To **back up**: copy the whole `DATA_DIR` while the server is stopped, or
use `sqlite3 ... ".backup ..."` for the database while it's running.

## Running behind a reverse proxy

Out of the box the server binds `0.0.0.0:3456`. To put it on a public
HTTPS endpoint, terminate TLS in front (Caddy / Cloudflare Tunnel /
nginx / Traefik) and proxy `/`, `/api/*`, `/ws*`, `/uploads/*` to the
backend.

Caddy example:

```Caddyfile
bot.example.com {
  reverse_proxy localhost:3456
}
```

Cloudflare Tunnel needs no inbound port at all — see the [official
quickstart](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/).

## Switching to managed services (the hosted mode)

Set any of these env vars and the matching adapter flips on. Anything
unset stays on the local default.

| Env vars | What changes |
|---|---|
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | Image attachments go to Cloudflare R2 instead of the local disk |
| `CLERK_ISSUER` | Adds the `/api/auth/clerk/exchange` route. Existing invite-code flow still works in parallel |
| `BYOK_ENC_KEY` | Encryption key for user-supplied OpenRouter / Jina API keys (BYOK feature). **Mandatory in any deploy where users may set BYOK** — without it, BYOK values don't survive a restart |

The full list is in `apps/api/.env.example`.

## Configuring bots

Edit `apps/api/config.yaml`. The schema is documented in
`apps/api/src/config/schema.ts`. Bot personalities live in
`apps/api/prompts/bots/*.md`; system prompts in `apps/api/prompts/`. All
are hot-reloaded — no restart needed.

## Updating

```bash
git pull
cd apps/api
bun install                # if dependencies changed
bun run dev                # migrations run automatically on startup
```

## Troubleshooting

- **"no admin account" link expired** — run `bun run reset-admin-key` in
  `apps/api/` to mint a fresh bootstrap invite.
- **uploads return 404** — check `apps/api/data/uploads/` exists and is
  writable; check the SQLite `attachments` row's `path` column matches.
- **WS keeps dropping** — make sure your reverse proxy forwards the
  `Upgrade` and `Connection` headers (`/ws` and `/ws/mobile`).
