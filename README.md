<p align="center">
  <img src="docs/app-icon.png" width="128" alt="大绿豆 应用图标" />
</p>

<h1 align="center">大绿豆 · PendingBot</h1>

<p align="center">
  一个有主动性的 AI 朋友 — 主动对话、自己冲浪、不拍马屁。
  <br />
  <em>An AI companion with initiative — proactive, web-surfing, never sycophantic.</em>
</p>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/syncmeta/PendingBot?color=blue" /></a>
  <a href="https://bun.sh"><img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-fbf0df?logo=bun&logoColor=black" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/lang-TypeScript-3178c6?logo=typescript&logoColor=white" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Web%20%7C%20iOS-lightgrey" />
</p>

<p align="center">
  <a href="README.md">中文</a> · <a href="README_EN.md">English</a>
</p>

---

## ✨ 这是什么

两大目标：

- 🗣️ **和人自然地交流 主动对话 不谄媚** — 和微信聊天一样，让它心里有你，不拍你马屁
- 🌊 **审视自我 探索未知 做信息的 VC** — 自己上网冲浪，从使用者的利益出发，寻找他真正需要的东西

不是助手类工具——助手类应用大把人做。也不是标准的 AI 陪伴——解决的需求不在于缺爱了想找 AI 陪。我期望它能给我推送我认知以外、又真正需要的东西。

## 🚀 核心特性

| | |
|---|---|
| 🧠 **主动对话** | 微信式语气、防抖打断、自我反思（每 N 轮反观一次最近聊天） |
| 🌊 **网络冲浪** | 主动搜索 + 深挖 + 漫游 + curator 筛选，把真正有价值的东西讲给你听 |
| 👥 **多 Bot 共存** | 每个 Bot 有自己的性格 / 模型 / 访问权限，可一人一养也可几人共养 |
| 🌐 **跨端** | Web（响应式）+ 原生 iOS（SwiftUI） |
| 🎯 **OpenRouter 模型路由** | 任意模型组合：主对话 / 防抖 / 反思 / 冲浪 / 标题各自独立配置 |
| 🛠️ **Agent Skills** | 内置 Anthropic skill-creator 等预设，亦可自写 Markdown 技能 |
| 🧩 **热重载提示词** | `apps/api/prompts/` 下任意 `.md` 改完即生效 |
| 🔐 **BYOK** | 用户可填自己的 OpenRouter Key，不吃服务方额度 |
| 🪪 **Clerk 鉴权（可选）** | hosted 模式 Sign in with Apple / Google / Email Code；自部署仍走邀请码 |

## 📂 仓库结构

```
PendingBot/                  bun workspaces 单仓
├── apps/
│   ├── api/                 Bun + Hono 后端（核心代码）
│   ├── web/                 React + Vite + TS 前端（重写中，骨架）
│   ├── site/                pendingname.com 占位页
│   └── ios/                 SwiftUI 原生 iOS app
├── packages/
│   └── shared-types/        前后端共用类型 / zod schema
├── docs/
│   ├── self-hosting.md      自部署指引
│   └── deploy.md            托管部署指引
└── README.md                你正在看的这份
```

## 🚀 自部署 quickstart

零外部账号，本地就能跑：

```bash
git clone https://github.com/syncmeta/PendingBot.git
cd PendingBot
bun install                                  # 整仓一次性装好
cp apps/api/.env.example apps/api/.env       # 只需填 OPENROUTER_API_KEY
bun run dev:api                              # 启动后端
```

打开控制台打印的 `http://localhost:3456/i/...` 链接 → 创建 admin 账号 → 开始聊。
完整选项见 [docs/self-hosting.md](docs/self-hosting.md)。

## ☁️ 托管部署（hosted）

把同一份代码部署到 Fly.io + Cloudflare + Turso/R2 + Clerk 的全套方案见
[docs/deploy.md](docs/deploy.md)。机器月成本 ~$3，账户体系、附件存储、
DDoS / WAF 全部由托管服务覆盖。`bot.pendingname.com` 是这套方案的实例。

适配器层让两种模式共用一份代码：env 没设 → 用本地 SQLite + 本地盘 + 邀请码；
env 设了 → 切到 Turso（暂定）/ R2 / Clerk。改 env 就能切，不改代码。

## ⚙️ 配置 Bot

编辑 `apps/api/config.yaml`：

