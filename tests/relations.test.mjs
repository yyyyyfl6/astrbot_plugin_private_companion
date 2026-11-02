// 熟人卡 / 互动纪念日 / 梦境 / 跟进不重复 / 跨窗口承接 / 陪伴小屋 RPC。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Companion } from '../private-companion/companion.mjs';
import { pageCall } from '../private-companion/page.mjs';
import { normMd } from '../private-companion/relations.mjs';

const at = (hm, date = '2026-11-01') => Date.parse(`${date}T${hm}:00+08:00`);

function setup({ llm = () => '{}', now: start = at('15:00'), settings = {} } = {}) {
  const kv = new Map();
  const calls = { ctx: [], wake: [], llm: [] };
  let now = start;
  const host = {
    llm: async (messages) => { calls.llm.push(messages); return llm(messages); },
    setContext: async (k, t, ttl) => { calls.ctx.push({ k, t, ttl }); },
    wake: async (k, n) => { calls.wake.push({ k, n }); },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
    set: async (k, v) => { if (JSON.stringify(v ?? null).length > 32 * 1024) throw new Error('E_TOO_BIG'); kv.set(k, structuredClone(v)); },
    secret: async () => '',
    log: () => {}
  };
  const c = new Companion({ host, now: () => now, random: () => 0.5 });
  c.setSettings({ targets: '10001', morning: false, ...settings });
  return { c, calls, kv, setNow: (t) => { now = t; } };
}

test('日期归一', () => {
  assert.equal(normMd('5-2'), '05-02');
  assert.equal(normMd('2025-12-31'), '12-31');
  assert.equal(normMd('13-01'), '');
});

test('熟人卡：保存 / 进私聊背景；非陪伴对象私聊时也挂卡；update 合并不丢字段', async () => {
  const { c, calls } = setup();
  await c.rel.saveCard({ uin: '10001', nickname: '阿明', relation: '好朋友', birthday: '5-20', style: '喜欢被逗' });
  await c.rel.saveCard({ uin: '10001', notes: '在读研' });
  const card = await c.rel.card('10001');
  assert.equal(card.nickname, '阿明');
  assert.equal(card.birthday, '05-20');
  assert.equal(card.notes, '在读研');
  await c.refreshContext('10001');
  assert.match(calls.ctx.at(-1).t, /熟人卡·QQ 10001.*\n你叫 TA「阿明」\n关系：好朋友/);
  await c.rel.saveCard({ uin: '30003', nickname: '小王' });
  await c.observe({ chatKey: 'private:30003', ts: at('15:01'), text: '在吗' });
  assert.equal(calls.ctx.at(-1).k, 'private:30003');
  assert.match(calls.ctx.at(-1).t, /小王/);
});

test('每日反思：印象进熟人卡、互动纪念日按那天的日期记、不重复', async () => {
  const reflect = '{"summary":"阿明说今天第一次和我一起看完了一部电影。","followups":[],"impressions":["喜欢科幻片","晚上话多"],"anniversaries":[{"label":"第一次一起看电影","quote":"这是我们第一次一起看完一部电影"}]}';
  const { c } = setup({ llm: (m) => (m[0].content.includes('每日反思') ? reflect : '{}') });
  for (let i = 0; i < 4; i += 1) await c.observe({ chatKey: 'private:10001', ts: at(`21:0${i}`, '2026-10-31'), text: `电影真好看 ${i}` });
  await c.writeDiary('10001', '2026-10-31');
  const card = await c.rel.card('10001');
  assert.deepEqual(card.impressions.map((x) => x.text), ['喜欢科幻片', '晚上话多']);
  const anniv = await c.rel.anniversaries();
  assert.equal(anniv.length, 1);
  assert.equal(anniv[0].md, '10-31');
  assert.equal(anniv[0].year, 2026);
  assert.equal(anniv[0].source, 'auto');
  assert.equal(anniv[0].uin, '10001');
  // 再反思一次同样的内容：不重复
  await c.rel.addAutoAnniversaries('10001', '2026-10-31', [{ label: '第一次一起看电影' }]);
  await c.rel.addImpressions('10001', ['喜欢科幻片']);
  assert.equal((await c.rel.anniversaries()).length, 1);
  assert.equal((await c.rel.card('10001')).impressions.length, 2);
});

test('生日 / 纪念日当天：进背景、起床一小时后主动一次', async () => {
  const { c, calls, setNow } = setup({ now: at('08:30', '2027-10-31') });
  await c.rel.saveCard({ uin: '10001', nickname: '阿明', birthday: '10-31' });
  await c.rel.saveAnniversary({ date: '2026-10-31', label: '第一次一起看电影', uin: '10001' });
  const dates = await c.rel.datesOn('10001', '10-31');
  assert.deepEqual(dates.map((d) => d.kind), ['birthday', 'anniversary']);
  await c.tick();
  assert.equal(calls.wake.length, 0, '起床一小时内不发');
  assert.match(calls.ctx.at(-1).t, /今天是特别的日子】阿明的生日、第一次一起看电影（1 周年）/);
  setNow(at('09:10', '2027-10-31'));
  await c.tick();
  assert.equal(calls.wake.length, 1);
  assert.match(calls.wake[0].n, /今天是阿明的生日、第一次一起看电影/);
  const log = await c.host.get('log');
  assert.equal(log[0].kind, 'date');
  const up = await c.rel.upcoming(['10001'], '2027-10-25', 10);
  assert.equal(up.filter((u) => u.date === '2027-10-31').length, 2);
});

