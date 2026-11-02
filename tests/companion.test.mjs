// 移植版核心逻辑（qq-agent/private-companion/companion.mjs）。跑法：node --test qq-agent/tests/
import assert from 'node:assert/strict';
import test from 'node:test';
import { Companion, readSettings, inQuiet, bjDate } from '../private-companion/companion.mjs';

const at = (hm, date = '2026-11-01') => Date.parse(`${date}T${hm}:00+08:00`);

function fakeHost({ llm } = {}) {
  const kv = new Map();
  const calls = { llm: [], ctx: [], wake: [] };
  return {
    calls, kv,
    llm: async (messages, opts) => { calls.llm.push({ messages, opts }); return llm(messages); },
    setContext: async (k, t, ttl) => { calls.ctx.push({ k, t, ttl }); },
    wake: async (k, n) => { calls.wake.push({ k, n }); },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
    set: async (k, v) => { if (JSON.stringify(v ?? null).length > 32 * 1024) throw new Error('E_TOO_BIG'); kv.set(k, structuredClone(v)); },
    log: () => {}
  };
}

const PLAN = '{"items":[{"time":"07:30","text":"起床赖床"},{"time":"09:00","text":"去图书馆"},{"time":"12:00","text":"食堂午饭"},{"time":"14:00","text":"实验课"},{"time":"19:00","text":"夜跑"}],"mood":"有点困"}';
const STEP = '{"event":"图书馆空调太冷，借了件外套","mood":"清醒了","thought":"想问问TA今天冷不冷"}';
const smartLlm = (messages) => {
  const sys = messages[0].content;
  if (sys.includes('节目单')) return PLAN;
  if (sys.includes('推进')) return STEP;
  if (sys.includes('每日反思')) return '{"summary":"阿明说周五要面试，有点紧张。","followups":["周五面试 → 问结果"]}';
  return '{}';
};

test('设置归一与免打扰跨零点', () => {
  const s = readSettings({ targets: '10001，abc20002, 10001', minGapMinutes: 5, maxGapMinutes: 1 });
  assert.deepEqual(s.targets, ['10001', '20002']);
  assert.equal(s.minGap, 30);
  assert.ok(s.maxGap > s.minGap);
  assert.equal(inQuiet(s, at('23:45')), true);
  assert.equal(inQuiet(s, at('03:00')), true);
  assert.equal(inQuiet(s, at('09:00')), false);
});

test('生活长任务：排日程 → 推进 → 挂背景；早安走主链路唤醒', async () => {
  const host = fakeHost({ llm: smartLlm });
  let now = at('08:20');
  const c = new Companion({ host, now: () => now, random: () => 0.5 });
  c.setSettings({ targets: '10001', roleName: '小鲸鱼', roleNote: '大二学生' });
  const r1 = await c.tick();
  assert.match(r1.life, /起床赖床/);
  const life = await c.life();
  assert.equal(life.plan.length, 5);
  assert.match(host.calls.llm[0].messages[1].content, /小鲸鱼.*大二学生/);
  assert.equal(host.calls.ctx[0].k, 'private:10001');
  assert.match(host.calls.ctx[0].t, /你的生活.*\n.*起床赖床/);
  assert.equal(host.calls.wake.length, 1);
  assert.match(host.calls.wake[0].n, /早安/);
  // 推进一步：产生念头 → 进背景
  now = at('10:30');
  const r2 = await c.tick();
  assert.match(r2.life, /去图书馆 · 清醒了/);
  assert.match(host.calls.ctx.at(-1).t, /一直想跟对方说的：想问问TA今天冷不冷/);
  // 上一条（早安）没回：不追
  assert.equal(host.calls.wake.length, 1);
  assert.equal(r2.chats[0].blocked, '上一条对方还没回');
});

test('对方回复后，按不规则间隔用"念头"主动；每日上限', async () => {
  const host = fakeHost({ llm: smartLlm });
  let now = at('11:00');
  const c = new Companion({ host, now: () => now, random: () => 0 });
  c.setSettings({ targets: '10001', morning: false, minGapMinutes: 60, maxGapMinutes: 120, dailyMax: 2 });
  await c.tick();                                   // 排日程 + 推进 + 排下一次（random 0 → +60 分钟）
  assert.equal(host.calls.wake.length, 0);
  now = at('12:05');
  await c.tick();
  assert.equal(host.calls.wake.length, 1);
  assert.match(host.calls.wake[0].n, /想跟对方说：想问问TA今天冷不冷/);
  await c.observe({ chatKey: 'private:10001', ts: at('12:10'), text: '不冷呀' });
  now = at('13:20');
  await c.tick();
  assert.equal(host.calls.wake.length, 2);
  now = at('15:00');
  const r = await c.tick();
  assert.equal(host.calls.wake.length, 2);
  assert.match(r.chats[0].blocked, /今天已主动 2 次|还没回/);
  // 免打扰里什么都不做
  now = at('23:50');
  const q = await c.tick();
  assert.equal(q.life, '睡觉中');
});

test('私聊日记：攒对方原话 → 凌晨定稿 → 进背景与检索；只记陪伴对象', async () => {
  const host = fakeHost({ llm: smartLlm });
  let now = at('20:00', '2026-10-31');
  const c = new Companion({ host, now: () => now, random: () => 0.5 });
  c.setSettings({ targets: '10001', proactive: false });
  for (let i = 0; i < 5; i += 1) await c.observe({ chatKey: 'private:10001', ts: now + i * 60_000, text: `周五要面试了 ${i}` });
  await c.observe({ chatKey: 'private:30003', ts: now, text: '别人' });
  await c.observe({ chatKey: 'group:1', ts: now, text: '群里' });
  assert.equal((await c.chat('10001')).buffer.length, 5);
  assert.equal(host.kv.has('chat:30003'), false);
  now = at('09:00', '2026-11-01');
  await c.tick();
  const book = await c.diary('10001');
  assert.equal(book['2026-10-31'].summary, '阿明说周五要面试，有点紧张。');
  assert.equal((await c.chat('10001')).buffer.length, 0, '写完日记清掉原话');
  assert.match(host.calls.ctx.at(-1).t, /私聊日记.*\n10-31：阿明说周五要面试/);
  assert.equal(c.searchDiary(book, { date: '10-31' }).length, 1);
  assert.equal(c.searchDiary(book, { keyword: '面试' }).length, 1);
  assert.equal(bjDate(at('00:10', '2026-11-01')), '2026-11-01');
});
