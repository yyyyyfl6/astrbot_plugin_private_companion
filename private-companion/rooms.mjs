// 一起房间与陪伴游戏（移植自原插件的 Together / Game 能力与移动网关的建房路由，原作 menglimi）。
//
// 原插件的房间是独立的 Web 服务（WebSocket、视频通话、小说库、桌面屏幕伙伴…），手机 App 拿到房间链接后在
// WebView 里打开。移植版只做**手机上就能用、不依赖别的设备**的部分，页面与接口都经宿主 inbound 由本插件提供：
//
//   一起看（watch）   填上在看什么，边看边聊；角色按人设接话
//   一起读（novel）   贴一段正在读的文字，角色读完说感受，接着聊
//   一起工作（work）  手机的屏幕共享 / 手动上传截图进房间，角色看一眼说两句（副 API 要能看图）
//   游戏              井字棋、五子棋、掷骰竞分、二十一点（代码判定）；海龟汤、你画我猜（副 API）
//
// 不做：视频 / 语音通话（要实时音视频链路）、中国象棋（要完整引擎）。
//
// 访问方式与原插件一致：房间链接里的随机令牌就是凭证（/room/<令牌>、/join/<令牌>），页面轮询
// /api/room/<令牌>/state、操作走 POST /api/room/<令牌>/action。页面是 HTML，宿主**只在本插件的独立端口上**
// 给（控制台端口与控制台同源，不能放插件页面）。要动脑的操作（角色接话、出题、看图）都在后台跑，
// 接口立刻返回、页面轮询拿结果——宿主给入站请求的时限只有 10 秒。
//
// 房间只放内存：插件重启即清；闲置 30 分钟或开满 3 小时自动结束。结束时留一句话（"刚和 TA 下了一盘五子棋，TA 赢了"）
// 交给 Companion：挂进私聊背景几个小时、记进角色今天的生活。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { GAMES, LLM_GAMES, ENGINES, publicState, describe, applyGuess } from './games.mjs';

export const TOGETHER_MODES = Object.freeze({ watch: '一起看', novel: '一起读', work: '一起工作' });

const IDLE_MS = 30 * 60_000;
const MAX_AGE_MS = 3 * 3600_000;
const KEEP_ENDED_MS = 10 * 60_000;
const MAX_ROOMS_PER_USER = 3;
const MAX_MESSAGES = 60;
const LLM_PER_ROOM_HOUR = 40;
const FRAME_GAP_MS = 45_000;
const IMAGE_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
export const MAX_IMAGE_CHARS = 240_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

