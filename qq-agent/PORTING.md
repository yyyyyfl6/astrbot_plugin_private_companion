# 移植说明

## 来源与授权

- 原作品：「我会永远陪着你」`astrbot_plugin_private_companion`，作者 **menglimi**，
  仓库 <https://github.com/menglimi/astrbot_plugin_private_companion>（本仓库 fork 时为 7.0.12，提交 `574f8d7`）。
- 原仓库未附开源许可证。本移植版**已获原作者授权**（授权由 fork 维护者 yyyyyfl6 取得，2026-11）。
  授权范围以原作者的答复为准；如需再分发或上架公共索引，请先与原作者确认。
- 仓库根目录的原有代码、文档、署名、致谢与第三方许可（`pages/陪伴小屋/assets/*LICENSE*` 等）全部原样保留，
  移植版只新增 `qq-agent/` 目录，不改动原文件。

## 移植思路

原插件运行在 AstrBot 上：普通回复走 AstrBot 主管线，插件用独立的后台任务预算"间断唤醒"，
维护角色的状态、日程、日记与主动候选，以此模拟一个连续生活的角色。

QQ Agent 自身就是连续对话的工作流（会话线程、主动开话题、自安排唤醒都在主链路里），所以移植版：

1. **用副 API 生成并维护一个长任务**（角色当天的生活：日程 → 不规则推进 → 经历 / 心情 / 想说的念头），
   通过插件接口 v3 的 `cap.context.set` 挂进陪伴对象的私聊背景；
2. **经过不规则的时间提示主模型主动发消息**（`cap.wake.request`，走 QQ Agent 的 proactive 唤醒），
   由主模型按人设决定发不发、说什么；
3. 私聊日记由 `observe` 收集对方原话、副 API 每日定稿（`cap.llm.complete`），最近几天进背景，
   更早的用 `recall_diary` 检索。

对应原插件的概念：

| 原插件 | 移植版 |
| --- | --- |
| 今日「节目单」日程、状态演进 | `life:<日期>`：plan / log / mood / thoughts（副 API 生成与推进） |
| 主动联系候选 → 免打扰 / 起床宽限 / 频率闸门 → 人格复核 → 投递 | `decide()`：免打扰、每日上限、没回不追、刚聊过不打扰 → `wake` 交给主模型（主模型即"人格复核"） |
| 未完话头 `followup_review` | 日记里的 `followups`，次日作为主动由头 |
| 日记 | `diary:<QQ>`，按日期，保留 30 天 |
| 自我页角色档案 | 插件设置「角色名 / 角色设定」（只给后台任务用，主对话人设不变） |

## 依赖的宿主能力（QQ Agent 插件接口 apiVersion 3）

| 能力 | 用途 | 宿主侧限制 |
| --- | --- | --- |
| `llm` | 副 API：排日程、推进生活、写日记 | 供应商取自控制台已添加的；Key 只在宿主解析；每天 300 次（`plugins.limits.llmDailyCalls`） |
| `context` | 把生活状态与日记挂进私聊背景 | 每段 ≤1500 字、有过期时间、停用插件即撤；按"第三方背景"标注 |
| `wake` | 提示主模型主动联系 | 同一会话 ≥20 分钟、每天 30 次；白名单 / 作息 / 预算照常生效 |
| `observe` / `schedule` / `storage` / `config` / `log` / `tools` | 收对方消息、5 分钟巡检、状态、设置、日志、两个工具 | 见 QQ Agent `docs/PLUGINS.md` |

## 路线（尚未移植）

- 关系网熟人卡（称呼 / 关系 / 生日 / 相处方式）与按人细调；
- 互动纪念日（每日反思自动提取）、梦境；
- 插件自带页面（陪伴小屋风格的状态 / 日程 / 日记视图；目前用宿主渲染的设置页 + 「检测」）；
- 识屏、手机网关、米家、华为健康、直播、游戏等依赖外部设备或 AstrBot 宿主的能力。

## 开发

```bash
node --test qq-agent/tests/                                         # 核心逻辑单测
node <qq-agent-plus>/scripts/plugin-validate.mjs qq-agent/private-companion
node <qq-agent-plus>/scripts/plugin-pack.mjs qq-agent/private-companion --out qq-agent/dist --min-version 0.9.12
```
