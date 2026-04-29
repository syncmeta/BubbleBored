<p align="center">
  <img src="docs/app-icon.png" width="128" alt="PendingBot app icon" />
</p>
<h1 align="center">PendingBot</h1>

<p align="center">
  Honest with each other. Curious together. Proactive, candid, a VC for ideas.
  <br />
</p>
<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/syncmeta/PendingBot?color=blue" /></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=black" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Web%20%7C%20iOS-lightgrey" />
</p>


An AI that catches its own mistakes and scouts the world for you while you sleep.

## What it does:

- Goes back over your conversations with the AI again and again — not just to call out its own slip-ups, but to push back on you, too: to point out where your thinking's off, where you've got blind spots, where you've been wrong. So both of you actually grow.
- Digs deep across the internet, hunts around on its own, scours every corner for stuff that's actually useful to you — the kind of thing that makes you go "oh, this is good."
- Does all of the above without being told — it speaks first, it doesn't just talk when spoken to.

## Aim:

- **Keep each other honest** — so you don't drift, get fooled, or lose the plot mid-conversation with an AI.
- **Be a VC for ideas** — scouting what's beyond your current bubble. Extend your mind, without losing it.

**Not** an assistant, **not** a world's first ___ agent — plenty of those already!

**Not** your typical AI companion either — not a yes-man, not a therapist-in-a-box, not someone who'll tell you you're brilliant when you're not.

More like a friend who brings a new perspective. That's what good friends actually do.

The content below is, for now, written by Claude. I'll check it later.

## ✨ What it can actually do

It revolves around three things — chat, reflection, exploration — and you don't have to nudge it. It does these on its own.

