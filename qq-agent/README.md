# 我会永远陪着你 · QQ Agent 移植版

> **原作**：[menglimi](https://github.com/menglimi) 的 AstrBot 插件
> [「我会永远陪着你」astrbot_plugin_private_companion](https://github.com/menglimi/astrbot_plugin_private_companion)
> （本仓库 fork 自原仓库，原有代码、文档、署名与致谢全部保留在仓库根目录）。
> **移植**：yyyyyfl6，把原插件的核心思路做成 [QQ Agent](https://github.com/yyyyyfl6/qq-agent-plus) 的插件。
> 移植已获原作者授权，见 [PORTING.md](PORTING.md)。原作者的问题反馈 / 交流群：QQ 群 `1097283005`，
> 自愿支持：[爱发电](https://ifdian.net/a/xuhaun)。

## 它做什么

原插件在 AstrBot 上用后台任务"间断唤醒"来模拟角色的连续生活。QQ Agent 本身就是连续对话的工作流，
所以移植版只保留核心思路，用**副 API 维护一个持续进行的长任务**，再**按不规则的时间提示主模型主动发消息**：

| | 怎么做 |
| --- | --- |
| **生活长任务** | 副 API 每天按「角色设定」排一份节目单日程；之后每隔一段（围绕「生活推进间隔」上下浮动）推进一次：刚发生了什么、心情、有没有想跟对方说的念头。状态一直挂在陪伴对象的私聊背景里，主模型每轮都知道自己正过着怎样的一天 |
| **主动联系** | 每次在「最少 ~ 最多间隔」之间随机取下一次时间（不规则）。由头依次来自：起床后的早安 → 生活里攒下的念头 → 昨天日记里的待跟进 → 久未联系。只是**提示主模型**来一次主动唤醒，发不发、说什么由主模型按人设决定 |
| **分寸** | 免打扰时段不动；每人每天有上限；上一条对方没回，24 小时内不再追；对方正在聊时自动往后推 |
| **私聊日记** | 记下每天对方说过的话，第二天凌晨由副 API 写成"那天发生了什么 + 待跟进"，最近几天进背景，更早的由模型用 `recall_diary` 按日期 / 关键词翻 |
| **工具** | `life_status`（对方问"你在干嘛 / 今天过得怎样"时以它为准）、`recall_diary` |

主对话的人设、模型、记忆都不受影响：插件只给背景、只提请求；白名单、作息、观察 / 暂停模式、
每日预算等守卫都在 QQ Agent 原有的链路上。

## 安装

需要 QQ Agent **0.9.12+ 且支持插件接口 apiVersion 3**（`llm` / `context` / `wake` 三项能力，
见 qq-agent-plus 的 `docs/PLUGINS.md`）。

1. 控制台左侧「插件」→ 打开「启用插件功能」；
2. 「手动安装」选 [`dist/private-companion-0.1.0.tar.gz`](dist/private-companion-0.1.0.tar.gz)
   （sha256 `1a74bbd54a21f9bd2a4e93c03ec3bdfa1d86c3f111b927622c93f6743905d946`），
   或填它的直链 + sha256（见 [`index-entry.json`](index-entry.json)）；
3. 在「已装」里点「启用」，打开插件设置填：
   - **陪伴对象 QQ**（最多 4 个，只陪这些人的私聊）；
   - **副 API**：供应商 id（设置 → 模型 API 的供应商卡片上）和模型，建议选便宜的；
   - **角色名 / 角色设定**：给副 API 排生活用，几句话即可；
   - 主动联系的间隔、每日上限、免打扰时段。

启用后每 5 分钟巡检一次；在插件详情里点「检测」能看到今天的日程、此刻状态与每个人的下一次主动时间。

## 目录

```
qq-agent/
├── private-companion/     插件本体（零依赖 Node，QQ Agent 插件协议）
│   ├── plugin.json        manifest（apiVersion 3、设置 schema、工具、周期任务）
│   ├── index.mjs          协议入口（NDJSON over stdio）
│   └── companion.mjs      核心逻辑：生活长任务 / 主动决策 / 日记
├── tests/                 node --test qq-agent/tests/
├── dist/                  打好的安装包
├── index-entry.json       插件索引条目（可贴进自己的索引）
└── PORTING.md             来源、授权与改动说明
```

## 和原插件的差别

移植版是"核心思路的重写"，不是逐行翻译：原插件约 17 万行 Python + 11 万行前端（陪伴小屋），
大量功能依赖 AstrBot 宿主或外部设备。目前移植了生活长任务、主动联系、私聊日记三块；
其余（关系网熟人卡、表达学习、识屏 / 手机 / 米家、直播、游戏、陪伴小屋前端等）见 PORTING.md 的路线。
