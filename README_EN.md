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

- **🧠 Proactive chat** — WeChat-style by default: short turns, pauses, no over-explaining; switchable to a standard AI tone. If you're typing fast mid-thought, it pauses (debounce) instead of barreling over you.
- **🪞 Self-review / keeping each other honest** — every N rounds it goes back over the recent conversation: was something it said muddled? Where do you have blind spots? Then it comes back and tells you. The "Review" tab is the surface for this.
- **🌊 Web surfing** — a separate pipeline. It picks a search direction from your recent topics + portrait, then searches, digs, and skims on its own, and writes the best bits into the conversation. Send `/surf` to trigger manually, or flip on `autoTrigger` to let it run on a schedule.
- **🗣️ Multi-bot debate** — pick a topic, let two bots with different personalities argue it out, you watch.
- **🪪 Long-term portrait** — the bot gradually builds a "picture of you in its eyes" that feeds back into how it reflects and what it surfs for.
- **👥 Multi-bot, co-raised** — each bot is a markdown personality file with its own model, access scope, review cadence, surf cadence. Raise alone or co-raise one with friends.
- **🛠️ Agent Skills** — Anthropic-style markdown skill snippets. Toggle on, they get spliced into the system prompt; toggle off, they vanish. Six Anthropic presets ship with the repo.
- **🔐 BYOK** — don't want to be billed by the host? Drop in your own OpenRouter key and every call runs on your account.
- **🧩 Hot-reloaded prompts** — anything under `apps/api/prompts/` takes effect on save, no restart.

## 💬 What it's like to actually use

A few concrete moments:

- **It pulls the brake mid-chat**: you're hashing out a decision; a few rounds later it sends, "Hold on — what I said earlier contradicts itself, retracting." That's the review loop firing.
- **You wake up to a surf haul**: `autoTrigger` was on overnight; based on what you'd been talking about, it went off and rummaged for hours, and now there are three angles you hadn't considered.
- **Make two bots argue**: stuck on a choice, hand the topic to two bots with very different personalities and watch them debate it.
- **Heavy GPT/Claude/Grok user with your own key**: drop your OpenRouter key under "Me" → Settings; from then on every model call goes against your account.

## 🚀 Get started

### Self-host (simplest)

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

Full Fly.io + Cloudflare + Turso/R2 + Clerk recipe in [docs/deploy.md](docs/deploy.md). Machine cost ~$3/month. `bot.pendingname.com` runs this stack.

An adapter layer lets both modes share one codebase: env unset → local SQLite + local disk + invite codes; env set → Turso / R2 / Clerk. Switch by changing env, not code.

### Configure bots

Add or tweak bots in `apps/api/config.yaml`; personality files go under `apps/api/prompts/bots/`, no fixed format. Full schema: [apps/api/src/config/schema.ts](apps/api/src/config/schema.ts).

### Web

Just open the URL the backend prints (default `http://localhost:3456`). Responsive — works on mobile too.

### iOS

Native SwiftUI, six tabs: Messages / Debate / Surf / Review / Portrait / Me.

```bash
brew install xcodegen
cd apps/ios && xcodegen generate
open PendingBot.xcodeproj
```

Pick a Signing Team on first open. On first launch you **pick one of three import flows**: QR scan / paste login code / manual entry. See [apps/ios/README.md](apps/ios/README.md).

## 📍 Progress

- **Backend (apps/api)** — everything above is in; this is the core of the repo.
- **iOS (apps/ios)** — all six tabs working; sign-in via Apple / Google / invite code.
- **Web (apps/web)** — React + shadcn/ui scaffold, rewrite in progress; day-to-day use still goes through the backend's bundled legacy UI.
- **Hosted instance** — `bot.pendingname.com` (Fly.io + Cloudflare + Clerk).

## 🙏 Credits & references

- **Agent Skills presets** come from [anthropic/skills](https://github.com/anthropics/skills) (Apache-2.0), vendored verbatim under [apps/api/prompts/skills/anthropic/](apps/api/prompts/skills/anthropic/) — see [NOTICE](apps/api/prompts/skills/anthropic/NOTICE.md).
- **Runtime**: [Bun](https://bun.sh) (MIT) · [Hono](https://hono.dev) (MIT) · [OpenAI Node SDK](https://github.com/openai/openai-node) (Apache-2.0) · [Honcho SDK](https://github.com/plastic-labs/honcho) (Apache-2.0) · [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (MIT) · [Zod](https://github.com/colinhacks/zod) (MIT) · [yaml](https://github.com/eemeli/yaml) (ISC) · [node-qrcode](https://github.com/soldair/node-qrcode) (MIT).
- **External services**: [OpenRouter](https://openrouter.ai) (model routing) · [Jina AI](https://jina.ai) (search / fetch, optional) · Apple Push Notification service (optional) · [Clerk](https://clerk.com) (auth, optional).

## 🧱 Stack

- **Backend**: Bun + Hono + SQLite + OpenRouter + WebSocket
- **Web**: React + Vite + Tailwind + shadcn/ui + TanStack Query
- **iOS**: Swift + SwiftUI + XcodeGen
- **Hosted**: Fly.io (API) + Cloudflare (DNS/WAF/Pages/R2) + Clerk (Auth)

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
