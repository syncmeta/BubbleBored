<p align="center">
  <img src="docs/app-icon.png" width="128" alt="PendingBot app icon" />
</p>

<h1 align="center">大绿豆 · PendingBot</h1>

<p align="center">
  Proactively, naturally, without sycophancy — correcting each other, exploring the unknown.
  <br />
  <em>主动、自然、不谄媚地校正彼此、探索未知。</em>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/syncmeta/PendingBot?color=blue" /></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=black" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Web%20%7C%20iOS-lightgrey" />
</p>



## Aim:

- **Keep each other honest** — so you don't drift, get fooled, or lose the plot mid-conversation with an AI.
- **Be a VC for ideas** — scouting what's beyond your current bubble

**Not** an assistant, **not** a world's first xxx agent — plenty of those exist!

**Not** your typical AI companion either — not a yes-man, not a therapist-in-a-box, not someone who'll tell you you're brilliant when you're not. 

More like a friend who brings a new perspective. That's what good friends actually do.

The content below is, for now, written by Claude. I'll check it later.

## 🚀 Highlights

| | |
|---|---|
| 🧠 **Proactive chat** | WeChat-style tone, debounced interrupts, self-review (reflects on the recent conversation every N rounds) |
| 🌊 **Web surfing** | Search + dig + wander + curator filtering — surfaces what's actually worth telling you |
| 👥 **Multi-bot** | Each bot has its own personality / model / access scope; raise alone or co-raise with friends |
| 🌐 **Cross-platform** | Web (responsive) + native iOS (SwiftUI) |
| 🎯 **OpenRouter routing** | Mix and match models per role: chat / debounce / review / surfing / titles configured independently |
| 🛠️ **Agent Skills** | Anthropic skill-creator and friends bundled; write your own as plain Markdown |
| 🧩 **Hot-reloaded prompts** | Any `.md` under `apps/api/prompts/` takes effect on save |
| 🔐 **BYOK** | Users can supply their own OpenRouter key — doesn't draw from the host's quota |
| 🪪 **Clerk auth (optional)** | Hosted mode: Sign in with Apple / Google / Email Code; self-host still uses invite codes |

## 📂 Repo layout

```
PendingBot/                  bun workspaces monorepo
├── apps/
│   ├── api/                 Bun + Hono backend (the core)
│   ├── web/                 React + Vite + TS frontend (rewrite in progress, scaffold)
│   └── ios/                 Native SwiftUI iOS app
                             (the brand site pendingname.com lives in another repo,
                              syncmeta/PendingName-web — not here)
├── packages/
│   └── shared-types/        Types / zod schemas shared between front and back
├── docs/
│   ├── self-hosting.md      Self-hosting guide
│   └── deploy.md            Hosted deployment guide
└── README.md                The Chinese README (this is its English mirror)
```

## 🚀 Self-host quickstart

Zero external accounts — runs locally:

```bash
git clone https://github.com/syncmeta/PendingBot.git
cd PendingBot
bun install                                  # installs the whole monorepo in one go
cp apps/api/.env.example apps/api/.env       # only OPENROUTER_API_KEY is required
bun run dev:api                              # start the backend
```

Open the `http://localhost:3456/i/...` link printed to the console → create the admin account → start chatting.
Full options in [docs/self-hosting.md](docs/self-hosting.md).

## ☁️ Hosted deployment

The full Fly.io + Cloudflare + Turso/R2 + Clerk recipe lives in
[docs/deploy.md](docs/deploy.md). Machine cost ~$3/month; accounts, attachment storage,
DDoS / WAF are all covered by the managed services. `bot.pendingname.com` is an instance of this stack.

An adapter layer lets both modes share one codebase: env unset → local SQLite + local disk + invite codes;
env set → Turso (tentative) / R2 / Clerk. Switch by changing env, not code.

## ⚙️ Configure bots

Edit `apps/api/config.yaml`:

