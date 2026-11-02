// 手机连接（移植自原插件 Reality 的 Android 移动网关 astrbot_host/native_extensions/reality/mobile_gateway.py，
// 原作 menglimi）：配套的安卓「陪伴终端」把对方手机的前台位置、设备状态、正在用的应用、运动健康摘要推过来，
// 角色据此知道"对方此刻在哪、在干嘛"；也从手机上开一起房间、玩游戏、共享屏幕。
//
// 协议与原网关一致（同一个 App 能直接连）：响应信封 { ok, data } / { ok:false, message }；
//   GET  /health                 免鉴权的存活检查
//   POST /pair                   配对令牌 → 会话令牌（7 天）
//   GET  /status  /snapshot      当前快照
//   GET  /persona  POST /persona  手机上对角色的称呼（≤12 字；不设就用当前人格的名字）
//   POST /location  /location/heartbeat  /location/revoke
//   POST /device/status  /device/activity  /telemetry
//   POST /room/create  /room/invite  /room/join  /room/prepare  /game/room/create   一起房间与游戏（rooms.mjs）
//   POST /screen/heartbeat       屏幕共享状态；POST /screen/frame（移植版新增）推一帧截图
//   POST /session/close
// 令牌放 X-Companion-Mobile-Token 或 Authorization: Bearer。路径前缀
// /astrbot_plugin_private_companion.reality/mobile、/astrbot_plugin_reality_companion/mobile 也认。
// 房间页面 /room/<令牌>、/join/<令牌> 与接口 /api/room/<令牌>/… 凭房间令牌访问（同原插件），只在独立端口上提供。
// 不做：视频 / 语音通话（要实时音视频链路）、中国象棋；米家、华为健康等要接别的设备的能力暂不移植。
//
// 隐私（与原网关同口径）：位置 / 设备 / 活动 / 健康 / 屏幕只放内存、按时过期，插件重启即清；
// 交给模型的是"地点名 / 标签 + 粗粒度状态"，不给坐标；私密类应用（银行、密码、聊天…）一律显示成"私密应用"；
// 屏幕截图只留最新一帧在内存里，看完只记一句"TA 在做什么"（要求副 API 不写聊天内容、账号、金额）。
import crypto from 'node:crypto';
import { GAMES } from './games.mjs';
import { TOGETHER_MODES, originOf, roomPage, validImage } from './rooms.mjs';

const API_VERSION = '1.0';
const SESSION_TTL_MS = 168 * 3600_000;
const MAX_SESSIONS = 8;
const LOCATION_TTL_MS = 15 * 60_000;
const DEVICE_TTL_MS = 24 * 3600_000;
const ACTIVITY_TTL_MS = 15 * 60_000;
const TELEMETRY_TTL_MS = 3600_000;
const SCREEN_ONLINE_MS = 90_000;
const SCREEN_DESC_TTL_MS = 15 * 60_000;
const MAX_AGE_MS = 10 * 60_000;
const PREFIXES = ['/astrbot_plugin_private_companion.reality/mobile', '/astrbot_plugin_reality_companion/mobile', '/mobile'];
const ACTIVITY_CATEGORIES = new Set(['video', 'music', 'browser', 'game', 'social', 'work', 'reading', 'private', 'other']);
const PRIVATE_MARKERS = ['bank', 'finance', 'wallet', 'password', 'authenticator', 'otp', 'mail', 'email', 'message', 'sms', 'chat', 'wechat', 'qq', 'telegram', 'signal', 'whatsapp', 'gov', 'health'];
const LABEL_BLOCKLIST = ['忽略', '系统提示', '提示词', '指令', 'prompt', 'instruction', '执行命令'];
const CATEGORY_LABEL = { video: '看视频', music: '听音乐', browser: '浏览网页', game: '玩游戏', social: '刷社交软件', work: '工作 / 学习', reading: '阅读', private: '用私密应用', other: '用手机' };