- **🧠 Proactive chat** — WeChat-style by default: short turns, pauses, no over-explaining; switchable to a standard AI tone. If you're typing fast mid-thought, it pauses instead of barreling over you.
- **🪞 Self-review / keeping each other honest** — every N rounds it goes back over the recent conversation: was something it said muddled? Where do you have blind spots? Then it comes back and tells you.
- **🌊 Web surfing** — it goes off and scrounges around the internet for things actually worth showing you, and brings the best bits back to the conversation. Trigger manually with `/surf`, or let it run on a schedule.
- **🗣️ A circle of bots talking about you** — pull the bots you regularly chat with into a group, and let them discuss *you* — like a circle of friends talking about you behind your back. Multi-angle outside perspective.
- **🪪 Long-term portrait & memory** — backed by [Honcho](https://honcho.dev): it builds a picture of you over time and remembers things, which feeds back into how it chats, reflects, and surfs.
- **👥 Many-to-many social / information network** — one bot can chat with many people, and one person can chat with many bots, weaving humans and bots into a network. Friends can co-raise the same bot, which then carries an impression of each of you.
- **🤖 Basic agent capabilities** — Anthropic-style markdown skills as a starting point; more mature agent capability is on the way.
- **🔐 BYOK** — don't want to be billed by the host? Drop in your own OpenRouter key and every call runs on your account.

## 💬 What it's like to actually use

A few concrete moments:

- **It pulls the brake mid-chat**: you're hashing out a decision; a few rounds later it sends, "Hold on — what I said earlier contradicts itself, retracting."
- **You wake up to a surf haul**: `autoTrigger` was on overnight; it went off and rummaged for hours, and now there are three angles you hadn't considered.
- **Listening to your bots talk about you**: the bots you usually chat with sit down together and discuss a decision you're stuck on, while you watch — multi-angle outsiders.
- **A few friends co-raising one bot**: a small friend group raises one bot together; it has an impression of each of you and can stitch the different perspectives together.
- **Heavy GPT/Claude/Grok user with your own key**: drop your OpenRouter key under "Me" → Settings; from then on every model call goes against your account.

## 🚀 Get started

The app is live. A few ways in right now.

### iOS (most convenient — but unfinished)

Native SwiftUI, six tabs: Messages / Debate / Surf / Review / Portrait / Me. **Not yet on the App Store, still actively iterating.** For now, build from source and run it via Xcode:

```bash
brew install xcodegen
cd apps/ios && xcodegen generate
open PendingBot.xcodeproj
```

Pick a Signing Team on first open. On first launch you **pick one of three import flows**: QR scan / paste login code / manual entry. See [apps/ios/README.md](apps/ios/README.md).

### Web — bot.pendingname.com

The hosted instance is live at [`bot.pendingname.com`](https://bot.pendingname.com). **It's rough right now** — basically a scaffold Claude put together — usable, but a long way from finished. Iterating.

### Self-host

Zero external accounts, runs locally:

```bash
git clone https://github.com/syncmeta/PendingBot.git
cd PendingBot
bun install                                  # installs the whole monorepo in one go
cp apps/api/.env.example apps/api/.env       # only OPENROUTER_API_KEY is required
bun run dev:api                              # start the backend
```

Open the `http://localhost:3456/i/...` link printed in the console → create the admin account → start chatting. Full options in [docs/self-hosting.md](docs/self-hosting.md).

### Hosted deployment

Full Fly.io + Cloudflare + Turso/R2 + Clerk + Honcho recipe in [docs/deploy.md](docs/deploy.md). Machine cost ~$3/month. `bot.pendingname.com` runs this stack.

An adapter layer lets both modes share one codebase: env unset → local SQLite + local disk + invite codes; env set → Turso / R2 / Clerk / Honcho. Switch by changing env, not code.

### Configure bots

Add or tweak bots in `apps/api/config.yaml`; personality files go under `apps/api/prompts/bots/`, no fixed format. Full schema: [apps/api/src/config/schema.ts](apps/api/src/config/schema.ts).

## 📍 Progress

Concrete shell — walls up, finish work pending.

- **Backend (apps/api)** — running, most of the features above work, still iterating heavily.
- **iOS (apps/ios)** — all six tabs working; sign-in via Apple / Google / invite code; not yet on the App Store.
- **Web (apps/web)** — Claude-scaffolded, mid-rewrite. `bot.pendingname.com` currently still serves the backend's bundled legacy UI.
- **Hosted instance** — `bot.pendingname.com` (Fly.io + Cloudflare + Clerk + Honcho).

## 🙏 Credits & references

- **Portrait & memory** are powered by [Honcho](https://honcho.dev) ([plastic-labs/honcho](https://github.com/plastic-labs/honcho), Apache-2.0).
- **Agent Skills presets** come from [anthropic/skills](https://github.com/anthropics/skills) (Apache-2.0), vendored verbatim under [apps/api/prompts/skills/anthropic/](apps/api/prompts/skills/anthropic/) — see [NOTICE](apps/api/prompts/skills/anthropic/NOTICE.md).
- **Runtime**: [Bun](https://bun.sh) (MIT) · [Hono](https://hono.dev) (MIT) · [OpenAI Node SDK](https://github.com/openai/openai-node) (Apache-2.0) · [Honcho SDK](https://github.com/plastic-labs/honcho) (Apache-2.0) · [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT) · [Zod](https://github.com/colinhacks/zod) (MIT) · [yaml](https://github.com/eemeli/yaml) (ISC) · [node-qrcode](https://github.com/soldair/node-qrcode) (MIT).
- **External services**: [OpenRouter](https://openrouter.ai) (model routing) · [Honcho](https://honcho.dev) (portrait / memory) · [Jina AI](https://jina.ai) (search / fetch, optional) · [Clerk](https://clerk.com) (auth, optional) · Apple Push Notification service (optional).

## 🧱 Stack

- **Backend**: Bun + Hono + SQLite + OpenRouter + Honcho + WebSocket
- **Web**: React + Vite + Tailwind + shadcn/ui + TanStack Query
- **iOS**: Swift + SwiftUI + XcodeGen
- **Hosted**: Fly.io (API) + Cloudflare (DNS/WAF/Pages/R2) + Clerk (Auth) + Honcho (portrait / memory)

## 📂 Repo layout

```
PendingBot/                  bun workspaces monorepo
├── apps/
│   ├── api/                 Bun + Hono backend (the core)
│   ├── web/                 React + Vite frontend (rewrite in progress)
│   └── ios/                 Native SwiftUI iOS app
├── packages/
│   └── shared-types/        Types / zod schemas shared between front and back
└── docs/
    ├── self-hosting.md      Self-hosting guide
    └── deploy.md            Hosted deployment guide
```

Inside `apps/api/prompts/`: `system*.md` core rules · `bots/` per-bot personalities · `review*.md` self-review · `surfing-*.md` surfing pipeline · `debate.md` multi-bot debate · `portrait/` user portrait · `title.md` conversation titles · `skills/` skill catalog.

> The brand site `pendingname.com` lives in another repo, `syncmeta/PendingName-web` — not here.

## 🤝 Contributing

Issues and PRs welcome. A quick chat about the idea before submitting tends to go smoother, especially for prompt / surfing-pipeline / cross-platform-protocol changes.

## 📄 License

[MIT](LICENSE). Third-party components keep their original licenses (above).

---

<p align="center">
  Made with 💚 for people who want a friend that pushes back, not a tool that nods along.
</p>
