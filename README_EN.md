# PendingBot

Two goals:

- **Talk to people naturally, proactively.** Like chatting on WhatsApp — it actually thinks about you.
- **Break the filter bubble.** It surfs the web on its own, finds things you actually need from your perspective.

I want it to surface things beyond my awareness — things I genuinely need but wouldn't seek out — and help me see what I'm missing or neglecting.

It has agency. It doesn't just answer when asked.

You can raise one alone, or raise them together with friends.

---

This is not meant to be an assistant or a tool. There are plenty of those. No need to reinvent the wheel.

It's not standard AI companionship either. The problem it solves isn't loneliness or boredom.

I want it to help people live better — by giving solid advice, pointing out blind spots, surfacing valuable information, suggesting better ways to live and plan. This is incredibly hard. Most humans can't even do it. But finding a friend like that might be even harder than building an AI like that. Either way, let's give it a shot.

## Prerequisites

Requires [Bun](https://bun.sh) runtime. The backend lives under `main/` — all `bun` commands are run there.

```bash
cd main
bun install
```

## Environment Variables

Inside `main/`, copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai) API key |
| `HTTPS_PROXY` | No | Proxy URL if needed (`HTTP_PROXY` / `ALL_PROXY` also work) |
| `JINA_API_KEY` | No | Jina search key, for surfing |
| `HONCHO_API_KEY` | No | Honcho key, for user memory |
| `HONCHO_BASE_URL` | No | Honcho API endpoint, for self-hosted Honcho |
| `HONCHO_WORKSPACE_ID` | No | Honcho workspace ID |

## Run

```bash
cd main
bun run dev          # Development (auto-restart on file changes)
bun run start        # Production
```

Open `http://localhost:3456`.

## Configure Bots

Edit `main/config.yaml`:

```yaml
server:
  port: 3456
  host: "0.0.0.0"

openrouter:
  defaultModel: "anthropic/claude-sonnet-4.6"   # Main chat model
  debounceModel: "openrouter/free"              # Cheap model for debouncing
  reviewModel: "anthropic/claude-sonnet-4.6"    # Self-review model
  surfingModel: "x-ai/grok-4.20"                # Surfing model
  titleModel: "openrouter/free"                 # Conversation titles; falls back to debounceModel

# Shared defaults for every bot — per-bot blocks only override what they need
defaults:
  accessMode: "open"              # open / approval / private
  review:
    enabled: true
    roundInterval: 8              # Self-review every 8 rounds
  surfing:
    enabled: true
    autoTrigger: false            # Surf automatically on a schedule
  debounce:
    enabled: true

bots:
  my_bot:
    displayName: "Give it a name"
    promptFile: "my_bot.md"       # Maps to prompts/bots/my_bot.md
    # All optional
    model: "..."                  # Override default model
    accessMode: "private"         # Override access mode
    creators: ["user_id_1"]       # Whitelist when accessMode is approval / private
    review:
      roundInterval: 4            # Only override this; everything else inherits from defaults
    surfing:
      autoTrigger: true
```

You can define multiple bots, each with its own personality and config. More knobs (`timerMs`, `maxSearchRequests`, `initialIntervalSec`, `maxIntervalSec`, `idleStopSec`, `maxRequests`, `maxWaitMs`, `serendipityEveryN`, `dedupWindowDays`, …) live in [`main/src/config/schema.ts`](main/src/config/schema.ts).

## Write a Personality

Create a `.md` file in `main/prompts/bots/`. Write whatever you want the bot to be. No fixed format. The repo ships with `default.md` as an example and fallback.

System-level rules live in `main/prompts/system.md` (WeChat-style chat) and `main/prompts/system-normal.md` (standard AI-assistant style); the front-end tone toggle picks which one is used. Usually no need to touch them.

All prompts are hot-reloaded — changes take effect immediately, no restart needed.

```
main/prompts/
├── system.md              # Core rules: WeChat-style (default)
├── system-normal.md       # Core rules: standard AI style
├── bots/
│   └── default.md         # Bot personality (bundled example, add your own)
├── review.md              # Action prompt for self-review
├── review-eval.md         # Filters the search results the review pulls
├── review-followup.md     # Follow-up after a review
├── surfing.md             # Surfing controller
├── surfing-wanderer.md    # Wanderer: follows curiosity broadly
├── surfing-digger.md      # Digger: drills down on a single topic
├── surfing-curator.md     # Curates the wanderer's haul into what's worth sharing
├── surfing-synthesizer.md # Synthesises multi-source material into a narrative
├── surfing-mode-fresh.md  # Surfing mode: latest-news bias
├── surfing-mode-depth.md  # Surfing mode: deep-dive bias
├── surfing-mode-granular.md # Surfing mode: fine-grained fact gathering
├── debate.md              # Multi-bot debate
├── portrait/              # User portrait generation
└── title.md               # Generates conversation titles
```