const clean = (v, n = 160) => String(v ?? '').replace(/\0/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const ok = (data, status = 200) => ({ status, body: { ok: true, data } });
const err = (message, status = 400) => ({ status, body: { ok: false, message: clean(message, 240) } });
const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const label = (v, n = 80) => { const s = clean(v, n); return s && !LABEL_BLOCKLIST.some((m) => s.toLowerCase().includes(m)) ? s : ''; };
const ident = (v, n = 40) => { const s = clean(v, n).toLowerCase(); return /^[a-z0-9_.-]+$/.test(s) ? s : ''; };
/** 毫秒 / 秒都认；离现在超过 maxAge 视为过旧。返回毫秒或 0。 */
function stamp(v, now, maxAge = MAX_AGE_MS) {
  let t = num(v, now / 1000);
  if (t < 1e11) t *= 1000;
  return Math.abs(now - t) <= maxAge ? t : 0;
}

export class Phone {
  /**
   * host：{ get, set, secret(key) }；settings()：当前插件设置（readSettings 之后）；
   * onUpdate(uin, { kind, event })：有新数据时回调（刷新背景 / 产生主动由头）
   */
  constructor({ host, settings, rooms = null, personaName = async () => '', onUpdate = () => {}, now = () => Date.now(), log = () => {} } = {}) {
    this.host = host;
    this.rooms = rooms;
    this.personaName = personaName;
    this.settingsOf = settings;
    this.onUpdate = onUpdate;
    this.now = now;
    this.log = log;
    this.state = new Map();      // uin -> { location, device, activity, telemetry, lastPlace, lastBatteryAlertAt }
    this.pairHits = new Map();   // remoteAddr -> [ts]
  }

  #st(uin) {
    if (!this.state.has(uin)) this.state.set(uin, {});
    return this.state.get(uin);
  }

  async #sessions() {
    const raw = await this.host.get('phone:sessions');
    const now = this.now();
    const out = {};
    for (const [k, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) if (v && v.expiresAt > now) out[k] = v;
    return out;
  }

  #token(headers = {}) {
    const direct = clean(headers['x-companion-mobile-token'], 240);
    if (direct) return direct;
    const auth = clean(headers.authorization, 260);
    return /^bearer /i.test(auth) ? auth.slice(7).trim().slice(0, 240) : '';
  }

  async #auth(headers) {
    const token = this.#token(headers);
    if (!token) return null;
    const sessions = await this.#sessions();
    const s = sessions[hashToken(token)];
    if (!s) return null;
    const settings = this.settingsOf();
    if (!settings.targets.includes(s.uin)) return null;   // 陪伴对象被移除后，旧会话随之失效
    return { ...s, key: hashToken(token) };
  }

  #pairLimited(addr) {
    const t = this.now();
    const list = (this.pairHits.get(addr) || []).filter((x) => t - x < 60_000);
    const limited = list.length >= 8;
    if (!limited) list.push(t);
    this.pairHits.set(addr, list);
    return limited;
  }

  /** 宿主 inbound 转来的一条请求 → { status, body }。 */
  async handle(request = {}) {
    const settings = this.settingsOf();
    let path = String(request.path || '/');
    for (const p of PREFIXES) if (path.startsWith(`${p}/`) || path === p) { path = path.slice(p.length) || '/'; break; }
    path = path.replace(/\/+$/, '') || '/';
    const method = String(request.method || 'GET').toUpperCase();
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    if (path === '/health' && method === 'GET') {
      return ok({ service: 'reality_companion_mobile', api_version: API_VERSION, pairing_required: true, owner: 'astrbot_plugin_private_companion', execution_path: 'qq_agent_plugin', gateway_version: 'qq-agent-0.6.0' });
    }
    if (!settings.phoneEnabled) return err('手机连接未在插件设置里启用', 409);
    // 房间页面与房间接口：凭房间令牌（链接本身就是凭证），不要会话令牌
    const page = /^\/(room|join)\/([A-Za-z0-9_-]{32,64})$/.exec(path);
    if (page && method === 'GET') return this.#roomPage(request, page[2]);
    const api = /^\/api\/room\/([A-Za-z0-9_-]{32,64})\/(state|action)$/.exec(path);
    if (api) return this.#roomApi(request, api[1], api[2], method, body);
    if (path === '/pair' && method === 'POST') return this.#pair(request, body);
    const auth = await this.#auth(request.headers);
    if (!auth) return err('未授权的移动端请求', 401);
    const uin = auth.uin;
    switch (`${method} ${path}`) {
      case 'GET /status':
      case 'GET /snapshot':
        return ok(this.status(uin, auth, request));
      case 'GET /persona': return { status: 200, body: { ok: true, ...(await this.#persona(uin)) } };
      case 'POST /persona': {
        const name = body.bot_name;
        if (typeof name !== 'string' || !name.trim() || name.trim().length > 12 || /[\r\n\0]/.test(name)) return err('称呼应为 1 到 12 个字符');
        await this.host.set(`phone:alias:${uin}`, name.trim());
        return { status: 200, body: { ok: true, bot_name: name.trim(), source: 'mobile_alias' } };
      }
      case 'POST /room/create': return this.#createRoom(request, uin, body, 'together');
      case 'POST /game/room/create': return this.#createRoom(request, uin, body, 'game');
      case 'POST /room/prepare': {
        const blocker = this.#roomsBlocker(request);
        return blocker ? err(blocker, 409) : ok({ ready: true });
      }
      case 'POST /room/invite': {
        const blocker = this.#roomsBlocker(request);
        if (blocker) return err(blocker, 409);
        const r = this.rooms.invite(uin, { token: clean(body.room_token, 80), expiresIn: body.expires_in_seconds });
        return r.error ? err(r.error, r.status) : ok({ ...r, request_id: body.request_id ?? null });
      }
      case 'POST /room/join': {
        const blocker = this.#roomsBlocker(request);
        if (blocker) return err(blocker, 409);
        if (!clean(body.invitation_id, 40)) return err('必须提供 invitation_id');
        const r = this.rooms.join(uin, body.invitation_id);
        if (r.error) return err(r.error, r.status);
        const url = this.#roomUrl(request, r.room, 'join');
        return url ? ok({ join_url: url, mode: r.room.type, label: r.room.label, request_id: body.request_id ?? null }) : err('拼不出房间地址：插件设置里填一下「房间公开地址」', 409);
      }
      case 'POST /screen/heartbeat': return this.#screenHeartbeat(uin, body);
      case 'POST /screen/frame': return this.#screenFrame(uin, body);
      case 'POST /location': return this.#location(uin, body);
      case 'POST /location/heartbeat': {
        const st = this.#st(uin);
        if (!st.location) return err('当前没有可保活的位置，请重新获取定位', 409);
        st.location.receivedAt = this.now();
        return ok(this.locationSnapshot(uin));
      }
      case 'POST /location/revoke':
        delete this.#st(uin).location;
        this.onUpdate(uin, { kind: 'location' });
        return ok({ revoked: true });
      case 'POST /device/status': return this.#device(uin, body);
      case 'POST /device/activity': return this.#activity(uin, body);
      case 'POST /telemetry': return this.#telemetry(uin, body);
      case 'POST /session/close': {
        const sessions = await this.#sessions();
        delete sessions[auth.key];
        await this.host.set('phone:sessions', sessions);
        return ok({ closed: true });
      }
      default:
        return err('这个功能在 QQ Agent 移植版里还没有', 409);
    }
  }

  // ── 人格称呼 ──

  async #persona(uin) {
    const alias = clean(await this.host.get(`phone:alias:${uin}`), 12);
    if (alias) return { bot_name: alias, source: 'mobile_alias' };
    const name = clean(await this.personaName(uin).catch(() => ''), 12);
    return name ? { bot_name: name, source: 'qq_agent_persona' } : { bot_name: '', source: 'unavailable' };
  }

  // ── 一起房间与游戏（rooms.mjs） ──

  #roomsBlocker(request = {}) {
    const s = this.settingsOf();
    if (!this.rooms) return '这个版本没有房间功能';
    if (!s.roomsEnabled) return '一起房间 / 游戏没在插件设置里打开';
    if (request.via !== 'port') return '一起房间 / 游戏的页面只在独立端口上提供：插件设置 → 手机连接 → 勾「给手机单开一个端口」，App 里网关地址填 http://服务器:端口';
    return '';
  }

  #roomUrl(request, room, prefix) {
    const origin = originOf(request, this.settingsOf().publicBaseUrl);
    return origin ? `${origin}/${prefix}/${room.token}` : '';
  }

  #createRoom(request, uin, body, kind) {
    const blocker = this.#roomsBlocker(request);
    if (blocker) return err(blocker, 409);
    let type;
    if (kind === 'game') {
      type = clean(body.game_type, 40).replace(/^native_v2:/, '');
    } else {
      type = clean(body.mode, 16).toLowerCase() || 'watch';
      if (type === 'call') return err('视频 / 语音通话要实时音视频链路，移植版暂不提供（可以开「一起看 / 一起读 / 一起工作」）', 409);
    }
    const room = this.rooms.create(uin, { kind, type, requestId: body.request_id });
    if (room.error) return err(room.error, room.status);
    const url = this.#roomUrl(request, room, kind === 'game' ? 'room' : 'join');
    if (!url) return err('拼不出房间地址：插件设置里填一下「房间公开地址」', 409);
    const expiresAt = this.rooms.view(room).expires_at;
    return kind === 'game'
      ? ok({ url, game_type: `native_v2:${type}`, label: room.label, expires_at: expiresAt, request_id: body.request_id ?? null, state: 'succeeded', execution_path: 'qq_agent_plugin' })
      : ok({ url, mode: type, label: room.label, expires_at: expiresAt, request_id: body.request_id ?? null, state: 'succeeded', execution_path: 'qq_agent_plugin', capability: 'together.room.create' });
  }

  #roomPage(request, token) {
    const blocker = this.#roomsBlocker(request);
    if (blocker) return err(blocker, 409);
    const room = this.rooms.get(token);
    if (!room) return { status: 404, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>房间已结束</title><p style="font:16px system-ui;padding:24px">这个房间已经结束或不存在了，回 App 里再开一个吧。</p>' };
    return { status: 200, contentType: 'text/html', body: roomPage() };
  }

  async #roomApi(request, token, op, method, body) {
    const blocker = this.#roomsBlocker(request);
    if (blocker) return err(blocker, 409);
    const room = this.rooms.get(token);
    if (!room) return err('房间已经结束或不存在', 404);
    if (op === 'state' && method === 'GET') {
      const name = (await this.#persona(room.uin)).bot_name;
      return ok(this.rooms.view(room, name));
    }
    if (op === 'action' && method === 'POST') return this.rooms.action(room, body);
    return err('method not allowed', 405);
  }

  // ── 屏幕共享 ──

  #screenHeartbeat(uin, p) {
    if (!this.settingsOf().screenEnabled) return err('手机屏幕共享上报已在配置中关闭', 409);
    const st = this.#st(uin);
    st.screen = { ...(st.screen || {}), client_id: clean(p.client_id, 100), streaming: Boolean(p.streaming), lastSeenAt: this.now() };
    if (!p.streaming) delete st.screen.desc;
    return ok(this.screenStatus(uin));
  }

  /** 一帧截图：有开着的「一起工作 / 一起看」房间就进房间让角色看；否则按间隔看一眼、记一句进背景。 */
  #screenFrame(uin, p) {
    const s = this.settingsOf();
    if (!s.screenEnabled) return err('手机屏幕共享上报已在配置中关闭', 409);
    if (!validImage(p.image)) return err('截图格式不对或太大（jpeg / png / webp，约 170KB 以内）');
    const st = this.#st(uin);
    const now = this.now();
    st.screen = { ...(st.screen || {}), streaming: true, lastSeenAt: now, frameAt: now };
    const room = this.rooms?.open(uin).filter((r) => r.type === 'work' || r.type === 'watch').sort((a, b) => b.activeAt - a.activeAt)[0];
    if (room && s.roomsEnabled) {
      const r = this.rooms.frame(room, p.image, '对方共享了屏幕');
      if (r.error) return err(r.error, r.status);
      return ok({ accepted: true, room: room.type, throttled: Boolean(r.throttled) });
    }
    if (!s.roomVision) return ok({ accepted: true, described: false, reason: 'vision_disabled' });
    if (st.screen.descAt && now - st.screen.descAt < s.screenIntervalMinutes * 60_000) return ok({ accepted: true, described: false, reason: 'throttled' });
    st.screen.descAt = now;
    // 看图要十几秒，宿主给入站请求的时限只有 10 秒：后台看，看完刷新背景
    this.host.llm([
      { role: 'system', content: '这是对方手机此刻的屏幕截图（TA 授权共享的）。用一句话（≤40 字）概括 TA 在做什么：在看什么、用什么应用、大概的内容。聊天内容、人名、账号、金额、密码、验证码一律不要写。只输出这一句。' },
      { role: 'user', content: 'TA 在做什么？', images: [p.image] }
    ], { maxTokens: 120, temperature: 0.3 }).then((text) => {
      const desc = clean(text, 60);
      if (!desc) return;
      this.#st(uin).screen = { ...(this.#st(uin).screen || {}), desc, descAt: this.now() };
      this.onUpdate(uin, { kind: 'screen' });
    }).catch((error) => this.log('warn', `屏幕截图没看成：${error?.message ?? error}`));
    return ok({ accepted: true, described: 'pending' });
  }

  screenStatus(uin) {
    const s = this.settingsOf();
    const sc = this.#st(uin).screen;
    if (!sc) return { available: s.screenEnabled, streaming: false, online: false, last_report_at: null, age_seconds: null, reason: 'no_recent_screen_heartbeat' };
    const age = Math.max(0, Math.round((this.now() - sc.lastSeenAt) / 1000));
    return { available: s.screenEnabled, streaming: age * 1000 <= SCREEN_ONLINE_MS && sc.streaming, online: s.screenEnabled && age * 1000 <= SCREEN_ONLINE_MS, client_id: sc.client_id || '', age_seconds: age, last_report_at: Math.floor(sc.lastSeenAt / 1000) };
  }

  async #pair(request, body) {
    const addr = clean(request.remoteAddr, 64) || 'unknown';
    if (this.#pairLimited(addr)) return err('配对尝试过于频繁，请稍后再试', 429);
    const configured = clean(await this.host.secret('phonePairingToken'), 240);
    if (!configured) return err('还没在插件设置里填配对令牌', 409);
    const token = this.#token(request.headers);
    if (!token || !safeEqual(token, configured)) return err('配对令牌无效', 401);
    const settings = this.settingsOf();
    const uin = settings.phoneUser || settings.targets[0] || '';
    if (!uin || !settings.targets.includes(uin)) return err('未配置可配对的陪伴对象（插件设置 → 手机连接 → 绑定的 QQ）', 400);
    const requested = clean(body.user_id, 120);
    if (requested && requested !== uin) return err('请求绑定的用户与网关配置不一致', 403);
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const now = this.now();
    const sessions = await this.#sessions();
    const mine = Object.entries(sessions).filter(([, s]) => s.uin === uin).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (mine.length >= MAX_SESSIONS) delete sessions[mine.shift()[0]];
    const session = { uin, device: clean(body.device_name, 100) || '陪伴终端 Android', createdAt: now, lastSeenAt: now, expiresAt: now + SESSION_TTL_MS };
    sessions[hashToken(sessionToken)] = session;
    await this.host.set('phone:sessions', sessions);
    this.pairHits.delete(addr);
    this.log('info', `手机已配对：${session.device} → ${uin}`);
    return ok({ ...this.status(uin, session), paired: true, session_token: sessionToken, session_expires_at: Math.floor(session.expiresAt / 1000) });
  }

  #location(uin, p) {
    const lat = num(p.latitude, 999); const lng = num(p.longitude, 999);
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) return err('经纬度不在有效范围内');
    const now = this.now();
    const capturedAt = stamp(p.captured_at, now);
    if (!capturedAt) return err('定位时间过旧，请重新获取位置');
    const rp = p.place && typeof p.place === 'object' ? p.place : {};
    const place = { matched: Boolean(rp.matched), name: clean(rp.name, 40), kind: clean(rp.kind, 24), distance_m: Math.max(0, Math.min(1e5, num(rp.distance_m))), radius_m: Math.max(20, Math.min(5000, num(rp.radius_m, 150))), parent_name: clean(rp.parent_name, 40) };
    const st = this.#st(uin);
    st.location = { latitude: lat, longitude: lng, accuracy_m: Math.max(0, Math.min(1e5, num(p.accuracy_m))), speed_mps: Math.max(0, Math.min(1000, num(p.speed_mps))), label: clean(p.label, 40), place, capturedAt, receivedAt: now };
    // 到了一个新的、有名字的地点 → 主动由头（第一次上报只记下，不当成"刚到"）
    const placeName = place.matched && place.name ? place.name : (clean(p.label, 40) || '');
    let event = null;
    if (placeName && st.lastPlace !== undefined && placeName !== st.lastPlace) event = { kind: 'place', note: `对方的手机显示 TA 刚到了「${placeName}」。可以自然地问一句或关心一下（别像在盯着 TA 的定位，也别报具体位置）。` };
    if (placeName || st.lastPlace === undefined) st.lastPlace = placeName;
    this.onUpdate(uin, { kind: 'location', event });
    return ok(this.locationSnapshot(uin));
  }

  #device(uin, p) {
    const appState = clean(p.app_state, 24).toLowerCase();
    if (!['foreground', 'background'].includes(appState)) return err('应用状态无效');
    const now = this.now();
    const capturedAt = stamp(p.captured_at, now);
    if (!capturedAt) return err('设备状态时间过旧，请重新上报');
    const battery = p.battery_percent === undefined || p.battery_percent === null ? null : num(p.battery_percent, -1);
    if (battery !== null && !(battery >= 0 && battery <= 100)) return err('电量百分比无效');
    const st = this.#st(uin);
    st.device = { device_name: clean(p.device_name, 120), platform: clean(p.platform, 24).toLowerCase() || 'android', app_state: appState, battery_percent: battery === null ? null : Math.round(battery * 10) / 10, charging: Boolean(p.charging), capturedAt, receivedAt: now };
    let event = null;
    if (battery !== null && battery <= 15 && !p.charging && now - (st.lastBatteryAlertAt || 0) > 6 * 3600_000) {
      st.lastBatteryAlertAt = now;
      event = { kind: 'battery', note: `对方手机只剩 ${Math.round(battery)}% 的电、没在充电。可以顺口提醒一句充电（轻一点，别像系统通知）。` };
    }
    this.onUpdate(uin, { kind: 'device', event });
    return ok(this.deviceSnapshot(uin));
  }

  #activity(uin, p) {
    const settings = this.settingsOf();
    if (!settings.phoneActivity) return err('手机活动摘要未在插件设置里启用', 409);
    if (p.consent !== true) return err('上报手机活动前需要明确同意', 409);
    const now = this.now();
    const capturedAt = stamp(p.captured_at, now);
    if (!capturedAt) return err('活动时间过旧，请重新上报');
    let appId = clean(p.app_id, 160).toLowerCase();
    let appLabel = clean(p.app_label, 80);
    let title = clean(p.display_title || appLabel, 80);
    let category = clean(p.category, 24).toLowerCase();
    let musicSource = clean(p.music_source, 80);
    if (!ACTIVITY_CATEGORIES.has(category)) category = 'other';
    if (!appId && !appLabel) return err('活动摘要缺少应用信息');
    const privacy = p.privacy_mode !== false;
    if (privacy && PRIVATE_MARKERS.some((m) => `${appId} ${appLabel}`.toLowerCase().includes(m))) {
      appId = ''; appLabel = '私密应用'; title = '私密应用'; category = 'private'; musicSource = '';
    }
    if (LABEL_BLOCKLIST.some((m) => title.toLowerCase().includes(m))) title = '其他应用';
    if (category !== 'music') musicSource = '';
    this.#st(uin).activity = { app_id: appId, app_label: appLabel || '其他应用', display_title: title || appLabel || '其他应用', category, music_playing: Boolean(p.music_playing), music_source: musicSource, capturedAt, receivedAt: now };
    this.onUpdate(uin, { kind: 'activity' });
    return ok(this.activitySnapshot(uin));
  }

  #telemetry(uin, p) {
    const settings = this.settingsOf();
    if (!settings.phoneHealth) return err('身体数据接收未在插件设置里启用', 409);
    const now = this.now();
    const capturedAt = stamp(p.captured_at, now);
    if (!capturedAt) return err('没有可用的结构化数据，或数据时间已过期');
    const list = Array.isArray(p.measurements) ? p.measurements.slice(0, 32) : null;
    if (!list) return err('没有可用的结构化数据，或数据时间已过期');
    const st = this.#st(uin);
    const measurements = { ...(st.telemetry?.measurements || {}) };
    for (const m of list) {
      const type = ident(m?.type); const unit = clean(m?.unit, 16); const value = num(m?.value, NaN);
      if (!type || !unit || !/^[A-Za-z0-9%/_-]+$/.test(unit) || !Number.isFinite(value) || Math.abs(value) > 1e9) continue;
      const at = stamp(m?.captured_at, now) || capturedAt;
      if (!measurements[type] || at >= measurements[type].capturedAt) measurements[type] = { type, value: Math.round(value * 1000) / 1000, unit, label: label(m?.label), capturedAt: at };
    }
    const a = p.activity && typeof p.activity === 'object' ? p.activity : {};
    const activity = { type: ident(a.type || a.state), label: label(a.label), duration_minutes: Math.max(0, Math.min(1440, num(a.duration_minutes))) };
    if (!Object.keys(measurements).length && !activity.type) return err('没有可用的结构化数据，或数据时间已过期');
    st.telemetry = { source: ident(p.source, 48) || 'external_telemetry', measurements, activity, capturedAt, receivedAt: now };
    this.onUpdate(uin, { kind: 'telemetry' });
    return ok(this.telemetrySnapshot(uin));
  }

  // ── 快照（App 看的 / 模型看的） ──

  #fresh(item, ttl) { return item && this.now() - item.receivedAt <= ttl; }

  locationSnapshot(uin) {
    const l = this.#st(uin).location;
    if (!l) return { available: false, reason: 'no_recent_location' };
    if (!this.#fresh(l, LOCATION_TTL_MS)) return { available: false, reason: 'location_expired' };
    return { available: true, latitude: Math.round(l.latitude * 1000) / 1000, longitude: Math.round(l.longitude * 1000) / 1000, accuracy_m: l.accuracy_m, speed_mps: l.speed_mps, label: l.label, place: l.place, captured_at: Math.floor(l.capturedAt / 1000), age_seconds: Math.round((this.now() - l.capturedAt) / 1000), source: 'android_foreground_location' };
  }

  deviceSnapshot(uin) {
    const d = this.#st(uin).device;
    if (!this.#fresh(d, DEVICE_TTL_MS)) return { available: false, reason: 'no_recent_device_status' };
    return { available: true, device_name: d.device_name, platform: d.platform, app_state: d.app_state, battery_percent: d.battery_percent, charging: d.charging, captured_at: Math.floor(d.capturedAt / 1000), age_seconds: Math.round((this.now() - d.capturedAt) / 1000) };
  }

  activitySnapshot(uin) {
    if (!this.settingsOf().phoneActivity) return { available: false, reason: 'activity_disabled' };
    const a = this.#st(uin).activity;
    if (!this.#fresh(a, ACTIVITY_TTL_MS)) return { available: false, reason: 'no_recent_activity' };
    return { available: true, app_label: a.app_label, display_title: a.display_title, category: a.category, music_playing: a.music_playing, music_source: a.music_source, captured_at: Math.floor(a.capturedAt / 1000), age_seconds: Math.round((this.now() - a.capturedAt) / 1000) };
  }

  telemetrySnapshot(uin) {
    if (!this.settingsOf().phoneHealth) return { available: false, reason: 'telemetry_disabled' };
    const t = this.#st(uin).telemetry;
    if (!this.#fresh(t, TELEMETRY_TTL_MS)) return { available: false, reason: 'no_recent_telemetry' };
    return { available: true, source: t.source, measurements: Object.values(t.measurements).map((m) => ({ type: m.type, value: m.value, unit: m.unit, label: m.label })), activity: t.activity, captured_at: Math.floor(t.capturedAt / 1000) };
  }

  status(uin, session = {}, request = {}) {
    const s = this.settingsOf();
    const blocker = this.#roomsBlocker(request);
    const ready = !blocker;
    const games = Object.entries(GAMES).filter(([k]) => k !== 'draw_guess' || s.roomVision)
      .map(([k, label]) => ({ game_type: `native_v2:${k}`, label, description: '陪伴游戏房间', enabled: true, mode: 'native_v2' }));
    return {
      api_version: API_VERSION, paired: true, user_id: uin, device_name: session.device || '',
      location: this.locationSnapshot(uin), device: this.deviceSnapshot(uin), activity: this.activitySnapshot(uin), telemetry: this.telemetrySnapshot(uin),
      screen: this.screenStatus(uin),
      together: {
        available: ready, enabled: s.roomsEnabled, running: ready, ready, execution: 'qq_agent_plugin',
        reason: ready ? null : 'rooms_unavailable', blockers: ready ? [] : [blocker],
        modes: Object.keys(TOGETHER_MODES),
        capabilities: { chat: { available: ready }, work: { available: ready }, novel: { available: ready }, invite: { available: ready }, join: { available: ready } }
      },
      games: { available: ready, enabled: s.roomsEnabled, running: ready, ready, blockers: ready ? [] : [blocker], games: ready ? games : [] },
      capabilities: { room: ready, call: false, watch: ready, novel: ready, work: ready, invite: ready, join: ready, location: s.phoneLocation, telemetry: s.phoneHealth, activity: s.phoneActivity, screen_upload: s.screenEnabled, games: ready }
    };
  }

  /** 给模型的一段（按设置筛过、不含坐标）。没有新鲜数据返回空串。 */
  contextText(uin) {
    const s = this.settingsOf();
    if (!s.phoneEnabled) return '';
    const lines = [];
    const ago = (t) => { const m = Math.round((this.now() - t) / 60_000); return m <= 1 ? '刚刚' : `${m} 分钟前`; };
    const l = this.#st(uin).location;
    if (s.phoneLocation && this.#fresh(l, LOCATION_TTL_MS)) {
      const where = l.place.matched && l.place.name ? `在「${l.place.name}」` : (l.label ? `在「${l.label}」附近` : '位置已共享（没标注是哪里）');
      const moving = l.speed_mps > 1.5 ? `，在移动中（约 ${Math.round(l.speed_mps * 3.6)} km/h）` : '';
      lines.push(`位置：${where}${moving}（${ago(l.capturedAt)}）`);
    }
    const d = this.#st(uin).device;
    if (this.#fresh(d, 2 * 3600_000) && d.battery_percent !== null) {
      lines.push(`手机电量 ${Math.round(d.battery_percent)}%${d.charging ? '，在充电' : ''}`);
    }
    const a = this.#st(uin).activity;
    if (s.phoneActivity && this.#fresh(a, ACTIVITY_TTL_MS)) {
      const what = a.category === 'music' && a.music_playing ? `在听音乐${a.music_source ? `（${a.music_source}）` : ''}` : `在${CATEGORY_LABEL[a.category] || '用手机'}${a.category === 'private' ? '' : `：${a.display_title}`}`;
      lines.push(`此刻${what}（${ago(a.capturedAt)}）`);
    }
    const t = this.#st(uin).telemetry;
    if (s.phoneHealth && this.#fresh(t, TELEMETRY_TTL_MS)) {
      const ms = Object.values(t.measurements).slice(0, 4).map((m) => `${m.label || m.type} ${m.value}${m.unit}`);
      if (t.activity.type) ms.unshift(`${t.activity.label || t.activity.type}${t.activity.duration_minutes ? ` ${Math.round(t.activity.duration_minutes)} 分钟` : ''}`);
      if (ms.length) lines.push(`运动健康：${ms.join('，')}`);
    }
    const sc = this.#st(uin).screen;
    if (s.screenEnabled && sc?.desc && this.now() - sc.descAt <= SCREEN_DESC_TTL_MS) lines.push(`屏幕（TA 在共享）：${sc.desc}（${ago(sc.descAt)}）`);
    if (!lines.length) return '';
    return `【对方的手机（TA 授权共享的实时状态）】\n${lines.join('\n')}\n只在自然的时候体贴地用上，不要报坐标、不要像在监视 TA，也不要逐项复述。`;
  }

  async summary() {
    const s = this.settingsOf();
    const sessions = await this.#sessions();
    const uin = s.phoneUser || s.targets[0] || '';
    const devices = Object.values(sessions).filter((x) => x.uin === uin).map((x) => x.device);
    const st = this.#st(uin);
    return {
      enabled: s.phoneEnabled, uin, devices, pairingTokenSet: Boolean(await this.host.secret('phonePairingToken')),
      location: st.location ? `${Math.round((this.now() - st.location.receivedAt) / 60_000)} 分钟前` : '无',
      device: st.device ? `${st.device.battery_percent ?? '?'}%` : '无',
      screen: s.screenEnabled ? (st.screen ? `${Math.round((this.now() - st.screen.lastSeenAt) / 60_000)} 分钟前${st.screen.desc ? `：${st.screen.desc}` : ''}` : '无') : '未开启',
      rooms: s.roomsEnabled ? (this.rooms?.open(uin) || []).map((r) => ({ label: r.label, topic: r.topic, since: Math.round((this.now() - r.createdAt) / 60_000) })) : null,
      path: '/plugin-hooks/private-companion'
    };
  }
}
