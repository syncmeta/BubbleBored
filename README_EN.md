# BubbleBored

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

Requires [Bun](https://bun.sh) runtime.

```bash
bun install
```

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | [OpenRouter](https://openrouter.ai) API key |
| `HTTPS_PROXY` | No | Proxy URL if needed |
| `JINA_API_KEY` | No | Jina search key, for surfing |
| `HONCHO_API_KEY` | No | Honcho key, for user memory |
| `HONCHO_WORKSPACE_ID` | No | Honcho workspace ID |

## Run

```bash
bun run dev          # Development (auto-restart on file changes)
bun run start        # Production
```

Open `http://localhost:3456`.

## Configure Bots

Edit `config.yaml`:

```yaml
openrouter:
  defaultModel: "anthropic/claude-sonnet-4.6"   # Main chat model
  debounceModel: "openrouter/free"              # Cheap model for debouncing
  reviewModel: "anthropic/claude-sonnet-4.6"    # Self-review model
  surfingModel: "x-ai/grok-4.20"               # Surfing model

bots:
  my_bot:
    displayName: "Give it a name"
    promptFile: "my_bot.md"       # Maps to prompts/bots/my_bot.md
    # All optional — falls back to global defaults
    model: "..."                  # Override default model
    review:
      enabled: true
      roundInterval: 8            # Self-review every 8 rounds
    surfing:
      enabled: true
      autoTrigger: true           # Surf automatically on a schedule
    debounce:
      enabled: true
```

You can define multiple bots, each with its own personality and config.

## Write a Personality

Create a `.md` file in `prompts/bots/`. Write whatever you want the bot to be. No fixed format.

System-level rules live in `prompts/system.md` — usually no need to touch it.

All prompts are hot-reloaded — changes take effect immediately, no restart needed.

```
prompts/
├── system.md            # Core rules (usually leave alone)
├── bots/
│   └── my_bot.md        # Your bot's personality
├── debounce-judge.md    # Debounce judge
├── review.md            # Self-review
├── surfing.md           # Surfing assessment
└── surfing-eval.md      # Search result evaluation
```

## Usage

### Chat

Open the web UI, pick a bot, start talking.

### Trigger Surfing

Send `/surf` in the chat. The bot will search the web for information it thinks you need, then bring it up naturally in conversation.

If `autoTrigger` is enabled in config, it surfs on its own schedule — no manual trigger needed.

### Clear Conversation

```bash
curl -X POST http://localhost:3456/api/conversations/reset \
  -H "Content-Type: application/json" \
  -d '{"userId":"your_userId","botId":"bot_id"}'
```

### Token Usage

Click "Usage Stats" in the bottom-left corner to see token consumption and costs by model and task type.

## Stack

Bun + Hono + SQLite + OpenRouter + Jina MCP + WebSocket

## License

MIT
