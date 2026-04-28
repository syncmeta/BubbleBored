# Hosted deploy guide

What this gets you: `bot.pendingname.com` serving the web client + API,
behind Cloudflare for WAF / DDoS, with attachments on R2 and the SQLite
database on a Fly persistent volume. iOS app talks to the same hostname.

The self-host story is in [self-hosting.md](self-hosting.md). This file
covers the production stack as deployed for `pendingname.com`.

## Pre-requisites

You need accounts at:

- **Cloudflare** — DNS, WAF, Pages (later), R2
- **Fly.io** — runs the API container
- **Clerk** — auth (Sign in with Apple / Google / email code)
- **OpenRouter** — LLM routing
- **Sentry** (optional) — error tracking

Plus a domain you control; the docs assume `pendingname.com`.

The card you bind to Fly / Cloudflare must accept Stripe USD charges. A
HK-issued Mastercard / Visa works without surprises; mainland CN cards
are unreliable.

## 1. DNS to Cloudflare

1. Register on Cloudflare, add the site `pendingname.com`, pick the free plan.
2. Cloudflare gives you two nameservers — paste them into Porkbun's
   "Authoritative Nameservers" for the domain.
3. Wait for Cloudflare to confirm the move (a few minutes typically; up to
   24h worst case).
4. **Don't add any DNS records yet** — Fly will give us the target host in step 4.

## 2. R2 buckets

1. In the Cloudflare dashboard: **R2 → Enable** (it'll ask for billing — same
   card you used for the account).
2. Create a bucket named `pendingbot-prod` (and `pendingbot-dev` if you'll
   run a dev environment too).
3. **R2 → Manage R2 API Tokens → Create API Token**:
   - Permission: **Object Read & Write**
   - Bucket scope: the buckets you just made
   - Save the **Access Key ID**, **Secret Access Key**, and your **Account ID**
     (the URL slug `https://dash.cloudflare.com/<account_id>/r2`).

## 3. Clerk application

1. Create an organization called `pending` (so we can extend to other
   Pending\* products later) and an application called `pendingbot`.
2. Enable two environments: **development** and **production**.
3. In the production environment:
   - **Authentication → Email/Phone**: turn on **Email code (passwordless)**.
   - **Authentication → Social**: turn on **Google**.
   - Sign in with Apple needs an Apple Developer Service ID — defer to the
     iOS milestone.
4. Note the production environment's **Frontend API URL** (the issuer
   for JWT verification, of the form `https://clerk.pendingname.com`
   once you set up a satellite domain — for now it's
   `https://<id>.clerk.accounts.dev`).

## 4. Fly app

```bash
brew install flyctl
fly auth login                   # opens a browser

cd apps/api
fly launch \
  --copy-config --no-deploy \
  --name pendingbot-api \
  --region iad

fly volumes create pendingbot_data --region iad --size 1
```

Set secrets — none of these go in source:

```bash
fly secrets set \
  OPENROUTER_API_KEY="sk-or-..." \
  BYOK_ENC_KEY="$(openssl rand -hex 32)" \
  CLERK_ISSUER="https://<id>.clerk.accounts.dev" \
  R2_ACCOUNT_ID="..." \
  R2_ACCESS_KEY_ID="..." \
  R2_SECRET_ACCESS_KEY="..." \
  R2_BUCKET="pendingbot-prod" \
  CORS_ALLOWED_ORIGINS="https://bot.pendingname.com"
```

> **Save `BYOK_ENC_KEY` to a password manager too.** If you lose it every
> user-supplied OpenRouter / Jina API key in the database becomes
> permanently undecryptable. `fly secrets list` only shows the digest.

Deploy:

```bash
fly deploy
```

Verify:

```bash
curl -i https://pendingbot-api.fly.dev/api/health
# {"status":"ok"}
```

## 5. Point `bot.pendingname.com` at Fly via Cloudflare

1. Cloudflare DNS dashboard → Add record:
   - Type: `CNAME`
   - Name: `bot`
   - Target: `pendingbot-api.fly.dev`
   - Proxy status: **Proxied (orange cloud)** — this is what gives us WAF + DDoS
2. Tell Fly about the new hostname so it provisions a TLS cert that
   Cloudflare's "Full (strict)" mode will accept:

   ```bash
   fly certs add bot.pendingname.com
   fly certs check bot.pendingname.com   # wait until "Verified"
   ```

3. In Cloudflare → SSL/TLS → set encryption mode to **Full (strict)**.
4. Verify the chain:

   ```bash
   curl -i https://bot.pendingname.com/api/health
   ```

## 6. Mark `pendingname.com` as the placeholder site

Until the marketing site is real, just push the placeholder under
`apps/site/public/` to Cloudflare Pages:

1. In the Cloudflare dashboard → **Pages → Create application → Connect to Git**.
2. Pick the `PendingBot` repo, build command empty, output dir `apps/site/public`.
3. After first deploy, Pages gives a `*.pages.dev` URL.
4. Add custom domain `pendingname.com` to that Pages project; Cloudflare
   will issue the cert + create the apex DNS record automatically.

## 7. Smoke test the full chain

- `curl -i https://pendingname.com` → placeholder site
- `curl -i https://bot.pendingname.com/api/health` → `{"status":"ok"}`
- Open `https://bot.pendingname.com/` in a browser, redeem the bootstrap
  invite link from `fly logs`, send a chat message — it should work.

## 8. Wire CI

After verifying manually, drop in the GitHub Actions workflow at
`.github/workflows/deploy-api.yml`. You'll need a single repo secret:

- `FLY_API_TOKEN` (generate with `fly tokens create deploy --expiry 8760h`)

Push to `main` from then on auto-deploys.

## Updating

- **Code change**: `git push` → CI deploys.
- **Secrets change**: `fly secrets set FOO=bar` (Fly redeploys automatically).
- **Bot prompt / config**: edit `apps/api/prompts/*.md` or `apps/api/config.yaml`,
  push — same as code.
- **Database migration**: just push. Migrations run on boot (PRAGMA
  user_version progression in `apps/api/src/db/index.ts`).

## Backups

SQLite + Fly volume = single point of failure. Fly volumes are NOT
automatically replicated. Until we migrate to Turso, run a 6-hourly
backup to R2:

```bash
fly ssh console
sqlite3 /data/bubblebored.sqlite ".backup /data/backup-$(date +%F-%H).sqlite"
# upload to R2 via aws cli or rclone — see scripts/backup.sh once written
```

A scheduled GitHub Action triggering this via `fly ssh console` is a
to-do.

## Cost

- Cloudflare: $0 (free plan, R2 < 10GB)
- Fly: ~$2–4/month (autostop hobby load)
- Clerk: $0 (under 10k MAU)
- OpenRouter: variable — capped per user via the quota system
- Domain: ~$10/year via Porkbun
