# BubbleBored

[English](README_EN.md)

两大目标：

- **和人自然地交流、主动对话。** 和微信聊天一样，让它心里有你。
- **破除信息茧房。** 自己上网冲浪，从使用者的利益出发，寻找他真正需要的东西。

我想让它给我推送我认知以外、又真正需要的东西，帮助我意识到自己所忽略的、不足的东西。

它有主动性。不是你问一句它答一句。

它/它们可以由一人养育，也可以和好友一起养育。

---

主要不是想做助手或工具。助手类应用大把人做，没必要重复造轮子。

也不是想做标准的 AI 陪伴，解决的需求不在于缺爱了想找个 AI 陪或者无聊了想找个人聊天。

我期望它能帮人生活得更好，方式可以是给出靠谱的建议、指出自己意识不到的问题、提供有价值的信息、提供更好的生活方式与计划……虽然这非常难实现，人都很难做到，但要想有一个这样的朋友也许比做一个这样的 AI 更难。不论如何，我先试试，弄来耍一耍。

## 准备

需要 [Bun](https://bun.sh) 运行时。

```bash
bun install
```

## 环境变量

复制 `.env.example` 为 `.env`，填入以下内容：

| 变量 | 必填 | 说明 |
|------|------|------|
| `OPENROUTER_API_KEY` | 是 | [OpenRouter](https://openrouter.ai) API Key |
| `HTTPS_PROXY` | 否 | 代理地址，网络不通时使用 |
| `JINA_API_KEY` | 否 | Jina 搜索 Key，用于冲浪功能 |
| `HONCHO_API_KEY` | 否 | Honcho Key，用于用户记忆 |
| `HONCHO_WORKSPACE_ID` | 否 | Honcho 工作区 ID |

## 启动

```bash
bun run dev          # 开发模式（文件变动自动重启）
bun run start        # 生产模式
```

打开 `http://localhost:3456`。

## 配置 Bot

编辑 `config.yaml`：

```yaml
openrouter:
  defaultModel: "anthropic/claude-sonnet-4.6"   # 主对话模型
  debounceModel: "openrouter/free"              # 防抖用的便宜模型
  reviewModel: "anthropic/claude-sonnet-4.6"    # 自我反思模型
  surfingModel: "x-ai/grok-4.20"               # 冲浪模型

bots:
  my_bot:
    displayName: "起个名字"
    promptFile: "my_bot.md"       # 对应 prompts/bots/my_bot.md
    # 以下都可选，不写就用全局默认值
    model: "..."                  # 覆盖默认模型
    review:
      enabled: true
      roundInterval: 8            # 每 8 轮反思一次
    surfing:
      enabled: true
      autoTrigger: true           # 自动定期冲浪
    debounce:
      enabled: true
```

可以定义多个 Bot，各有各的性格和配置。

## 编写性格

在 `prompts/bots/` 下创建 `.md` 文件，写你想让 Bot 成为什么样的存在。没有固定格式，随便写。

系统级的规则在 `prompts/system.md`，通常不需要改。

所有提示词支持热重载 — 改完直接生效，不用重启。

```
prompts/
├── system.md            # 核心规则（通常不用动）
├── bots/
│   └── my_bot.md        # 你的 Bot 性格
├── debounce-judge.md    # 防抖判断
├── review.md            # 自我反思
├── surfing.md           # 冲浪评估
└── surfing-eval.md      # 搜索结果评估
```

## 使用

### 聊天

打开网页，选一个 Bot，开始聊。

### 触发冲浪

在聊天中发送 `/surf`，Bot 会去互联网上搜索它认为你需要的信息，然后自然地跟你聊。

如果在 config 里开了 `autoTrigger`，它会自己定期去冲浪，不需要你手动触发。

### 清空对话

```bash
curl -X POST http://localhost:3456/api/conversations/reset \
  -H "Content-Type: application/json" \
  -d '{"userId":"你的userId","botId":"bot_id"}'
```

### Token 用量

点左下角「使用统计」查看各模型、各任务类型的 token 消耗和费用。

## 接入 Telegram / 飞书

除了网页聊天，每一个 Bot 都可以拥有自己的 Telegram 机器人账号和飞书应用——配置里有多少个 Bot，就对应多少个外部账号。防抖、冲浪、自我反思等能力在所有平台上一致工作。

平台配置写在对应 Bot 的条目下，形如：

```yaml
bots:
  alice:
    displayName: "Alice"
    promptFile: "alice.md"
    telegram:
      enabled: true
      token: ""                # 或环境变量 TELEGRAM_TOKEN_ALICE
      # webhookUrl: "https://host/webhook/telegram/alice"   # 不填则用 polling
    feishu:
      enabled: true
      appId: ""                # 或环境变量 FEISHU_APP_ID_ALICE
      appSecret: ""            # 或环境变量 FEISHU_APP_SECRET_ALICE
  bob:
    displayName: "Bob"
    promptFile: "bob.md"
    telegram:
      enabled: true
      token: ""                # 或环境变量 TELEGRAM_TOKEN_BOB
```

每个 Bot 在不同平台独立——Alice 在 Telegram 有自己的账号和头像，在飞书也有自己的应用。用户在 Telegram 里搜 `@alice_bot` 就是和 Alice 聊，搜 `@bob_bot` 就是和 Bob 聊，两边完全独立。

**环境变量命名规则：** `TELEGRAM_TOKEN_{BOT_ID}` / `FEISHU_APP_ID_{BOT_ID}` / `FEISHU_APP_SECRET_{BOT_ID}`，把 bot id 大写、非字母数字字符替换成 `_`。比如 bot id `alice` 对应 `TELEGRAM_TOKEN_ALICE`。

所有平台只接收**接入之后**的新消息，不会回溯历史。

### Telegram

每个想接入 Telegram 的 Bot 按以下步骤操作：

1. 在 Telegram 里找 [@BotFather](https://t.me/BotFather)，发 `/newbot` 创建一个机器人账号，拿到 `token`（形如 `1234:ABC...`）。给每个 Bot 都建一个独立账号。

2. 把 token 写进 `.env`（推荐）：

   ```
   TELEGRAM_TOKEN_ALICE=1234:ABC...
   TELEGRAM_TOKEN_BOB=5678:DEF...
   ```

   或者直接填进 `config.yaml` 对应 Bot 的 `telegram.token`（不推荐）。

3. 在该 Bot 的配置下打开 telegram：

   ```yaml
   bots:
     alice:
       # ...
       telegram:
         enabled: true
   ```

4. 启动服务。默认使用 **polling 模式**（长轮询 Telegram 拉消息），本地开发直接能用，不需要公网。每个 Bot 独立跑一个 polling 循环。

   部署到有公网的机器上时，可以给单个 Bot 设 `webhookUrl`，启动时自动调用 Telegram 的 `setWebhook`。URL 规则是 `https://host/webhook/telegram/{botId}`，比如 Alice 是 `https://your-domain.com/webhook/telegram/alice`。URL 必须是 HTTPS。

5. 在 Telegram 里搜对应的 Bot 用户名，发消息即可。发 `/surf` 可以手动触发冲浪。

### 飞书

每个想接入飞书的 Bot 按以下步骤操作：

1. 在[飞书开放平台](https://open.feishu.cn/app)创建一个「自建应用」，拿到 **App ID** 和 **App Secret**。每个 Bot 建独立的应用。

2. 在应用的「权限管理」里开启：
   - `im:message`（发送消息）
   - `im:message.p2p_msg`（接收单聊消息）
   - `im:message.group_at_msg`（接收群聊 @ 消息，可选）

3. 在「事件与回调」→「事件配置」里：
   - 请求地址设为 `https://your-domain.com/webhook/feishu/{botId}`（必须是公网 HTTPS）。比如 Alice 是 `https://your-domain.com/webhook/feishu/alice`。
   - 订阅事件：`接收消息 v2.0`（`im.message.receive_v1`）

4. 把凭证写进 `.env`：

   ```
   FEISHU_APP_ID_ALICE=cli_xxx
   FEISHU_APP_SECRET_ALICE=xxx
   FEISHU_APP_ID_BOB=cli_yyy
   FEISHU_APP_SECRET_BOB=yyy
   ```

5. 在该 Bot 的配置下打开 feishu：

   ```yaml
   bots:
     alice:
       # ...
       feishu:
         enabled: true
   ```

6. 启动服务。在每个飞书应用的「版本管理与发布」里发布应用，然后在飞书里与对应 Bot 单聊即可。群聊需要 @ 机器人。

飞书事件回调必须是公网地址。本地开发可以用 [ngrok](https://ngrok.com/)、[frp](https://github.com/fatedier/frp) 之类做一层内网穿透。

## 技术栈

Bun + Hono + SQLite + OpenRouter + Jina MCP + WebSocket

## License

MIT
