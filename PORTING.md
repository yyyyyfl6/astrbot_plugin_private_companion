# 移植说明

## 来源与授权

- 原作品：「我会永远陪着你」`astrbot_plugin_private_companion`，作者 **menglimi**，
  仓库 <https://github.com/menglimi/astrbot_plugin_private_companion>（本仓库 fork 时为 7.0.12，提交 `574f8d7`）。
- 原仓库未附开源许可证。本移植版**已获原作者授权**（授权由 fork 维护者 yyyyyfl6 取得，2026-11）。
  授权范围以原作者的答复为准；如需再分发或上架公共索引，请先与原作者确认。
- 2026-11 起本仓库改为**纯 QQ Agent 插件**：AstrBot 版的代码（`main.py`、`astrbot_host/`、`companion_v2/`、
  `pages/陪伴小屋/` 及其第三方许可、文档与测试）从工作树移出。它们完整保留在原仓库，以及本仓库的 git 历史里
  （最后一个包含 AstrBot 版的提交是 7.0.12 的 `574f8d7`：`git checkout 574f8d7` 即可取回）。原作者署名与致谢见 README。
- 移出的只是代码，不是功能路线：华为健康、米家这类依赖外部设备的能力暂不移植，原代码留在历史里，需要时再按 QQ Agent 的方式重写。

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
| 自我页角色档案（档案为空时回退到 AstrBot 人格） | 直接用**会话当前正在运行的人格**（QQ Agent 的人设 / 多人格，经宿主 `cap.context.persona`）；插件设置的「角色设定」作补充；生活 / 梦 / 成长按人格分开存 |
| Reality 的 Android 移动网关（`mobile_gateway.py`） | `phone.mjs`：同一套路由与响应信封（health / pair / status / snapshot / persona / location / heartbeat / revoke / device/status / device/activity / telemetry / screen/heartbeat / room/create / room/invite / room/join / room/prepare / game/room/create / session/close），会话令牌、配对限频、私密应用隐藏、短时过期同口径；经宿主 `inbound` 能力接收请求 |
| Together 一起房间（watch / novel / work / call） | `rooms.mjs` + `room.html`：一起看、一起读、一起工作（屏幕截图进房间、角色看图）；房间链接里的令牌即凭证（同原插件的 `/join/<令牌>`）；页面轮询代替 WebSocket；结束后一句话进背景与生活。不做视频 / 语音通话 |
| Game 陪伴游戏（井字棋 / 五子棋 / 象棋 / 掷骰竞分 / 二十一点 / 海龟汤 / 你画我猜） | `games.mjs`：前四种里除象棋外由代码判定与走子；海龟汤、你画我猜经副 API（你画我猜要能看图）。房间链接 `/room/<令牌>`，游戏名沿用 `native_v2:<游戏>`。不做中国象棋 |
| 手机屏幕共享（`screen/heartbeat`、工作协同） | 心跳同口径；新增 `POST /screen/frame` 推截图：有一起工作 / 一起看房间就进房间，否则每 10 分钟看一眼、记一句进背景；只留最新一帧在内存 |
| 地点变化通知（`host_delivery` 的 reality_location_event） | 到了新的有名字的地点 → 主动由头；另加"电量很低"由头 |
| 关系网熟人卡（称呼 / 关系 / 生日 / 相处方式）与按人细调 | `relations.mjs` 的 cards；每日反思自动追加印象；工具 `update_card`；卡上可设对 TA 的主动频率（跟随 / 少 / 多 / 关） |
| 每日记忆反思自动提取「互动纪念日」 | 写日记时同一次副 API 调用一并输出 impressions / anniversaries；日期取那天、按人去重 |
| Content 的梦境 | 起床后依据昨天的生活生成，上午进背景 |
| `followup_review`（未完话头不反复追问） | 问过的待跟进记进会话状态，不再重复 |
| 跨窗口自然承接（群 → 私聊） | 陪伴对象本人 30 分钟内的群发言进私聊背景（只放内存，不带其他群友） |
| 表达学习与审核（学习页：采纳 / 驳回 / 分享包） | `expressions.mjs`：别人的发言当素材（只放内存）→ 每日学习进待审 → 采纳后挂进背景；驳回 / 退役记住不再学；分享包导出导入 |
| 成长记录（role_work/growth） | `growth.mjs`：每天回顾这个人格昨天的生活，技能攒经验升级、记里程碑；参与排日程 |
| 多人格（QQ Agent 特有，原插件没有） | `handoff.mjs`：切换人格时补上宿主交接摘要之外陪伴这一侧的记录（旧人格的生活、今天主动过几次、问过的事），转述非亲历；日记标注当天是哪个人格陪的 |
| 陪伴小屋前端 | `page.html` + `page.mjs`：总览 / 关系网 / 日记与生活 / 纪念日 / 主动记录 / 手机（经宿主 `page` 能力，沙箱 iframe） |

## 依赖的宿主能力（QQ Agent 插件接口 apiVersion 3）

| 能力 | 用途 | 宿主侧限制 |
| --- | --- | --- |
| `llm` | 副 API：排日程、推进生活、写日记；房间里接话、出题、看图（图片输入） | 供应商取自控制台已添加的；Key 只在宿主解析；每天 300 次（`plugins.limits.llmDailyCalls`） |
| `context` | 把生活状态与日记挂进私聊背景；读会话当前人格 | 每段 ≤1500 字、有过期时间、停用插件即撤；按"第三方背景"标注；人格只读、角色卡截到 3000 字 |
| `wake` | 提示主模型主动联系 | 同一会话 ≥20 分钟、每天 30 次；白名单 / 作息 / 预算照常生效 |
| `inbound` | 接收安卓陪伴终端的请求；给手机打开的房间页面 | `/plugin-hooks/private-companion/…`，或本插件设置里打开的独立端口（默认 6322，只提供本插件路径）；宿主限体积（≤256KB）/ 频率 / 请求头（`X-Companion-Mobile-Token` 由本插件在 manifest `inbound.headers` 里声明），鉴权由插件的配对令牌做；HTML 只在独立端口上给，宿主加 CSP |
| `secrets` | 保存手机配对令牌 | 宿主 AES-256-GCM 加密，控制台不回显 |
| `page` | 「陪伴小屋」页面 | 沙箱 iframe（无 same-origin、CSP 断网），只能经宿主 RPC 调本插件 |
| `observe` / `schedule` / `storage` / `config` / `log` / `tools` | 收对方消息、5 分钟巡检、状态、设置、日志、两个工具 | 见 QQ Agent `docs/PLUGINS.md` |

## 路线（尚未移植）

- 按人细调免打扰时段（主动频率已经能按人调）；
- 内容创作（独立作品立项、章节续写）；
- 原插件首页的 3D 体素小屋（移植版用普通页面呈现同样的信息）；
- 视频 / 语音通话房间（要实时音视频链路）、中国象棋（要完整引擎）；高德逆地理（移植版直接用 App 上报的地点名）；
- 识屏（电脑桌面）、米家、华为健康、直播等依赖外部设备或 AstrBot 宿主的能力：暂时保留在路线上，原代码见 git 历史。

## 开发

```bash
node --test tests/*.test.mjs                                        # 核心逻辑、手机连接、房间与游戏单测
node <qq-agent-plus>/scripts/plugin-validate.mjs private-companion
node <qq-agent-plus>/scripts/plugin-pack.mjs private-companion --out dist --min-version 0.9.12
```
