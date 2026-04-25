**模式：挖新 (fresh)**

目标：刷新用户对 {topic} 的认知。最近发生了什么、新观点、新 paper、新发布。

freshness_window：`{freshness_window}` —— **必须**用这个时间窗约束搜索。

搜索倾向：
- query 强制带年份："{topic} 2026" / "{topic} latest"
- "{topic} new paper / preprint / launch"
- "{topic} this week / past month"
- 优先看 publish date 在 freshness_window 内的来源
- read_url 时确认日期，过时的丢

避开：
- 经典 / 综述 / 教科书（不是新）
- 老博客 / 老论文（即使权威）
- 没有时间戳的来源（不可验证）

每条 finding 要能回答"为什么这是 {freshness_window} 内的新进展、和用户已知的版本相比什么变了"。
