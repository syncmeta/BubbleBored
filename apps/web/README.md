# @pendingbot/web

PendingBot 网页端（React + Vite + TS + Tailwind + shadcn/ui）。

部署到 Cloudflare Pages，对外地址 `https://bot.pendingname.com/`。
通过 Cloudflare Worker 路由把 `/api/*`、`/ws*`、`/uploads/*` 反代到 API
服务（apps/api，部署在 Fly.io），所以浏览器视角下都是同源请求 — 没有
CORS 问题、cookie 鉴权直接生效。

## 状态

骨架已就位（package.json + 占位）。实际页面（消息 / 议论 / 冲浪 / 回顾 /
画像 / 你 / 设置）按计划文档分阶段从 `apps/api/src/web/static/` 旧版迁移。

## 本地起服

```bash
bun install      # 在仓库根跑一次即可
bun run dev:web  # vite dev server，通常 5173 端口
```

需要后端同时跑：另一个终端 `bun run dev:api`。