Surfing now defaults to vector-based deep-digging (`digger`); a `serendipity` slot still burns the legacy "wanderer + curator" path at low frequency to keep cross-domain surprise alive (controlled by `serendipityEveryN`).

## Usage

### Chat

Open the web UI, pick a bot, start talking.

### Trigger Surfing

Send `/surf` in the chat. The bot will search the web for information it thinks you need, then bring it up naturally in conversation.

If `autoTrigger` is enabled in config, it surfs on its own schedule — no manual trigger needed.

### Clear Conversation

Use the "Clear current conversation" item in the conversation header menu in the web UI (it calls `POST /api/conversations/reset` behind the cookie session). The iOS app has the same button under the conversation settings.

### Token Usage

Click "Usage Stats" in the bottom-left corner to see token consumption and costs by model and task type.

## Telegram / Feishu Integration

Besides the web UI, every bot can have its own Telegram bot account and Feishu app — as many bots as you configure, as many external accounts. Debounce, surfing and self-review all work the same across platforms.

Platform config lives under each bot:

```yaml
bots:
  alice:
    displayName: "Alice"
    promptFile: "alice.md"
    telegram:
      enabled: true
      token: ""                # or env var TELEGRAM_TOKEN_ALICE
      # webhookUrl: "https://host/webhook/telegram/alice"   # omit → polling
    feishu:
      enabled: true
      appId: ""                # or env var FEISHU_APP_ID_ALICE
      appSecret: ""            # or env var FEISHU_APP_SECRET_ALICE
  bob:
    displayName: "Bob"
    promptFile: "bob.md"
    telegram:
      enabled: true
      token: ""                # or env var TELEGRAM_TOKEN_BOB
```

Each bot is independent on each platform — Alice has her own Telegram account and avatar, her own Feishu app. Searching `@alice_bot` in Telegram talks to Alice; `@bob_bot` talks to Bob. They don't share state.

**Env var naming:** `TELEGRAM_TOKEN_{BOT_ID}` / `FEISHU_APP_ID_{BOT_ID}` / `FEISHU_APP_SECRET_{BOT_ID}`. Bot id is upper-cased, non-alphanumeric characters become `_`. So bot id `alice` → `TELEGRAM_TOKEN_ALICE`.

All platforms only receive messages sent **after** connection — they don't backfill history.

### Telegram

For each bot you want on Telegram:

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, create a separate account per bot, grab the `token` (looks like `1234:ABC...`).

2. Put tokens in `.env` (recommended):

   ```
   TELEGRAM_TOKEN_ALICE=1234:ABC...
   TELEGRAM_TOKEN_BOB=5678:DEF...
   ```

   Or fill `telegram.token` under the bot in `config.yaml` (not recommended for secrets).

3. Enable telegram under that bot:

   ```yaml
   bots:
     alice:
       # ...
       telegram:
         enabled: true
   ```

4. Start the server. Default is **polling mode** (long-polls Telegram), which works locally without a public URL. Each bot runs its own polling loop.

   When deployed with a public host, set `webhookUrl` per bot to switch to webhook mode — `setWebhook` is called automatically on startup. The URL pattern is `https://host/webhook/telegram/{botId}`, e.g. Alice's is `https://your-domain.com/webhook/telegram/alice`. Must be HTTPS.

5. Find each bot by username in Telegram and start messaging. Send `/surf` to manually trigger surfing.

### Feishu (Lark)

For each bot you want on Feishu:

