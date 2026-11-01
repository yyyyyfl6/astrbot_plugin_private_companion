// 人格交接（陪伴这一侧）：多人格 /切换 之后，旧人格自己的生活 / 今天主动过几次 / 问过的事交给新人格。
import assert from 'node:assert/strict';
import test from 'node:test';
import { Companion } from '../private-companion/companion.mjs';
import { pageCall } from '../private-companion/page.mjs';

const at = (hm, date = '2026-11-01') => Date.parse(`${date}T${hm}:00+08:00`);

function setup({ settings = {} } = {}) {
  const kv = new Map();
  const calls = { ctx: [], wake: [] };
  let now = at('10:00');
  let skin = { skinId: 'hajimi', label: '哈基米', roleText: '一只爱睡觉的猫娘' };
  const host = {
    llm: async () => '{}',
    setContext: async (k, t) => { calls.ctx.push({ k, t }); },
    wake: async (k, n) => { calls.wake.push({ k, n }); },
    get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
    set: async (k, v) => { kv.set(k, structuredClone(v)); },
    persona: async () => skin,
    secret: async () => '',
    log: () => {}
  };
  const c = new Companion({ host, now: () => now, random: () => 0.5 });
  c.setSettings({ targets: '10001', morning: false, ...settings });
  return { c, kv, calls, setNow: (t) => { now = t; }, setSkin: (s) => { skin = s; } };
}

test('切换人格：生成交接（旧人格的生活 / 今天主动过几次 / 问过的事），只挂给新人格', async () => {
  const { c, kv, calls, setNow, setSkin } = setup();
  kv.set('life:hajimi:2026-11-01', { date: '2026-11-01', pk: 'hajimi', plan: [{ time: '09:00', text: '在窗台晒太阳' }], mood: '懒洋洋', log: [{ time: '09:30', text: '抓到一只蝴蝶' }], thoughts: [], nextStepAt: at('23:00') });
  await c.observe({ chatKey: 'private:10001', ts: at('10:00'), text: '早' });
  assert.equal((await c.chat('10001')).pk, 'hajimi', '第一次见到只记下人格');
  assert.equal(await c.handoff.get('10001'), null);
  const st = await c.chat('10001');
  await c.saveChat('10001', { ...st, wakeDay: '2026-11-01', wakes: 2, kinds: ['morning', 'thought'], askedFollowups: ['周五面试 → 问结果'] });

  // /切换 大肥鱼
  setSkin({ skinId: 'fatfish', label: '大肥鱼', roleText: '一条话很多的鱼' });
  setNow(at('10:30'));
  await c.observe({ chatKey: 'private:10001', ts: at('10:30'), text: '你是谁' });
  const h = await c.handoff.get('10001');
  assert.equal(h.from.name, '哈基米');
  assert.equal(h.to.name, '大肥鱼');
  assert.match(h.lines.join('\n'), /哈基米】今天过的是它自己的日子：此刻：在窗台晒太阳（09:00 起），今天做过 09:30 抓到一只蝴蝶，心情懒洋洋/);
  assert.match(h.lines.join('\n'), /已经主动找过 TA 2 次（早安、分享自己的事），早安已经道过了/);
  assert.match(h.lines.join('\n'), /周五面试/);
  // 立刻换上新人格的背景（不等巡检），交接在里面
  const ctx = calls.ctx.at(-1);
  assert.equal(ctx.k, 'private:10001');
  assert.match(ctx.t, /人格交接·陪伴（来自【哈基米】的转述，非亲历）】10:30 起这段私聊由你接手/);
  assert.doesNotMatch(ctx.t, /你的生活（持续进行中/, '新人格今天的生活还没排，不能把旧人格的日子当成自己的');
  // 下一次主动往后推，每日次数不因切人格清零
  const after = await c.chat('10001');
  assert.ok(after.nextAt >= at('11:10'));
  assert.equal(after.wakes, 2);
  assert.equal(after.pk, 'fatfish');
  assert.equal((await c.host.get('log'))[0].kind, 'handoff');

  // 切回哈基米：交接换成大肥鱼 → 哈基米；哈基米看不到给大肥鱼的那份
  setSkin({ skinId: 'hajimi', label: '哈基米', roleText: '' });
  setNow(at('11:00'));
  await c.observe({ chatKey: 'private:10001', ts: at('11:00'), text: '回来啦' });
  const back = await c.handoff.get('10001');
  assert.equal(back.from.name, '大肥鱼');
  assert.equal(back.to.name, '哈基米');
  assert.match(calls.ctx.at(-1).t, /来自【大肥鱼】/);
  assert.match(calls.ctx.at(-1).t, /你的生活（持续进行中/, '哈基米自己的生活接着过');
});

test('没切换不重复交接；关掉交接时只换人格、不挂交接', async () => {
  const { c, calls, setSkin } = setup({ settings: { handoffEnabled: false } });
  await c.observe({ chatKey: 'private:10001', ts: at('10:00'), text: '早' });
  await c.observe({ chatKey: 'private:10001', ts: at('10:01'), text: '在吗' });
  assert.equal(calls.ctx.length, 0, '没切换就不额外刷新');
  setSkin({ skinId: 'fatfish', label: '大肥鱼', roleText: '' });
  await c.observe({ chatKey: 'private:10001', ts: at('10:02'), text: '嗨' });
  assert.equal(await c.handoff.get('10001'), null);
  assert.equal((await c.chat('10001')).pk, 'fatfish');
  assert.doesNotMatch(calls.ctx.at(-1).t, /人格交接/);
});

test('日记记下是哪个人格陪的；换了人格后标"转述"；陪伴小屋总览带交接', async () => {
  const { c, kv, calls, setSkin } = setup();
  kv.set('diary:10001', { '2026-10-31': { by: '哈基米', pk: 'hajimi', summary: '阿明说面试过了。', followups: [] } });
  await c.observe({ chatKey: 'private:10001', ts: at('10:00'), text: '早' });
  await c.refreshContext('10001');
  assert.match(calls.ctx.at(-1).t, /10-31：阿明说面试过了/);
  setSkin({ skinId: 'fatfish', label: '大肥鱼', roleText: '' });
  await c.observe({ chatKey: 'private:10001', ts: at('10:05'), text: '嗨' });
  assert.match(calls.ctx.at(-1).t, /10-31（那天是【哈基米】陪着 TA，转述）：阿明说面试过了/);
  const o = await pageCall(c, 'overview');
  assert.equal(o.handoffs.length, 1);
  assert.equal(o.handoffs[0].h.to.name, '大肥鱼');
});
