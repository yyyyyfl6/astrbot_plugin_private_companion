// 跟着当前人格过日子（cap.context.persona）、表达学习、成长记录。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Companion } from '../private-companion/companion.mjs';
import { pageCall } from '../private-companion/page.mjs';
import { levelOf } from '../private-companion/growth.mjs';

const at = (hm, date = '2026-11-01') => Date.parse(`${date}T${hm}:00+08:00`);
const PERSONAS = {
  fish: { skinId: 'fish', label: '蓝色大肥鱼', botName: '大肥鱼', roleText: '你是一条住在水族馆的蓝色大肥鱼，喜欢吐泡泡。' },
  cat: { skinId: 'cat', label: '哈基米', botName: '哈基米', roleText: '你是一只叫哈基米的橘猫，爱睡觉、爱吃小鱼干。' }
};

function setup({ llm = () => '{}', now: start = at('15:00'), settings = {}, persona = () => PERSONAS.fish } = {}) {
  const kv = new Map();
  const calls = { ctx: [], wake: [], llm: [] };
  let now = start;
  const host = {
    llm: async (messages) => { calls.llm.push(messages); return llm(messages); },
    setContext: async (k, t) => { calls.ctx.push({ k, t }); },
    wake: async (k, n) => { calls.wake.push({ k, n }); },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
    set: async (k, v) => { kv.set(k, structuredClone(v)); },
    secret: async () => '',
    persona: async (chatKey) => persona(chatKey),
    log: () => {}
  };
  const c = new Companion({ host, now: () => now, random: () => 0.5 });
  c.setSettings({ targets: '10001', morning: false, proactive: false, roleNote: '最近在学吉他', ...settings });
  return { c, calls, kv, setNow: (t) => { now = t; } };
}

const PLAN = (m) => {
  const sys = m[0].content;
  if (sys.includes('节目单')) return '{"items":[{"time":"08:00","text":"起床"},{"time":"12:00","text":"午饭"},{"time":"14:00","text":"午后"}],"mood":"开心"}';
  if (sys.includes('推进')) return '{"event":"练了半小时吉他","mood":"满足","thought":""}';
  return '{}';
};

test('排日程用当前人格的角色卡；插件设置只作补充', async () => {
  const { c, calls } = setup({ llm: PLAN });
  await c.tick();
  const prompt = calls.llm.find((m) => m[0].content.includes('节目单'))[1].content;
  assert.match(prompt, /角色：蓝色大肥鱼。人设（与主对话同一张角色卡，节选）：你是一条住在水族馆的蓝色大肥鱼/);
  assert.match(prompt, /补充设定：最近在学吉他/);
  const st = await c.status();
  assert.equal(st.persona.name, '蓝色大肥鱼');
  assert.equal(st.persona.pk, 'fish');
});

test('切换人格后各过各的日子（生活 / 梦按人格分开存）', async () => {
  let which = 'fish';
  const { c, kv, setNow } = setup({ llm: PLAN, persona: () => PERSONAS[which] });
  await c.tick();
  assert.ok(kv.get('life:fish:2026-11-01'), '大肥鱼的生活');
  which = 'cat';
  setNow(at('15:02'));            // 人格缓存 1 分钟
  await c.tick();
  assert.ok(kv.get('life:cat:2026-11-01'), '哈基米另起一份生活');
  assert.equal(kv.get('life:fish:2026-11-01').persona, '蓝色大肥鱼');
  assert.equal(kv.get('life:cat:2026-11-01').persona, '哈基米');
  await c.rel.saveDream('2026-11-01', { text: '梦见小鱼干', mood: '馋' }, 'cat');
  assert.ok(kv.get('dreams:cat'));
  assert.equal((await c.rel.dreams('fish'))['2026-11-01'], undefined);
});

test('读不到人格（老宿主）时回落到插件设置，沿用老存储键', async () => {
  const { c, kv } = setup({ llm: PLAN, persona: () => { throw new Error('E_NO_METHOD'); }, settings: { roleName: '小鲸鱼' } });
  await c.tick();
  assert.ok(kv.get('life:2026-11-01'), '默认人格用老键');
  assert.equal((await c.status()).persona.name, '小鲸鱼');
});

