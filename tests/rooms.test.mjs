// 一起房间 / 陪伴游戏 / 屏幕共享（private-companion/rooms.mjs、games.mjs，经 phone.mjs 的网关路由）。
// 钉住：只在独立端口上开房、链接令牌即凭证、App 重试同一 request_id 拿回同一间、规则由代码判定、
// 要动脑的（接话 / 出题 / 看图）在后台跑且接口立刻返回、看图要开关、结束后一句话进背景与生活、房间里不主动打扰。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Companion } from '../private-companion/companion.mjs';
import { ENGINES, gomokuBotMove, handValue, applyGuess, publicState } from '../private-companion/games.mjs';

const at = (hm, date = '2026-11-01') => Date.parse(`${date}T${hm}:00+08:00`);
const TOKEN = 'pairing-token-0123456789abcdef';
const IMG = `data:image/jpeg;base64,${'A'.repeat(400)}`;

function seq(values) { let i = 0; return () => values[i++ % values.length]; }

function setup({ settings = {}, llm } = {}) {
  const kv = new Map();
  const calls = { ctx: [], wake: [], llm: [] };
  let now = at('15:00');
  const host = {
    llm: async (messages, opts) => { calls.llm.push({ messages, opts }); return llm ? llm(messages) : '好呀～'; },
    setContext: async (k, t) => { calls.ctx.push({ k, t }); },
    wake: async (k, n) => { calls.wake.push({ k, n }); },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
    set: async (k, v) => { kv.set(k, structuredClone(v)); },
    secret: async (k) => (k === 'phonePairingToken' ? TOKEN : ''),
    persona: async () => ({ skinId: '', label: '小鲸鱼', botName: '小鲸鱼', roleText: '温柔的大学生' }),
    log: () => {}
  };
  const c = new Companion({ host, now: () => now, random: () => 0.5 });
  c.setSettings({ targets: '10001', phoneEnabled: true, roomsEnabled: true, morning: false, ...settings });
  const req = (method, path, body = {}, token = '', via = 'port') => c.phone.handle({
    method, path, body, via, remoteAddr: '1.2.3.4',
    headers: { host: 'example.com:6322', ...(token ? { authorization: `Bearer ${token}` } : {}) }
  });
  return { c, kv, calls, req, setNow: (t) => { now = t; }, getNow: () => now };
}