test('梦境：起床后做一次，上午进背景', async () => {
  const { c, calls, setNow } = setup({ now: at('08:30'), llm: (m) => (m[0].content.includes('昨晚的梦') ? '{"text":"梦见在会飞的图书馆里找一本书","mood":"有点怅然"}' : '{}') });
  await c.tick();
  const dreams = await c.rel.dreams();
  assert.equal(dreams['2026-11-01'].text, '梦见在会飞的图书馆里找一本书');
  assert.match(calls.ctx.at(-1).t, /你昨晚做的梦】梦见在会飞的图书馆/);
  const n = calls.llm.filter((m) => m[0].content.includes('昨晚的梦')).length;
  await c.tick();
  assert.equal(calls.llm.filter((m) => m[0].content.includes('昨晚的梦')).length, n, '一天只做一次');
  setNow(at('13:00'));
  await c.refreshContext('10001');
  assert.doesNotMatch(calls.ctx.at(-1).t, /昨晚做的梦/, '下午就不提了');
});

test('待跟进问过一次就不再追；跨窗口：TA 刚在群里说的话进私聊背景', async () => {
  const { c, calls, kv, setNow } = setup({ now: at('11:00'), settings: { minGapMinutes: 30, maxGapMinutes: 40, dailyMax: 5 } });
  kv.set('diary:10001', { '2026-10-31': { summary: 'x', followups: ['周五面试 → 问结果'] } });
  kv.set('chat:10001', { nextAt: at('10:00'), lastUserAt: at('09:00') });
  await c.tick();
  assert.match(calls.wake[0].n, /周五面试/);
  await c.observe({ chatKey: 'private:10001', ts: at('11:05'), text: '面试过了！' });
  setNow(at('12:30'));
  await c.tick();
  assert.equal(calls.wake.length, 2);
  assert.doesNotMatch(calls.wake[1].n, /周五面试/, '同一件事不再追问');
  // 跨窗口
  await c.observe({ chatKey: 'group:555', senderId: '10001', ts: at('12:31'), text: '有人知道哪家火锅好吃吗' });
  await c.observe({ chatKey: 'group:555', senderId: '20002', ts: at('12:31'), text: '别人的话' });
  await c.refreshContext('10001');
  const ctx = calls.ctx.at(-1).t;
  assert.match(ctx, /TA 刚在群里说过.*\n12:31 有人知道哪家火锅好吃吗/);
  assert.doesNotMatch(ctx, /别人的话/);
});

test('陪伴小屋 RPC：总览 / 熟人卡 / 纪念日 / 日记 / 记录', async () => {
  const { c } = setup();
  const o = await pageCall(c, 'overview');
  assert.deepEqual(o.settings.targets, ['10001']);
  await pageCall(c, 'cards.save', { card: { uin: '10001', nickname: '阿明' } });
  assert.equal((await pageCall(c, 'cards.list')).cards[0].nickname, '阿明');
  await assert.rejects(pageCall(c, 'cards.save', { card: { nickname: '没 QQ' } }), /QQ/);
  const a = await pageCall(c, 'anniv.save', { item: { date: '05-20', label: '认识的日子' } });
  assert.equal((await pageCall(c, 'anniv.list')).items.length, 1);
  await pageCall(c, 'anniv.delete', { id: a.item.id });
  assert.equal((await pageCall(c, 'anniv.list')).items.length, 0);
  assert.deepEqual((await pageCall(c, 'diary.list')).entries, []);
  await assert.rejects(pageCall(c, 'diary.write', { uin: '99999' }), /陪伴对象/);
  assert.deepEqual((await pageCall(c, 'log.list')).log, []);
  await assert.rejects(pageCall(c, 'nope'), /未知操作/);
});

test('按人细调：熟人卡里关掉 / 少一点 / 多一点', async () => {
  const { c, calls, kv } = setup({ now: at('11:00'), settings: { dailyMax: 2 } });
  kv.set('chat:10001', { nextAt: at('10:00'), lastUserAt: at('09:00') });
  await c.rel.saveCard({ uin: '10001', proactiveMode: 'off' });
  const r = await c.tick();
  assert.equal(calls.wake.length, 0);
  assert.match(r.chats[0].blocked, /关掉了/);
  await c.rel.saveCard({ uin: '10001', nickname: '阿明' });
  assert.equal((await c.rel.card('10001')).proactiveMode, 'off', '只改别的字段时不丢');
  await c.rel.saveCard({ uin: '10001', proactiveMode: 'less' });
  kv.set('chat:10001', { nextAt: at('10:00'), lastUserAt: at('09:00'), wakeDay: '2026-11-01', wakes: 1, kinds: ['x'] });
  const r2 = await c.tick();
  assert.match(r2.chats[0].blocked, /今天已主动 1 次/, 'less：上限减半（2 → 1）');
  await c.rel.saveCard({ uin: '10001', proactiveMode: 'more' });
  await c.tick();
  assert.equal(calls.wake.length, 1, 'more：上限 +2');
});