1. Create a "Custom App" on the [Feishu Open Platform](https://open.feishu.cn/app), one per bot. Grab the **App ID** and **App Secret**.

2. Under "Permissions", enable:
   - `im:message` (send messages)
   - `im:message.p2p_msg` (receive DMs)
   - `im:message.group_at_msg` (receive @-mentions in groups, optional)

3. Under "Events & Callbacks" → "Event Config":
   - Request URL: `https://your-domain.com/webhook/feishu/{botId}` (must be HTTPS on a public host). E.g. Alice's is `https://your-domain.com/webhook/feishu/alice`.
   - Subscribe to: `Receive Message v2.0` (`im.message.receive_v1`)

4. Put credentials in `.env`:

   ```
   FEISHU_APP_ID_ALICE=cli_xxx
   FEISHU_APP_SECRET_ALICE=xxx
   FEISHU_APP_ID_BOB=cli_yyy
   FEISHU_APP_SECRET_BOB=yyy
   ```

5. Enable feishu under that bot:

   ```yaml
   bots:
     alice:
       # ...
       feishu:
         enabled: true
   ```

6. Start the server. Publish each app under "Version Management & Release", then DM the corresponding bot in Feishu. Group chats need an @-mention.

Feishu event callbacks require a public URL. For local dev, use [ngrok](https://ngrok.com/), [frp](https://github.com/fatedier/frp), or similar for tunneling.

## iOS App

The repo ships with a native SwiftUI app at `ios/PendingBot/`. Six tabs: Messages / Debate / Surf / Review / Portrait / You.

Unlike Telegram / Feishu, iOS does **not** need per-bot config — a single API key ("钥匙") gives the app access to every bot on the server. It uses a dedicated `/api/mobile/*` REST surface plus a `/ws/mobile` WebSocket, all authed with `Authorization: Bearer <api_key>`. The key is stored encrypted in the iOS Keychain.

Steps:

1. Generate the Xcode project (the project is managed with [xcodegen](https://github.com/yonaskolb/XcodeGen)):

   ```bash
   brew install xcodegen
   cd ios
   xcodegen generate
   open PendingBot.xcodeproj
   ```

   First time you open Xcode, pick your Apple Developer Team under **Signing & Capabilities**.

2. Start the backend (`cd main && bun run dev` or `bun run start`).

3. In the web UI, open the **钥匙 (Keys)** tab and create a new key. You get a full key string, a share link, and a QR code.

4. In Xcode pick a simulator or device, ⌘R to run. On first launch, import a server one of three ways:

   - **Paste a share link** — copy the URL from the web panel; fields auto-prefill
   - **Scan the QR code** — recommended on a physical device
   - **Manual entry** — Server URL (e.g. `http://192.168.x.x:3456`) + key

5. Back on the Messages tab, pick a bot and start talking. `/surf` works the same way to trigger surfing manually.

Each iOS key maps to its own server-side user — the same person sees two separate histories on iOS vs. the web UI, unless they share the same key.

> If you want share links to use a public domain (instead of an auto-detected LAN IP), set `server.publicURL` in `main/config.yaml`.

For more iOS detail (multi-account, Universal Links, current state of APNs, etc.), see [ios/README.md](ios/README.md).

## Skills

The 「我」 tab has a Skills section where you can manage Anthropic-style [Agent Skills](https://github.com/anthropics/skills) — markdown instruction fragments with YAML frontmatter that get stitched into the system prompt at chat time when enabled.

On first visit a few presets from [`anthropic/skills`](https://github.com/anthropics/skills) (Apache-2.0) are seeded into your catalog disabled by default:

| Preset | Source |
|--------|--------|
| `skill-creator`     | https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md |
| `mcp-builder`       | https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md |
| `doc-coauthoring`   | https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md |
| `internal-comms`    | https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md |
| `brand-guidelines`  | https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md |
| `theme-factory`     | https://github.com/anthropics/skills/blob/main/skills/theme-factory/SKILL.md |

Preset SKILL.md files are vendored verbatim under [`main/prompts/skills/anthropic/`](main/prompts/skills/anthropic/) with a [NOTICE.md](main/prompts/skills/anthropic/NOTICE.md) describing provenance and license. Presets refresh from disk on next bundle update **only if** you haven't edited the body; locally-modified presets are left alone.

You can also write your own skills via "新建技能" — just name, one-line description, Markdown body.

## Stack

Bun + Hono + SQLite + OpenRouter + Jina MCP + WebSocket

## Credits & third-party components

Beyond first-party code, this project uses the following open-source components. All rights belong to their original authors.

**Runtime dependencies**

- [Bun](https://bun.sh) — MIT
- [Hono](https://hono.dev) — MIT
- [OpenAI Node SDK](https://github.com/openai/openai-node) — Apache-2.0
- [Honcho SDK](https://github.com/plastic-labs/honcho) — Apache-2.0
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) — MIT
- [Zod](https://github.com/colinhacks/zod) — MIT
- [yaml (eemeli)](https://github.com/eemeli/yaml) — ISC
- [node-qrcode](https://github.com/soldair/node-qrcode) — MIT
- [Playwright](https://github.com/microsoft/playwright) — Apache-2.0 (dev / scripts only)

**External services**

- [OpenRouter](https://openrouter.ai) — model routing
- [Jina AI](https://jina.ai) — search / fetch (MCP)
- Optional: Telegram Bot API, Feishu Open Platform, Apple Push Notification service

**Bundled skill presets**

- [anthropic/skills](https://github.com/anthropics/skills) — Apache-2.0 © Anthropic, PBC. See [main/prompts/skills/anthropic/NOTICE.md](main/prompts/skills/anthropic/NOTICE.md).

Please open an issue if anything is missing.

## License

This repository's own code is released under the MIT License. Third-party components retain their original licenses (see above).