async function pair(req) {
  const r = await req('POST', '/pair', { device_name: 'Pixel 8' }, TOKEN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.session_token;
}
const tokenOf = (url) => url.split('/').pop();

test('规则引擎：井字棋会堵、五子棋会堵四连、二十一点算点、你画我猜判定', () => {
  // 井字棋：对方下 0、1，角色（不随手下时）必须堵 2
  let st = ENGINES.tictactoe.init();
  st = ENGINES.tictactoe.move(st, { cell: 0 }, seq([0.9])).state;
  const firstBot = st.board.indexOf('O');
  assert.ok(firstBot >= 0);
  const next = [1, 3, 4].find((i) => !st.board[i]);
  st = ENGINES.tictactoe.move(st, { cell: next }, seq([0.9])).state;
  assert.equal(ENGINES.tictactoe.move(st, { cell: firstBot }, seq([0.9])).error, '这一格不能下');
  // 五子棋：黑棋横着四连（两头空），白棋必须堵
  const board = Array(225).fill('');
  for (const x of [5, 6, 7, 8]) board[7 * 15 + x] = 'B';
  board[0] = 'W';
  assert.ok([7 * 15 + 4, 7 * 15 + 9].includes(gomokuBotMove(board, () => 0)));
  // 二十一点
  assert.equal(handValue(['♠A', '♥K']), 21);
  assert.equal(handValue(['♠A', '♥A', '♦9']), 21);
  assert.equal(handValue(['♠K', '♥Q', '♦5']), 25);
  const bj = ENGINES.blackjack.init(seq([0.1, 0.2, 0.3, 0.4]));
  assert.equal(publicState('blackjack', bj).bot[1], '🂠', '庄家暗牌不给看');
  // 你画我猜
  let dg = { word: '雨伞', guesses: [], rounds: 0, score: { user: 0, bot: 0 } };
  dg = applyGuess(dg, '伞');
  assert.equal(dg.guesses[0].right, false, '只猜一个字不算');
  dg = applyGuess(dg, '一把雨伞');
  assert.equal(dg.roundOver, true);
  assert.equal(dg.score.bot, 1);
  // 掷骰竞分：停手存分后轮到角色
  const pig = ENGINES.pig_dice;
  let p = pig.init();
  p = pig.move(p, { action: 'roll' }, seq([0.9])).state;   // 掷出 6
  assert.equal(p.turn, 6);
  p = pig.move(p, { action: 'hold' }, seq([0.5, 0.5, 0.5, 0.5])).state;
  assert.equal(p.scores.user, 6);
  assert.equal(p.scores.bot, 16, '角色攒到 15 分以上就停');
});

test('建房：要开关、要独立端口；同一 request_id 拿回同一间；通话 / 象棋不提供', async () => {
  const { c, req } = setup();
  const s = await pair(req);
  assert.equal((await req('POST', '/room/create', { mode: 'watch' }, s, 'console')).status, 409, '控制台端口上不开房');
  const r = await req('POST', '/room/create', { mode: 'watch', request_id: 'r1' }, s);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.url, /^http:\/\/example\.com:6322\/join\/[A-Za-z0-9_-]{32,}$/);
  const again = await req('POST', '/room/create', { mode: 'watch', request_id: 'r1' }, s);
  assert.equal(again.body.data.url, r.body.data.url, 'App 重试同一个请求拿回同一间');
  assert.equal((await req('POST', '/room/create', { mode: 'novel', request_id: 'r1' }, s)).status, 409, '同一个 request_id 换了参数就拒');
  assert.equal((await req('POST', '/room/create', { mode: 'call' }, s)).status, 409);
  assert.equal((await req('POST', '/game/room/create', { game_type: 'native_v2:xiangqi' }, s)).status, 409);
  const g = await req('POST', '/game/room/create', { game_type: 'native_v2:gomoku' }, s);
  assert.match(g.body.data.url, /\/room\/[A-Za-z0-9_-]{32,}$/);
  // 状态里报能力；你画我猜要看图开关
  const st = await req('GET', '/status', {}, s);
  assert.equal(st.body.data.capabilities.room, true);
  assert.equal(st.body.data.capabilities.call, false);
  assert.ok(!st.body.data.games.games.some((x) => x.game_type === 'native_v2:draw_guess'));
  c.setSettings({ targets: '10001', phoneEnabled: true, roomsEnabled: false });
  assert.equal((await req('POST', '/room/create', { mode: 'watch' }, s)).status, 409);
  // 公开地址覆盖
  c.setSettings({ targets: '10001', phoneEnabled: true, roomsEnabled: true, publicBaseUrl: 'https://c.example.org/' });
  const pub = await req('POST', '/room/create', { mode: 'work' }, s);
  assert.match(pub.body.data.url, /^https:\/\/c\.example\.org\/join\//);
});

test('房间页面与接口：令牌即凭证；说话立刻返回、角色在后台接话；结束后一句话进背景与生活', async () => {
  const { c, req, calls, kv } = setup();
  const s = await pair(req);
  await c.tick();   // 排出今天的生活（llm 回的不是 JSON → 排不出，没关系，没有生活也能开房）
  const r = await req('POST', '/room/create', { mode: 'watch' }, s);
  const t = tokenOf(r.body.data.url);
  const page = await req('GET', `/join/${t}`);
  assert.equal(page.status, 200);
  assert.equal(page.contentType, 'text/html');
  assert.match(page.body, /api\/room/);
  assert.equal((await req('GET', `/join/${t}`, {}, '', 'console')).status, 409, 'HTML 不在控制台端口上给');
  assert.equal((await req('GET', `/join/${'x'.repeat(40)}`)).status, 404);
  await c.rooms.idle();
  let st = await req('GET', `/api/room/${t}/state`);
  assert.equal(st.body.data.bot_name, '小鲸鱼');
  assert.ok(st.body.data.messages.some((m) => m.from === 'bot'), '进房后角色打招呼');
  assert.equal((await req('POST', `/api/room/${t}/action`, { action: 'topic', title: '千与千寻' })).status, 200);
  const said = await req('POST', `/api/room/${t}/action`, { action: 'say', text: '白龙好帅' });
  assert.equal(said.status, 200);
  await c.rooms.idle();
  st = await req('GET', `/api/room/${t}/state`);
  assert.equal(st.body.data.topic, '千与千寻');
  assert.equal(st.body.data.messages.filter((m) => m.from === 'bot').length, 3);
  const sys = calls.llm.at(-1).messages[0].content;
  assert.match(sys, /小鲸鱼/);
  assert.match(sys, /温柔的大学生/, '房间里用当前人格');
  // 房间开着时不主动打扰
  c.setSettings({ targets: '10001', phoneEnabled: true, roomsEnabled: true, morning: false, minGapMinutes: 30 });
  const chat = await c.chat('10001');
  assert.equal((await c.decide('10001', { ...chat, nextAt: 1 }, null)).blocked, '正在手机房间里一起玩');
  // 离开：一句话进背景
  assert.equal((await req('POST', `/api/room/${t}/action`, { action: 'leave' })).status, 200);
  assert.equal((await req('POST', `/api/room/${t}/action`, { action: 'say', text: '还在吗' })).status, 409);
  await new Promise((r2) => setTimeout(r2, 20));
  const ctx = calls.ctx.filter((x) => x.k === 'private:10001').at(-1).t;
  assert.match(ctx, /你们刚在手机上一起做的事/);
  assert.match(ctx, /一起看「千与千寻」，聊了 1 句/);
  assert.ok(![...kv.keys()].some((k) => k.startsWith('room')), '房间不落盘');
});

test('游戏房间：走子由代码判定；结束时角色说一句；海龟汤副 API 出题与答题', async () => {
  const soup = (messages) => {
    const sys = messages[0].content;
    if (sys.includes('出一道"海龟汤"')) return '{"title":"雨夜","surface":"他在雨里笑了。","bottom":"他刚中了彩票。"}';
    if (sys.includes('主持海龟汤')) return messages.at(-1).content.includes('彩票') ? '{"answer":"猜对了"}' : '{"answer":"不是","comment":"再想想"}';
    return '哼，下次一定赢你';
  };
  const { c, req } = setup({ llm: soup });
  const s = await pair(req);
  const g = await req('POST', '/game/room/create', { game_type: 'tictactoe' }, s);
  const t = tokenOf(g.body.data.url);
  const before = (await req('GET', `/api/room/${t}/state`)).body.data.state;
  assert.equal((await req('POST', `/api/room/${t}/action`, { cell: 4 })).status, 200);
  const after = (await req('GET', `/api/room/${t}/state`)).body.data.state;
  assert.equal(after.board[4], 'X');
  assert.equal(after.board.filter((x) => x === 'O').length, 1, '角色立刻应了一步');
  assert.equal((await req('POST', `/api/room/${t}/action`, { cell: 4 })).status, 400);
  assert.deepEqual(before.board, Array(9).fill(''));

  const soupRoom = await req('POST', '/game/room/create', { game_type: 'turtle_soup' }, s);
  const st2 = tokenOf(soupRoom.body.data.url);
  assert.equal((await req('GET', `/api/room/${st2}/state`)).body.data.state.bottom, undefined, '汤底不给看');
  await c.rooms.idle();
  let v = (await req('GET', `/api/room/${st2}/state`)).body.data;
  assert.equal(v.state.surface, '他在雨里笑了。');
  assert.equal(v.state.bottom, undefined);
  await req('POST', `/api/room/${st2}/action`, { action: 'say', text: '他失恋了吗' });
  await c.rooms.idle();
  v = (await req('GET', `/api/room/${st2}/state`)).body.data;
  assert.match(v.messages.at(-1).text, /^不是。再想想/);
  await req('POST', `/api/room/${st2}/action`, { action: 'say', text: '他中了彩票' });
  await c.rooms.idle();
  v = (await req('GET', `/api/room/${st2}/state`)).body.data;
  assert.equal(v.state.over, true);
  assert.equal(v.state.winner, 'user');
  assert.equal(v.state.bottom, '他刚中了彩票。', '揭晓后给看汤底');
});

test('看图：没开关就拒；你画我猜与一起工作的截图交给副 API（带图）', async () => {
  const llm = (messages) => (messages.at(-1).images ? '{"guess":"雨伞","say":"让我看看"}' : '加油');
  const { c, req, calls } = setup({ llm });
  const s = await pair(req);
  const w = await req('POST', '/room/create', { mode: 'work' }, s);
  const wt = tokenOf(w.body.data.url);
  assert.equal((await req('POST', `/api/room/${wt}/action`, { action: 'frame', image: IMG })).status, 409, '没开「让角色看图」');
  c.setSettings({ targets: '10001', phoneEnabled: true, roomsEnabled: true, roomVision: true });
  assert.equal((await req('POST', `/api/room/${wt}/action`, { action: 'frame', image: 'data:text/html;base64,AA' })).status, 400);
  assert.equal((await req('POST', `/api/room/${wt}/action`, { action: 'frame', image: IMG })).status, 200);
  await c.rooms.idle();
  assert.deepEqual(calls.llm.at(-1).messages.at(-1).images, [IMG]);
  const g = await req('POST', '/game/room/create', { game_type: 'draw_guess' }, s);
  const gt = tokenOf(g.body.data.url);
  const word = (await req('GET', `/api/room/${gt}/state`)).body.data.state.word;
  c.rooms.get(gt).state.word = '雨伞';
  assert.ok(word);
  await c.rooms.idle();
  assert.equal((await req('POST', `/api/room/${gt}/action`, { action: 'guess', image: IMG })).status, 200);
  await c.rooms.idle();
  const v = (await req('GET', `/api/room/${gt}/state`)).body.data;
  assert.equal(v.state.roundOver, true);
  assert.equal(v.state.score.bot, 1);
  assert.ok(!calls.llm.some((x) => JSON.stringify(x.messages).includes('雨伞') && !x.messages.at(-1).images && x.messages[0].content.includes('简笔画')), '题目不告诉角色');
});

test('屏幕共享：心跳与帧要开关；有一起工作房间就进房间，否则按间隔看一眼记进背景', async () => {
  const llm = (messages) => (messages[0].content.includes('手机此刻的屏幕截图') ? '在 B 站看做饭视频' : '嗯嗯');
  const { c, req, calls, getNow, setNow } = setup({ llm });
  const s = await pair(req);
  assert.equal((await req('POST', '/screen/heartbeat', { streaming: true }, s)).status, 409);
  c.setSettings({ targets: '10001', phoneEnabled: true, roomsEnabled: true, screenEnabled: true, roomVision: true });
  const hb = await req('POST', '/screen/heartbeat', { client_id: 'a1', streaming: true }, s);
  assert.equal(hb.body.data.online, true);
  assert.equal((await req('POST', '/screen/frame', { image: 'nope' }, s)).status, 400);
  const f = await req('POST', '/screen/frame', { image: IMG }, s);
  assert.equal(f.body.data.described, 'pending');
  await new Promise((r) => setTimeout(r, 20));
  assert.match(c.phone.contextText('10001'), /屏幕（TA 在共享）：在 B 站看做饭视频/);
  assert.equal((await req('POST', '/screen/frame', { image: IMG }, s)).body.data.reason, 'throttled');
  setNow(getNow() + 11 * 60_000);
  // 开了一起工作房间：帧进房间
  const w = await req('POST', '/room/create', { mode: 'work' }, s);
  const wt = tokenOf(w.body.data.url);
  await c.rooms.idle();
  const fr = await req('POST', '/screen/frame', { image: IMG }, s);
  assert.equal(fr.body.data.room, 'work');
  await c.rooms.idle();
  const msgs = (await req('GET', `/api/room/${wt}/state`)).body.data.messages;
  assert.ok(msgs.some((m) => m.text === '［对方共享了屏幕］'));
  assert.ok(calls.ctx.length > 0);
  // 称呼
  assert.equal((await req('GET', '/persona', {}, s)).body.bot_name, '小鲸鱼');
  assert.equal((await req('POST', '/persona', { bot_name: '鲸鲸' }, s)).body.bot_name, '鲸鲸');
  assert.equal((await req('GET', '/persona', {}, s)).body.source, 'mobile_alias');
  assert.equal((await req('POST', '/persona', { bot_name: 'x'.repeat(13) }, s)).status, 400);
});

test('多人格：房间里切人格 → 提示换人、旧人格的话标转述；称呼按人格分开；房间记忆对新人格是转述', async () => {
  const { c, req, calls } = setup();
  let persona = { skinId: 'fish', label: '蓝色大肥鱼', botName: '蓝色大肥鱼', roleText: '鱼' };
  c.host.persona = async () => persona;
  const s = await pair(req);
  // 称呼按人格分开
  await req('POST', '/persona', { bot_name: '鱼鱼' }, s);
  assert.equal((await req('GET', '/persona', {}, s)).body.bot_name, '鱼鱼');
  const r = await req('POST', '/room/create', { mode: 'watch' }, s);
  const t = tokenOf(r.body.data.url);
  await c.rooms.idle();
  await req('POST', `/api/room/${t}/action`, { action: 'say', text: '在吗' });
  await c.rooms.idle();
  // 切到哈基米（1 分钟的人格缓存过了之后）
  persona = { skinId: 'cat', label: '哈基米', botName: '哈基米', roleText: '猫' };
  c.personaCache.clear();
  assert.equal((await req('GET', '/persona', {}, s)).body.bot_name, '哈基米', '猫没起过昵称：用人格名，不用鱼的昵称');
  await req('POST', `/api/room/${t}/action`, { action: 'say', text: '你是谁' });
  await c.rooms.idle();
  const v = (await req('GET', `/api/room/${t}/state`)).body.data;
  assert.ok(v.messages.some((m) => m.from === 'system' && m.text.includes('换成「哈基米」')));
  const last = calls.llm.at(-1).messages;
  assert.match(last[0].content, /你是「哈基米」/);
  assert.ok(last.some((m) => m.role === 'user' && /之前陪 TA 的「蓝色大肥鱼」说过，转述/.test(m.content)), '鱼说过的话对猫是转述');
  assert.ok(!last.some((m) => m.role === 'assistant' && m.content === '好呀～' && last.indexOf(m) < 3), '鱼的话不当成猫自己说的');
  // 房间里收尾时陪着的是猫；切回鱼后看到的是转述
  await req('POST', `/api/room/${t}/action`, { action: 'leave' });
  await new Promise((r2) => setTimeout(r2, 20));
  persona = { skinId: 'fish', label: '蓝色大肥鱼', botName: '蓝色大肥鱼', roleText: '鱼' };
  c.personaCache.clear();
  await c.refreshContext('10001');
  const ctx = calls.ctx.filter((x) => x.k === 'private:10001').at(-1).t;
  assert.match(ctx, /那是【哈基米】陪 TA 的，转述/);
});