const clean = (v, n = 200) => String(v ?? '').replace(/\0/g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const ok = (data, status = 200) => ({ status, body: { ok: true, data } });
const err = (message, status = 400) => ({ status, body: { ok: false, message: clean(message, 240) } });
export const validImage = (v) => typeof v === 'string' && v.length <= MAX_IMAGE_CHARS && IMAGE_RE.test(v);

function parseJson(text) {
  const t = String(text || '');
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

let pageCache = null;
/** 房间页面（room.html）。读不到就给一页说明。 */
export function roomPage() {
  if (pageCache === null) {
    try { pageCache = fs.readFileSync(new URL('./room.html', import.meta.url), 'utf8'); } catch { pageCache = '<!doctype html><meta charset="utf-8"><p>房间页面缺失，请重装插件。</p>'; }
  }
  return pageCache;
}

export class Rooms {
  /**
   * host：{ llm(messages, opts) }；profile(uin) → { pk, name, role, life }（当前人格键、角色名、给副 API 的人设、此刻的生活）；
   * onEnd(uin, text)：房间结束时的一句话；settings()：插件设置
   */
  constructor({ host, settings, profile, onEnd = () => {}, now = () => Date.now(), random = Math.random, log = () => {} } = {}) {
    this.host = host;
    this.settingsOf = settings;
    this.profile = profile;
    this.onEnd = onEnd;
    this.now = now;
    this.random = random;
    this.log = log;
    this.rooms = new Map();      // token -> room
    this.requests = new Map();   // request_id -> token（App 重试同一个请求拿回同一个房间）
    this.invites = new Map();    // invitation_id -> { uin, token, expiresAt }
    this.jobs = new Set();       // 后台任务（单测里可以等）
  }

  // ── 生命周期 ──

  sweep() {
    const t = this.now();
    for (const [token, r] of this.rooms) {
      if (!r.ended && (t - r.activeAt > IDLE_MS || t - r.createdAt > MAX_AGE_MS)) this.end(r, '闲置太久，房间自动关了');
      if (r.ended && t - r.endedAt > KEEP_ENDED_MS) this.rooms.delete(token);
    }
    for (const [id, inv] of this.invites) if (inv.expiresAt <= t) this.invites.delete(id);
    for (const [id, token] of this.requests) if (!this.rooms.has(token)) this.requests.delete(id);
  }

  open(uin) { this.sweep(); return [...this.rooms.values()].filter((r) => r.uin === uin && !r.ended); }

  /** 建房。kind = together / game；type = 模式或游戏名。返回 room，或 { error, status }。 */
  create(uin, { kind, type, requestId = '' } = {}) {
    this.sweep();
    const rid = clean(requestId, 80);
    if (rid && this.requests.has(rid)) {
      const r = this.rooms.get(this.requests.get(rid));
      if (r && r.uin === uin && r.kind === kind && r.type === type) return r;
      return { error: '这次请求的房间参数变了，请换个 request_id', status: 409 };
    }
    if (kind === 'together' && !TOGETHER_MODES[type]) return { error: '移植版的一起房间只有 一起看 / 一起读 / 一起工作', status: 409 };
    if (kind === 'game' && !GAMES[type]) return { error: '这个游戏移植版还没有（可玩：井字棋、五子棋、掷骰竞分、二十一点、海龟汤、你画我猜）', status: 409 };
    if (kind !== 'together' && kind !== 'game') return { error: '房间类型不对', status: 400 };
    const mine = this.open(uin);
    if (mine.length >= MAX_ROOMS_PER_USER) this.end(mine.sort((a, b) => a.activeAt - b.activeAt)[0], '开了新房间，这间先关了');
    const t = this.now();
    const room = {
      token: crypto.randomBytes(24).toString('base64url'), uin, kind, type,
      label: kind === 'game' ? GAMES[type] : TOGETHER_MODES[type],
      createdAt: t, activeAt: t, ended: false, endedAt: 0, endNote: '',
      messages: [], pending: 0, rev: 1, llmCalls: [], topic: '', frameAt: 0, frame: '',
      state: kind === 'game' ? ENGINES[type].init(this.random) : null
    };
    this.rooms.set(room.token, room);
    if (rid) this.requests.set(rid, room.token);
    const greet = kind === 'game' ? `「${room.label}」开局了。` : `「${room.label}」房间开好了。`;
    this.#push(room, 'system', greet + (type === 'turtle_soup' ? '正在出题…' : ''));
    if (type === 'turtle_soup') this.#job(room, () => this.#soupInit(room));
    else this.#job(room, () => this.#reply(room, { cue: kind === 'game' ? `你们刚开了一局${room.label}，说句开场的话（可以挑衅一下或者撒个娇）。` : `你们刚进了「${room.label}」的房间，打个招呼，问问对方想${type === 'watch' ? '看什么' : type === 'novel' ? '读什么' : '忙什么'}。` }));
    return room;
  }

  get(token) {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    this.sweep();
    return this.rooms.get(token) || null;
  }

  end(room, note = '') {
    if (!room || room.ended) return;
    room.ended = true;
    room.endedAt = this.now();
    room.endNote = note;
    this.#push(room, 'system', note || '房间结束了。');
    const summary = this.summary(room);
    if (summary) {
      Promise.resolve().then(() => this.onEnd(room.uin, summary)).catch((error) => this.log('warn', `房间收尾出错：${error?.message ?? error}`));
    }
  }

  /** 收尾时的一句话（给 Companion 挂背景 / 记生活）。什么都没发生就不记。 */
  summary(room) {
    const said = room.messages.filter((m) => m.from === 'user').length;
    if (room.kind === 'game') {
      const st = room.state || {};
      const started = st.over || said || (st.moves || st.round || st.qa?.length || st.rounds || st.board?.some?.(Boolean) || st.scores?.user || st.scores?.bot);
      return started ? `刚和对方玩了${describe(room.type, st)}` : '';
    }
    if (!said) return '';
    const last = [...room.messages].reverse().find((m) => m.from === 'bot');
    return `刚和对方${room.label}${room.topic ? `「${room.topic}」` : ''}，聊了 ${said} 句${last ? `；你最后说的是"${clean(last.text, 40)}"` : ''}`;
  }

  /** 给页面的状态。 */
  view(room, botName = '') {
    return {
      kind: room.kind, type: room.type, label: room.label, topic: room.topic,
      bot_name: botName, pending: room.pending > 0, ended: room.ended, end_note: room.endNote,
      rev: room.rev, expires_at: Math.floor((Math.min(room.activeAt + IDLE_MS, room.createdAt + MAX_AGE_MS)) / 1000),
      messages: room.messages.slice(-40),
      state: room.state ? publicState(room.type, room.state) : null,
      vision: this.settingsOf().roomVision
    };
  }

  // ── 邀请：同一个陪伴对象的另一台已配对设备（或换个浏览器）凭邀请码进同一个房间 ──

  invite(uin, { token = '', expiresIn = 600 } = {}) {
    const room = token ? this.get(token) : this.open(uin).sort((a, b) => b.activeAt - a.activeAt)[0];
    if (!room || room.uin !== uin || room.ended) return { error: '没有可以邀请进来的房间（先开一个）', status: 409 };
    const id = crypto.randomBytes(9).toString('base64url');
    const expiresAt = this.now() + Math.max(60, Math.min(3600, Number(expiresIn) || 600)) * 1000;
    this.invites.set(id, { uin, token: room.token, expiresAt });
    return { invitation_id: id, expires_at: Math.floor(expiresAt / 1000), mode: room.type, label: room.label };
  }

  join(uin, invitationId) {
    this.sweep();
    const inv = this.invites.get(clean(invitationId, 40));
    if (!inv || inv.uin !== uin) return { error: '邀请不存在或已过期', status: 404 };
    const room = this.rooms.get(inv.token);
    if (!room || room.ended) return { error: '那个房间已经结束了', status: 409 };
    return { room };
  }

  // ── 页面操作 ──

  /** POST /api/room/<令牌>/action。返回 { status, body }。 */
  async action(room, body = {}) {
    if (room.ended) return err('房间已经结束了', 409);
    room.activeAt = this.now();
    const action = clean(body.action, 20);
    if (action === 'leave') { this.end(room, '对方离开了房间。'); return ok({ ended: true }); }
    if (action === 'say') {
      const text = clean(body.text, 300);
      if (!text) return err('说点什么吧');
      if (room.pending > 1) return err('等 TA 回完这句', 429);
      this.#push(room, 'user', text);
      if (room.type === 'turtle_soup') this.#job(room, () => this.#soupAsk(room, text));
      else this.#job(room, () => this.#reply(room));
      return ok({ accepted: true });
    }
    if (action === 'topic' && room.kind === 'together') {
      const title = clean(body.title, 60);
      if (!title) return err('填一下在看 / 读 / 忙什么');
      room.topic = title;
      this.#push(room, 'system', `${room.type === 'watch' ? '正在看' : room.type === 'novel' ? '正在读' : '正在忙'}：${title}`);
      this.#job(room, () => this.#reply(room, { cue: `对方说你们现在${room.type === 'watch' ? '一起看' : room.type === 'novel' ? '一起读' : '各自在忙'}「${title}」。接一句。` }));
      return ok({ accepted: true });
    }
    if (action === 'passage' && room.type === 'novel') {
      const text = String(body.text ?? '').replace(/\0/g, '').trim().slice(0, 1500);
      if (text.length < 10) return err('贴一段正在读的文字（10~1500 字）');
      this.#push(room, 'user', `（分享了一段）${text.slice(0, 120)}${text.length > 120 ? '…' : ''}`);
      this.#job(room, () => this.#reply(room, { cue: `对方贴了一段你们正在读的文字，读完说说你的感受或者想到的（别复述原文）：\n${text}` }));
      return ok({ accepted: true });
    }
    if (action === 'frame' && (room.type === 'work' || room.type === 'watch')) {
      const r = this.frame(room, body.image, '对方手动分享了一张截图');
      return r.error ? err(r.error, r.status) : ok({ accepted: true });
    }
    if (room.kind === 'game') return this.#gameAction(room, action, body);
    return err('不认识的操作');
  }

  /** 屏幕画面进房间（手机屏幕共享上报的帧，或页面里手动上传的截图）。节流：45 秒看一次。 */
  frame(room, image, note = '对方共享了屏幕') {
    if (!this.settingsOf().roomVision) return { error: '插件设置里没打开「让角色看图」（副 API 要能看图）', status: 409 };
    if (!validImage(image)) return { error: '图片格式不对或太大（jpeg / png / webp，约 170KB 以内）', status: 400 };
    room.frame = image;
    room.activeAt = this.now();
    if (this.now() - room.frameAt < FRAME_GAP_MS) return { throttled: true };
    room.frameAt = this.now();
    this.#push(room, 'user', `［${note}］`);
    this.#job(room, () => this.#reply(room, { image, cue: room.type === 'work'
      ? '这是对方此刻的屏幕（TA 在工作 / 学习）。看一眼，像坐在旁边陪着 TA 一样说一两句：可以是鼓励、提醒休息、或者对内容的小评论。别逐项描述画面，看不清就说看不清。'
      : '这是你们正在一起看的画面。像坐在旁边一起看一样接一句，别逐项描述画面。' }));
    return { accepted: true };
  }

  async #gameAction(room, action, body) {
    const type = room.type;
    if (type === 'draw_guess' && action === 'guess') {
      if (!this.settingsOf().roomVision) return err('你画我猜要副 API 能看图：插件设置里打开「让角色看图」', 409);
      if (room.state.roundOver) return err('这一题结束了，点「换一题」');
      if (!validImage(body.image)) return err('画布图片格式不对或太大');
      if (room.pending) return err('TA 还在猜上一张', 429);
      this.#push(room, 'user', `［画好了，第 ${room.state.guesses.length + 1} 次让 TA 猜］`);
      this.#job(room, () => this.#guessDrawing(room, body.image));
      return ok({ accepted: true });
    }
    const before = room.state;
    const { state, error } = ENGINES[type].move(before, body, this.random);
    if (error) return err(error);
    room.state = state;
    room.rev += 1;
    if (type === 'pig_dice' && state.botRolls?.length && state.botRolls !== before.botRolls) {
      this.#push(room, 'system', `TA 掷出 ${state.botRolls.join('、')}${state.botGained ? `，这回合拿了 ${state.botGained} 分` : '，掷到 1，白忙一场'}`);
    }
    if (type === 'blackjack' && state.roundOver && !before.roundOver) {
      this.#push(room, 'system', `这一局：你 ${state.user.join(' ')}（${handTotal(state.user)}） vs TA ${state.bot.join(' ')}（${handTotal(state.bot)}）→ ${({ user: '你赢', bot: 'TA 赢', draw: '平' })[state.result]}`);
    }
    if (state.over && !before.over) {
      this.#push(room, 'system', `这局结束：${({ user: '你赢了', bot: 'TA 赢了', draw: '平局' })[state.winner] || '结束'}`);
      this.#job(room, () => this.#reply(room, { cue: `${describe(type, state)}。用一句话说说这局（赢了可以得意一下，输了可以不服气或者夸夸对方）。` }));
    }
    return ok({ accepted: true });
  }

  // ── 后台（副 API） ──

  #push(room, from, text, meta = {}) {
    room.messages.push({ from, text: clean(text, 400), at: Math.floor(this.now() / 1000), ...meta });
    if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
    room.rev += 1;
  }

  #budget(room) {
    const t = this.now();
    room.llmCalls = room.llmCalls.filter((x) => t - x < 3600_000);
    if (room.llmCalls.length >= LLM_PER_ROOM_HOUR) return false;
    room.llmCalls.push(t);
    return true;
  }

  #job(room, fn) {
    if (!this.#budget(room)) { this.#push(room, 'system', 'TA 有点累了，过一会儿再聊（这个房间这小时说得太多了）'); return; }
    room.pending += 1;
    room.rev += 1;
    const run = Promise.resolve().then(fn).catch((error) => {
      this.log('warn', `房间（${room.label}）后台任务失败：${error?.message ?? error}`);
      this.#push(room, 'system', `TA 走神了一下（${clean(error?.message ?? error, 60)}）`);
    }).finally(() => { room.pending = Math.max(0, room.pending - 1); room.rev += 1; this.jobs.delete(run); });
    this.jobs.add(run);
  }

  async idle() { while (this.jobs.size) await Promise.all([...this.jobs]); }

  /** 当前陪着的人格；房间开着时切了人格（多人格 /切换），房间里说一声。 */
  async #persona(room) {
    const p = await this.profile(room.uin);
    const pk = p.pk || 'default';
    if (room.pk && room.pk !== pk && !room.ended) this.#push(room, 'system', `换成「${p.name || '另一位'}」陪你了`);
    room.pk = pk;
    room.pname = p.name || '';
    return p;
  }

  async #system(room, extra = '') {
    const p = await this.#persona(room);
    const scene = room.kind === 'game'
      ? `你们正在玩${room.label}（${describe(room.type, room.state || {})}）。`
      : `你们正在「${room.label}」${room.topic ? `：${room.topic}` : ''}。`;
    return `你是「${p.name || '我'}」，在手机上的陪伴房间里陪对方。${scene}\n${p.role}\n${p.life ? `你此刻的生活：${p.life}\n` : ''}`
      + '像真人发消息一样回一两句（≤60 字），口语、有情绪，不要旁白和动作描写，不要说自己是 AI，不要复述规则。'
      + (extra ? `\n${extra}` : '');
  }

  #history(room) {
    // 别的人格在这个房间里说过的话：不当成"我说的"，标成转述（与宿主的人格交接同口径）
    return room.messages.filter((m) => m.from !== 'system').slice(-12)
      .map((m) => (m.from !== 'bot' ? { role: 'user', content: m.text }
        : (!m.pk || m.pk === room.pk) ? { role: 'assistant', content: m.text }
          : { role: 'user', content: `（之前陪 TA 的「${m.by || '另一位'}」说过，转述，不是你说的）${m.text}` }));
  }

  async #reply(room, { cue = '', image = '' } = {}) {
    const messages = [{ role: 'system', content: await this.#system(room) }, ...this.#history(room)];
    if (cue || image) {
      const last = { role: 'user', content: `（提示，不是对方说的话）${cue || '接一句。'}` };
      if (image) last.images = [image];
      messages.push(last);
    }
    if (messages.length === 1) messages.push({ role: 'user', content: '（提示）打个招呼。' });
    const text = clean(await this.host.llm(messages, { maxTokens: 200, temperature: 0.9 }), 160).replace(/^["“「]|["”」]$/g, '');
    if (!room.ended && text) this.#push(room, 'bot', text, { pk: room.pk, by: room.pname });
  }

  async #soupInit(room) {
    const p = await this.#persona(room);
    const raw = await this.host.llm([
      { role: 'system', content: '你在出一道"海龟汤"（情境推理谜题）：汤面是一段离奇但合理的短情节，汤底是完整真相；不要血腥恐怖，适合聊天时玩，答案要能靠"是/不是"的提问推出来。只输出 JSON：{"title":"≤10字","surface":"汤面，≤120字","bottom":"汤底，≤200字"}' },
      { role: 'user', content: `出题人是 ${p.name || '角色'}，换个新题，别出最常见的那几道。` }
    ], { maxTokens: 600, temperature: 1 });
    const j = parseJson(raw);
    const title = clean(j?.title, 20); const surface = clean(j?.surface, 240); const bottom = clean(j?.bottom, 400);
    if (!surface || !bottom) throw new Error('副 API 没出好题');
    room.state = { ...room.state, title, surface, bottom, ready: true };
    room.rev += 1;
    this.#push(room, 'bot', `汤面「${title || '无题'}」：${surface}\n你可以问我只能用"是 / 不是"回答的问题～`, { pk: room.pk, by: room.pname });
  }

  async #soupAsk(room, question) {
    const st = room.state;
    if (!st.ready) { this.#push(room, 'system', '题还没出好，稍等一下'); return; }
    if (st.over) { await this.#reply(room); return; }
    const raw = await this.host.llm([
      { role: 'system', content: `你在主持海龟汤。汤面：${st.surface}\n汤底（绝不能直接说出来）：${st.bottom}\n对方会提问或直接猜。按汤底判断，只输出 JSON：{"answer":"是|不是|无关|接近了|猜对了","comment":"可选，≤20字的小反应，可空"}。对方把汤底的关键说中了才算"猜对了"。` },
      ...st.qa.slice(-8).flatMap((x) => [{ role: 'user', content: x.q }, { role: 'assistant', content: JSON.stringify({ answer: x.a }) }]),
      { role: 'user', content: question }
    ], { maxTokens: 120, temperature: 0.3 });
    const j = parseJson(raw);
    const answer = ['是', '不是', '无关', '接近了', '猜对了'].includes(j?.answer) ? j.answer : '无关';
    const qa = [...st.qa, { q: clean(question, 120), a: answer }].slice(-40);
    const solved = answer === '猜对了';
    room.state = { ...st, qa, over: solved || st.over, winner: solved ? 'user' : st.winner };
    room.rev += 1;
    this.#push(room, 'bot', `${answer}${j?.comment ? `。${clean(j.comment, 30)}` : ''}`, { pk: room.pk, by: room.pname });
    if (solved) this.#push(room, 'system', `汤底：${st.bottom}`);
  }

  async #guessDrawing(room, image) {
    const st = room.state;
    const tried = st.guesses.map((g) => g.text).filter(Boolean);
    const raw = await this.host.llm([
      { role: 'system', content: await this.#system(room, '这是对方在手机上画的简笔画，你来猜画的是什么。只输出 JSON：{"guess":"一个词","say":"猜的时候说的一句话，≤25字"}') },
      { role: 'user', content: `${tried.length ? `你已经猜过（都不对）：${tried.join('、')}。换一个。` : ''}猜猜这是什么？`, images: [image] }
    ], { maxTokens: 120, temperature: 0.7 });
    const j = parseJson(raw);
    const guess = clean(j?.guess, 12) || '看不出来';
    const next = applyGuess(st, guess);
    room.state = next;
    room.rev += 1;
    this.#push(room, 'bot', `${j?.say ? `${clean(j.say, 40)} ` : ''}是「${guess}」吗？`, { pk: room.pk, by: room.pname });
    if (next.roundOver) this.#push(room, 'system', next.guesses.at(-1).right ? `猜中了！答案就是「${st.word}」` : `三次都没猜中，答案是「${st.word}」`);
  }
}

function handTotal(cards) {
  let total = 0; let aces = 0;
  for (const c of cards) { const r = c.slice(1); if (r === 'A') { aces += 1; total += 11; } else total += ['J', 'Q', 'K'].includes(r) ? 10 : Number(r) || 0; }
  while (total > 21 && aces) { total -= 10; aces -= 1; }
  return total;
}

/** 从请求头拼出给设备打开的绝对地址前缀（插件设置里填了公开地址就用它）。 */
export function originOf(request = {}, publicBaseUrl = '') {
  const fixed = String(publicBaseUrl || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^\s/]+(\/[^\s]*)?$/i.test(fixed)) return fixed;
  const h = request.headers || {};
  const host = clean(String(h['x-forwarded-host'] || h.host || '').split(',')[0], 200);
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host)) return '';
  const proto = String(h['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https' ? 'https' : 'http';
  return `${proto}://${host}`;
}