```yaml
server:
  port: 3456
  host: "0.0.0.0"
  publicURL: "https://bot.pendingname.com"   # hosted 模式填这里

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
    displayName: "起个名字"
    promptFile: "my_bot.md"
    accessMode: "private"
    creators: ["user_id_1"]
    review:  { roundInterval: 4 }
    surfing: { autoTrigger: true }
```

完整 schema：[apps/api/src/config/schema.ts](apps/api/src/config/schema.ts)。

## 🎭 编写性格

在 `apps/api/prompts/bots/` 下创建 `.md`，写你想让 Bot 成为什么样的存在。
随便写，没固定格式。仓库自带 `default.md` 作为示例。所有提示词热重载，
不用重启。

```
apps/api/prompts/
├── system.md              核心规则：微信风格（默认）
├── system-normal.md       核心规则：标准 AI 风格
├── bots/                  Bot 性格
├── review.md              自我反思
├── surfing-*.md           冲浪管线各阶段
├── debate.md              多 Bot 议论
├── portrait/              用户画像
└── title.md               对话标题生成
```

## 💬 使用

- **聊天**：打开网页选一个 Bot 开始
- **冲浪**：发 `/surf` 触发；config 里开 `autoTrigger` 后自动定期跑
- **token 用量**：左下角「使用统计」
- **配额 / BYOK**：「你」→ 设置 → 自带 OpenRouter Key（可选）

## 📱 接入 iOS

原生 SwiftUI，位于 [apps/ios/](apps/ios/PendingBot/)，覆盖 6 个 tab：消息 /
议论 / 冲浪 / 回顾 / 画像 / 你。生成 Xcode 工程：

```bash
brew install xcodegen
cd apps/ios && xcodegen generate
open PendingBot.xcodeproj
```

第一次打开 Xcode 选 Signing Team。运行后首次启动**三选一导入服务**：扫码 /
粘贴登录码 / 手动输入。详见 [apps/ios/README.md](apps/ios/README.md)。

## 🛠️ 技能（Skills）

「我」标签页里的「技能」区域，管理 Anthropic 风格的 [Agent Skills](https://github.com/anthropics/skills)。
首次打开会播种 6 条预设（默认未启用），全部来自 [anthropic/skills](https://github.com/anthropics/skills)（Apache-2.0），
原文存在 [apps/api/prompts/skills/anthropic/](apps/api/prompts/skills/anthropic/)。

## 🧱 技术栈

<p>
  <img alt="Bun" src="https://img.shields.io/badge/Bun-fbf0df?logo=bun&logoColor=black" />
  <img alt="Hono" src="https://img.shields.io/badge/Hono-E36002?logo=hono&logoColor=white" />
  <img alt="SQLite" src="https://img.shields.io/badge/SQLite-003B57?logo=sqlite&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-61DAFB?logo=react&logoColor=black" />
  <img alt="Swift" src="https://img.shields.io/badge/Swift-F05138?logo=swift&logoColor=white" />
</p>

- **后端**：Bun + Hono + SQLite + OpenRouter + WebSocket
- **Web**：React + Vite + Tailwind + shadcn/ui + TanStack Query
- **iOS**：Swift + SwiftUI + XcodeGen
- **托管侧**：Fly.io（API） + Cloudflare（DNS/WAF/Pages/R2） + Clerk（Auth）

## 🙏 致谢

- 运行时：[Bun](https://bun.sh) MIT · [Hono](https://hono.dev) MIT ·
  [OpenAI Node SDK](https://github.com/openai/openai-node) Apache-2.0 ·
  [Honcho SDK](https://github.com/plastic-labs/honcho) Apache-2.0 ·
  [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) MIT ·
  [Zod](https://github.com/colinhacks/zod) MIT · [yaml](https://github.com/eemeli/yaml) ISC ·
  [node-qrcode](https://github.com/soldair/node-qrcode) MIT
- 外部服务：[OpenRouter](https://openrouter.ai) · [Jina AI](https://jina.ai)（可选）·
  Apple Push Notification service（可选）
- 预设技能：[anthropic/skills](https://github.com/anthropics/skills) Apache-2.0 ©
  Anthropic, PBC，详见 [NOTICE](apps/api/prompts/skills/anthropic/NOTICE.md)

## 🤝 贡献

欢迎 Issue 和 PR。提交前简单聊一下想法会更顺利，尤其是提示词 / 冲浪管线 /
跨端协议这类核心改动。

## 📄 License

[MIT](LICENSE)。第三方组件遵循各自原协议（见上）。

---

<p align="center">
  Made with 💚 for people who want a friend that pushes back, not a tool that nods along.
</p>
