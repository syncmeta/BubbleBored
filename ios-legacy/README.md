# PendingBot iOS

原生 SwiftUI thin client。和 `main/` 服务端通过 Bearer Key 鉴权,数据按
key 隔离。覆盖六个 tab:消息 / 议论 / 冲浪 / 回顾 / 画像 / 你。

## 一次性设置

```bash
brew install xcodegen      # 一次
cd ios
xcodegen generate          # 生成 PendingBot.xcodeproj
open PendingBot.xcodeproj
```

第一次打开 Xcode 后:

1. 左侧选中 `PendingBot` target → **Signing & Capabilities** → 选你的 Apple Developer Team。
2. (可选) 如果想用 Universal Links,在 **Signing & Capabilities** 里加
   **Associated Domains**,写 `applinks:你的服务器域名`,服务端的
   `/.well-known/apple-app-site-association` 已经返回正确格式 — 把
   `TEAMID.com.pendingname.pendingbot` 里的 `TEAMID` 替换成你的 Team ID。

不配 Universal Links 也能用,自定义 scheme `pendingbot://` 兜底,加二维码扫描 + 粘贴链接 + 手动输入。

## 跑起来

1. 启动后端:`cd ../main && bun run dev`(端口 3456)。
2. 浏览器打开 `http://localhost:3456`,进 **钥匙** tab,创建一把 key,记下完整 key 或扫码二维码。
3. Xcode 选模拟器 → ⌘R 运行。
4. 模拟器弹出欢迎页:
   - **手动输入** — 服务器填 `http://你的Mac的局域网IP:3456`(模拟器里 `localhost` 也行),钥匙粘上面那串
   - **粘贴分享链接** — 复制 web 面板的分享 URL 到剪贴板,模拟器选这个入口,字段会自动预填
   - **扫描二维码** — 模拟器没有摄像头,真机走这个

## 项目结构

```
PendingBot/
  PendingBotApp.swift          # @main + Universal Link / custom scheme 处理
  Models/
    Account.swift              # server URL + key (Keychain)
    APIModels.swift            # REST 响应类型
  Networking/
    APIClient.swift            # async/await REST + bearer 注入 + multipart 上传
    WebSocketClient.swift      # /ws/mobile?key=...,自动重连
    SSEClient.swift            # text/event-stream 解析
    Connect.swift              # 分享链接 redeem + health probe
  Storage/
    Keychain.swift             # Security.framework 包装
    AccountStore.swift         # 多账号 + currentAccount
  Features/
    Onboarding/                # 欢迎页 + QR / 粘贴 / 手动 三种导入
    Root/TabRoot.swift         # 6 个 TabItem
    Message/                   # 主聊天 (WS streaming + 图片上传)
    Debate/                    # 多模型辩论 (SSE)
    Surf/                      # 深挖搜索 (SSE)
    Review/                    # 自审回顾 (SSE)
    Portrait/                  # 画像生成 (SSE)
    Me/                        # 资料 / 收藏 / 服务器切换
  Components/
    Haptics.swift              # 统一震动反馈
    MarkdownText.swift         # swift-markdown-ui 包装
    ServerImage.swift          # /uploads/<id> 异步加载
  Resources/
    Info.plist                 # ATS 放开 + URL scheme
    Assets.xcassets/           # AppIcon + AccentColor
```

## iOS 体验

- **Haptics** — 发送 / 接收第一段 / 切 tab / 成功 / 错误 都有不同震动
- **Pull-to-refresh** — 各列表都支持
- **Swipe Actions** — 列表项左划删除
- **Context Menu** — 长按消息可复制 / 分享 / 删除
- **PhotosPicker** (iOS 17) — 多选图片,边选边上传
- **Keychain** — Bearer key 加密存储,`afterFirstUnlockThisDeviceOnly` 不跨设备同步
- **多账号** — 你 → 当前服务器 → 切换,保留所有 key
- **流式渲染** — WS 收到 chunk 立刻追加,自动滚到底
- **Markdown** — bot 消息走 swift-markdown-ui,代码块高亮 + 引用 + 列表
- **暗黑模式** — 跟随系统
- **Universal Link + 自定义 scheme** — `pendingbot://` 兜底,装了 app 直接跳

## 已知限制 / 后续

- **APNs 推送** — 服务端 `device_tokens` 表已就位,但 push 通道还没接 — 需要 Apple Developer 账号 + APNs key 才能联调。`POST /api/mobile/push/register` 已可调用(目前只入库)。
- **后台 WS** — iOS app 进入后台 ~30s 后系统会断 WS;前台再次激活时自动重连。完整后台体验依赖 APNs。
- **附件下载** — 图片走 `/uploads/<id>`,immutable + max-age=1y,URLSession 自动用 HTTP 缓存。
- **Universal Link 域名** — 自部署服务器域名不固定,所以默认不开;需要的话改 `project.yml` 里的 associated-domains。
