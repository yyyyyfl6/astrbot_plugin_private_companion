// 手机连接（qq-agent/private-companion/phone.mjs）：与原插件移动网关同一套协议。
// 钉住：配对令牌 → 会话令牌、未授权一律 401、上报校验与过期、给模型的背景不含坐标、私密应用隐藏、
// 到了新地点 / 低电量 → 主动由头（仍过免打扰与上限）、关闭会话、配对限频。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Companion } from '../private-companion/companion.mjs';

const at = (hm, date = '2026-11-01') => Date.parse(`${date}T${hm}:00+08:00`);
const TOKEN = 'pairing-token-0123456789abcdef';

function setup({ settings = {}, now: start = at('15:00') } = {}) {
  const kv = new Map();
  const calls = { ctx: [], wake: [] };
  let now = start;
  const host = {
    llm: async () => '{}',
    setContext: async (k, t) => { calls.ctx.push({ k, t }); },
    wake: async (k, n) => { calls.wake.push({ k, n }); },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
    set: async (k, v) => { kv.set(k, structuredClone(v)); },
    secret: async (k) => (k === 'phonePairingToken' ? TOKEN : ''),
    log: () => {}
  };
  const c = new Companion({ host, now: () => now, random: () => 0.5 });
  c.setSettings({ targets: '10001', phoneEnabled: true, morning: false, phoneActivity: true, phoneHealth: true, ...settings });
  const req = (method, path, body = {}, token = '') => c.phone.handle({ method, path, body, headers: token ? { authorization: `Bearer ${token}` } : {}, remoteAddr: '1.2.3.4' });
  return { c, calls, req, kv, setNow: (t) => { now = t; }, getNow: () => now };
}

async function pair(req) {
  const r = await req('POST', '/pair', { device_name: 'Pixel 8' }, TOKEN);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.data.session_token;
}

test('health 免鉴权；配对令牌 → 会话令牌；未授权 401；关掉就 409', async () => {
  const { req, c } = setup();
  const h = await req('GET', '/health');
  assert.equal(h.status, 200);
  assert.equal(h.body.data.service, 'reality_companion_mobile');
  assert.equal((await req('GET', '/status')).status, 401);
  assert.equal((await req('POST', '/pair', {}, 'wrong-token')).status, 401);
  const session = await pair(req);
  assert.ok(session.length >= 40);
  const st = await req('GET', '/status', {}, session);
  assert.equal(st.status, 200);
  assert.equal(st.body.data.user_id, '10001');
  assert.equal(st.body.data.device_name, 'Pixel 8');
  assert.equal((await req('GET', '/status', {}, TOKEN)).status, 401, '配对令牌不能当会话令牌用');
  // 原网关的前缀路径也认
  assert.equal((await req('GET', '/astrbot_plugin_private_companion.reality/mobile/status', {}, session)).status, 200);
  // 一起房间等不在移植范围
  assert.equal((await req('POST', '/room/create', {}, session)).status, 409);
  c.setSettings({ targets: '10001', phoneEnabled: false });
  assert.equal((await req('GET', '/status', {}, session)).status, 409);
});

test('位置：校验、进背景（不含坐标）、到新地点产生主动由头', async () => {
  const { req, c, calls, getNow, setNow } = setup();
  const s = await pair(req);
  assert.equal((await req('POST', '/location', { latitude: 200, longitude: 0 }, s)).status, 400);
  assert.equal((await req('POST', '/location', { latitude: 1, longitude: 1, captured_at: getNow() - 3600_000 }, s)).status, 400, '过旧拒收');
  const r = await req('POST', '/location', { latitude: 31.23456, longitude: 121.47654, captured_at: getNow(), place: { matched: true, name: '学校' } }, s);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.latitude, 31.235, '回给 App 的坐标也只保留 3 位小数');
  await new Promise((x) => setTimeout(x, 0));
  const ctx = calls.ctx.at(-1).t;
  assert.match(ctx, /对方的手机.*\n位置：在「学校」/);
  assert.doesNotMatch(ctx, /31\.2|121\.4/, '模型看不到坐标');
  // 第一次上报只记下；换到新地点才是由头
  assert.equal(c.phoneEvents.size, 0);
  await req('POST', '/location', { latitude: 31.3, longitude: 121.5, captured_at: getNow(), place: { matched: true, name: '家' } }, s);
  assert.match(c.phoneEvents.get('10001').note, /刚到了「家」/);
  const report = await c.tick();
  assert.equal(report.chats[0].woke, 'place');
  assert.match(calls.wake[0].n, /刚到了「家」/);
  assert.equal(c.phoneEvents.size, 0, '用过就清');
  // 撤回位置
  await req('POST', '/location/revoke', {}, s);
  assert.doesNotMatch(c.phone.contextText('10001'), /位置/);
  // 位置 15 分钟过期
  await req('POST', '/location', { latitude: 31.3, longitude: 121.5, captured_at: getNow(), label: '咖啡店' }, s);
  setNow(getNow() + 16 * 60_000);
  assert.doesNotMatch(c.phone.contextText('10001'), /位置/);
});