test('表达学习：收素材 → 学出候选 → 审核采纳后进背景；驳回的不再提', async () => {
  const learned = '{"items":[{"phrase":"绝绝子","situation":"夸东西特别好","usage":"单独一句接在后面","avoid":"严肃话题","evidence":"这家火锅绝绝子"},{"phrase":"栓Q","situation":"无奈","usage":"自嘲","avoid":"","evidence":"栓Q了家人们"}]}';
  const { c, calls } = setup({ settings: { exprEnabled: true }, llm: (m) => (m[0].content.includes('表达学习') ? learned : '{}') });
  for (let i = 0; i < 12; i += 1) await c.observe({ chatKey: 'group:555', senderId: String(20000 + i), ts: at('14:00'), text: `这家火锅绝绝子 ${i}` });
  assert.equal(c.expr.sample.length, 12);
  const r = await pageCall(c, 'expr.learn');
  assert.equal(r.added, 2);
  let st = await pageCall(c, 'expr.list');
  assert.equal(st.pending.length, 2);
  await pageCall(c, 'expr.accept', { id: st.pending.find((x) => x.phrase === '绝绝子').id, patch: { usage: '用在句尾' } });
  await pageCall(c, 'expr.reject', { id: st.pending.find((x) => x.phrase === '栓Q').id });
  st = await pageCall(c, 'expr.list');
  assert.deepEqual(st.rules.map((x) => x.phrase), ['绝绝子']);
  assert.equal(st.rules[0].usage, '用在句尾');
  assert.deepEqual(st.rejected, ['栓Q']);
  await c.refreshContext('10001');
  assert.match(calls.ctx.at(-1).t, /可以自然用上的说法.*\n「绝绝子」：夸东西特别好，用在句尾（别在严肃话题时用）/);
  // 再学一次：驳回过 / 已采纳的不会再进待审
  await pageCall(c, 'expr.learn');
  assert.equal((await pageCall(c, 'expr.list')).pending.length, 0);
  // 分享包导出 / 导入（导入进待审，不直接生效）
  const { pack } = await pageCall(c, 'expr.export');
  const other = setup({ settings: { exprEnabled: true } }).c;
  assert.equal((await pageCall(other, 'expr.import', { pack })).imported, 1);
  assert.equal((await pageCall(other, 'expr.list')).pending.length, 1);
  await assert.rejects(pageCall(other, 'expr.import', { pack: { kind: 'x' } }), /分享包/);
  // 关掉表达学习：不收素材、背景里不带
  c.setSettings({ targets: '10001', exprEnabled: false });
  await c.observe({ chatKey: 'group:555', senderId: '1', text: '再来一句话吧' });
  await c.refreshContext('10001');
  assert.doesNotMatch(calls.ctx.at(-1).t, /可以自然用上的说法/);
});

test('成长记录：回顾昨天的生活攒经验升级、记里程碑；进背景、排日程时参考', async () => {
  const grow = '{"skills":[{"name":"吉他","delta":2,"note":"练了新和弦"}],"milestone":""}';
  const { c, calls, kv, setNow } = setup({ now: at('03:30'), llm: (m) => (m[0].content.includes('成长') ? grow : PLAN(m)) });
  kv.set('life:fish:2026-10-31', { date: '2026-10-31', pk: 'fish', plan: [], log: [{ time: '20:00', text: '练了半小时吉他' }], mood: '满足', thoughts: [] });
  await c.tick();
  let g = await c.growth.get('fish');
  assert.equal(g.skills['吉他'].xp, 2);
  assert.equal(g.reviewed, '2026-10-31');
  assert.equal(calls.llm.filter((m) => m[0].content.includes('成长')).length, 1);
  await c.tick();
  assert.equal(calls.llm.filter((m) => m[0].content.includes('成长')).length, 1, '一天只回顾一次');
  // 升级：攒够 5 点
  g.skills['吉他'].xp = 4; g.reviewed = ''; kv.set('growth:fish', g);
  await c.growth.review('fish', '2026-10-31', kv.get('life:fish:2026-10-31'), 'x');
  g = await c.growth.get('fish');
  assert.equal(levelOf(g.skills['吉他'].xp), 2);
  assert.match(g.milestones.at(-1).text, /吉他升到了 Lv2/);
  await c.refreshContext('10001');
  assert.match(calls.ctx.at(-1).t, /你的成长】最近在练：吉他（Lv2，练了新和弦）/);
  setNow(at('09:00'));
  await c.tick();
  const plan = calls.llm.find((m) => m[0].content.includes('节目单'))[1].content;
  assert.match(plan, /最近在练：吉他（Lv2/);
});
