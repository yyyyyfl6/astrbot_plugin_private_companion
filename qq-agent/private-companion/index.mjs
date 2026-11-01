// 「我会永远陪着你」QQ Agent 移植版 —— 协议入口（NDJSON over stdio，见 QQ Agent docs/PLUGINS.md）。
// 原作：menglimi / astrbot_plugin_private_companion。核心逻辑在 companion.mjs。
import { Companion } from './companion.mjs';

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let seq = 0;
const pending = new Map();

/** 调宿主能力（cap.*），等它的回执。 */
function callHost(method, params = {}, timeoutMs = 90000) {
  const id = `c${++seq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 超时`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    send({ id, method, params });
  });
}

const host = {
  llm: async (messages, opts = {}) => (await callHost('cap.llm.complete', { messages, ...opts })).content,
  setContext: (chatKey, text, ttlMinutes) => callHost('cap.context.set', { chatKey, text, ttlMinutes }),
  wake: (chatKey, note) => callHost('cap.wake.request', { chatKey, note }),
  get: async (key) => (await callHost('cap.storage.get', { key })).value,
  set: (key, value) => callHost('cap.storage.set', { key, value }),
  log: (level, message) => { callHost('cap.log.write', { level, message }).catch(() => {}); }
};

const companion = new Companion({ host });

async function refreshSettings() {
  try { companion.setSettings((await callHost('cap.config.get', {})).settings || {}); } catch { /* 用上一次的 */ }
}

async function handle(m) {
  switch (m.method) {
    case 'init':
      await refreshSettings();
      return { ok: true };
    case 'ping':
      return {};
    case 'schedule':
      await refreshSettings();
      return { report: await companion.tick() };
    case 'probe': {
      await refreshSettings();
      const st = await companion.status();
      const s = companion.settings;
      return {
        ok: s.targets.length > 0,
        summary: s.targets.length
          ? `陪伴 ${s.targets.join('、')} · ${st.today ? `此刻：${st.today.now?.text || '日程开始前'}（${st.today.mood}）` : '今天的日程还没排'}`
          : '还没填陪伴对象',
        ...st
      };
    }
    case 'callTool': {
      const { name, args = {}, context = {} } = m.params || {};
      await refreshSettings();
      if (name === 'life_status') {
        const st = await companion.status();
        if (!st.today) return { note: '今天的生活还没开始记录（日程还没排好）。照常聊天即可，不要编具体安排。' };
        return { now: st.today.now, mood: st.today.mood, plan: st.today.plan, happened: st.today.log };
      }
      if (name === 'recall_diary') {
        const mm = /^private:(\d+)$/.exec(String(context.chatKey || ''));
        if (!mm) return { error: '日记只在私聊里能翻' };
        if (!companion.settings.targets.includes(mm[1])) return { error: '没有为这个人记日记' };
        const found = companion.searchDiary(await companion.diary(mm[1]), args);
        return found.length ? { entries: found } : { note: '没有找到对应的日记（可能那天聊得少没记，或者是开始记日记之前的事）' };
      }
      return { error: `未知工具 ${name}` };
    }
    case 'observe':
      await refreshSettings();
      await companion.observe(m.params || {});
      return null;
    default:
      return null;
  }
}

// observe 与 schedule 都会读改写会话状态：排成一条队，避免互相覆盖（工具调用只读，不排队）
let queue = Promise.resolve();
const serial = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let i = buffer.indexOf('\n');
  while (i !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    i = buffer.indexOf('\n');
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    // 宿主对我们 cap 调用的回执
    if (m.id !== undefined && !m.method && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(Object.assign(new Error(m.error.message || m.error.code), { code: m.error.code }));
      else p.resolve(m.result ?? {});
      continue;
    }
    if (m.method === 'shutdown') process.exit(0);
    const job = m.method === 'observe' || m.method === 'schedule' ? serial(() => handle(m)) : handle(m);
    job.then((result) => {
      if (m.id !== undefined && m.id !== null) send({ id: m.id, result: result ?? {} });
    }, (error) => {
      if (m.id !== undefined && m.id !== null) send({ id: m.id, error: { code: error?.code || 'E_PLUGIN', message: String(error?.message ?? error) } });
    });
  }
});