test('电量低：一次主动由头（6 小时内不重复）；免打扰里不发', async () => {
  const { req, c, calls, getNow } = setup({ now: at('23:50') });
  const s = await pair(req);
  await req('POST', '/device/status', { app_state: 'foreground', battery_percent: 9, charging: false, captured_at: getNow() }, s);
  assert.match(c.phoneEvents.get('10001').note, /只剩 9%/);
  const r = await c.tick();
  assert.equal(calls.wake.length, 0, '免打扰里不发');
  assert.ok(r);
  c.phoneEvents.clear();
  await req('POST', '/device/status', { app_state: 'foreground', battery_percent: 8, charging: false, captured_at: getNow() }, s);
  assert.equal(c.phoneEvents.size, 0, '6 小时内不重复');
  assert.match(c.phone.contextText('10001'), /手机电量 8%/);
  assert.equal((await req('POST', '/device/status', { app_state: 'x' }, s)).status, 400);
});

test('应用活动：要求同意、私密应用隐藏；健康摘要进背景', async () => {
  const { req, c, getNow } = setup();
  const s = await pair(req);
  assert.equal((await req('POST', '/device/activity', { app_label: 'B站' }, s)).status, 409, '没有 consent');
  await req('POST', '/device/activity', { consent: true, app_id: 'com.tencent.mobileqq', app_label: 'QQ', category: 'social', captured_at: getNow() }, s);
  assert.match(c.phone.contextText('10001'), /此刻在用私密应用/);
  assert.doesNotMatch(c.phone.contextText('10001'), /QQ/);
  await req('POST', '/device/activity', { consent: true, app_id: 'tv.danmaku.bili', app_label: '哔哩哔哩', category: 'video', captured_at: getNow() }, s);
  assert.match(c.phone.contextText('10001'), /此刻在看视频：哔哩哔哩/);
  const t = await req('POST', '/telemetry', { captured_at: getNow(), measurements: [{ type: 'steps', value: 8231, unit: 'count', label: '步数' }, { type: 'bad type!', value: 1, unit: 'x' }], activity: { type: 'walking', label: '散步', duration_minutes: 25 } }, s);
  assert.equal(t.status, 200);
  assert.match(c.phone.contextText('10001'), /运动健康：散步 25 分钟，步数 8231count/);
  c.setSettings({ targets: '10001', phoneEnabled: true, phoneActivity: false, phoneHealth: false });
  assert.doesNotMatch(c.phone.contextText('10001'), /此刻在|运动健康/, '关掉共享就不进背景');
  assert.equal((await req('POST', '/telemetry', { captured_at: getNow(), measurements: [] }, s)).status, 409);
});

test('关闭会话后失效；陪伴对象被移除后旧会话失效；配对限频', async () => {
  const { req, c } = setup();
  const s = await pair(req);
  assert.equal((await req('POST', '/session/close', {}, s)).status, 200);
  assert.equal((await req('GET', '/status', {}, s)).status, 401);
  const s2 = await pair(req);
  c.setSettings({ targets: '20002', phoneEnabled: true });
  assert.equal((await req('GET', '/status', {}, s2)).status, 401);
  c.setSettings({ targets: '10001', phoneEnabled: true });
  for (let i = 0; i < 8; i += 1) await req('POST', '/pair', {}, 'nope');
  assert.equal((await req('POST', '/pair', {}, TOKEN)).status, 429);
});