```yaml
server:
  port: 3456
  host: "0.0.0.0"
  publicURL: "https://bot.pendingname.com"   # set this in hosted mode

openrouter:
  models:
    chat: "x-ai/grok-4.20"
    humanAnalysis: "anthropic/claude-opus-4.7"
    agentDecision: "z-ai/glm-5.1"
    skim: "deepseek/deepseek-v4-pro"
    vision: "anthropic/claude-opus-4.7"

defaults:
  accessMode: "open"
  review:   { enabled: true,  roundInterval: 8 }
  surfing:  { enabled: true,  autoTrigger: false }
  debounce: { enabled: true }

bots:
  my_bot:
    displayName: "Give it a name"
    promptFile: "my_bot.md"
    accessMode: "private"
    creators: ["user_id_1"]
    review:  { roundInterval: 4 }
    surfing: { autoTrigger: true }
```

Full schema: [apps/api/src/config/schema.ts](apps/api/src/config/schema.ts).

## 🎭 Write a personality

Drop a `.md` under `apps/api/prompts/bots/` and write whatever you want the bot to be.
No fixed format. The repo ships `default.md` as an example. All prompts hot-reload —
no restart needed.

```
apps/api/prompts/
├── system.md              Core rules: WeChat-style (default)
├── system-normal.md       Core rules: standard AI style
├── bots/                  Bot personalities
├── review.md              Self-review
├── surfing-*.md           Stages of the surfing pipeline
├── debate.md              Multi-bot debate
├── portrait/              User portrait
└── title.md               Conversation title generation
```

## 💬 Usage

- **Chat**: open the web UI, pick a bot, go.
- **Surf**: send `/surf`; with `autoTrigger` on it runs on its own schedule.
- **Token usage**: "Usage Stats" in the bottom-left.
- **Quota / BYOK**: "You" → Settings → bring-your-own OpenRouter key (optional).

## 📱 iOS

Native SwiftUI under [apps/ios/](apps/ios/PendingBot/), six tabs: Messages /
Debate / Surf / Review / Portrait / You. Generate the Xcode project:

```bash
brew install xcodegen
cd apps/ios && xcodegen generate
open PendingBot.xcodeproj
```

Pick a Signing Team on first open. On first launch, **pick one of three import flows**:
QR scan / paste login code / manual. See [apps/ios/README.md](apps/ios/README.md).

## 🛠️ Skills

The "Skills" area on the "Me" tab manages Anthropic-style [Agent Skills](https://github.com/anthropics/skills).
On first open, 6 presets are seeded (disabled by default), all from
[anthropic/skills](https://github.com/anthropics/skills) (Apache-2.0); the originals
are vendored at [apps/api/prompts/skills/anthropic/](apps/api/prompts/skills/anthropic/).

## 🧱 Stack

<p>
  <img alt="Bun" src="https://img.shields.io/badge/Bun-fbf0df?logo=bun&logoColor=black" />
  <img alt="Hono" src="https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white" />
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black" />
  <img alt="Swift" src="https://img.shields.io/badge/Swift-F05138?logo=swift&logoColor=white" />
</p>

- **Backend**: Bun + Hono + SQLite + OpenRouter + WebSocket
- **Web**: React + Vite + Tailwind + shadcn/ui + TanStack Query
- **iOS**: Swift + SwiftUI + XcodeGen
- **Hosted**: Fly.io (API) + Cloudflare (DNS/WAF/Pages/R2) + Clerk (Auth)

## 🙏 Credits

- Runtime: [Bun](https://bun.sh) MIT · [Hono](https://hono.dev) MIT ·
  [OpenAI Node SDK](https://github.com/openai/openai-node) Apache-2.0 ·
  [Honcho SDK](https://github.com/plastic-labs/honcho) Apache-2.0 ·
  [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) MIT ·
  [Zod](https://github.com/colinhacks/zod) MIT · [yaml](https://github.com/eemeli/yaml) ISC ·
  [node-qrcode](https://github.com/soldair/node-qrcode) MIT
- External services: [OpenRouter](https://openrouter.ai) · [Jina AI](https://jina.ai) (optional) ·
  Apple Push Notification service (optional)
- Skill presets: [anthropic/skills](https://github.com/anthropics/skills) Apache-2.0 ©
  Anthropic, PBC, see [NOTICE](apps/api/prompts/skills/anthropic/NOTICE.md)

## 🤝 Contributing

Issues and PRs welcome. A quick chat about the idea before submitting tends to go smoother,
especially for prompt / surfing-pipeline / cross-platform-protocol changes.

## 📄 License

[MIT](LICENSE). Third-party components keep their original licenses (above).

---

<p align="center">
  Made with 💚 for people who want a friend that pushes back, not a tool that nods along.
</p>
