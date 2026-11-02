// 成长记录（移植自原插件 role_work/growth，原作 menglimi）：角色在自己的生活里慢慢学会东西。
// 每天凌晨回顾**这个人格**昨天的生活，副 API 判断练了什么、长进多少，攒经验升等级，偶尔记一个里程碑；
// 排第二天日程时会参考（还在练的事会接着练），也会挂进背景（"你最近在练吉他，Lv3"）。
// 按人格分开存：多人格时每个角色有自己的成长。
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const MAX_SKILLS = 12;
const MAX_MILESTONES = 20;
const XP_PER_LEVEL = 5;

export const levelOf = (xp) => Math.min(10, Math.floor(Math.max(0, Number(xp) || 0) / XP_PER_LEVEL) + 1);

export class Growth {
  constructor({ host, now = () => Date.now() } = {}) {
    this.host = host;
    this.now = now;
  }

  key(pk) { return pk && pk !== 'default' ? `growth:${pk}` : 'growth'; }

  async get(pk) {
    const v = await this.host.get(this.key(pk));
    return { skills: {}, milestones: [], reviewed: '', ...(v && typeof v === 'object' ? v : {}) };
  }

  async #save(pk, g) { await this.host.set(this.key(pk), g); }

  /** 回顾某天（默认昨天）的生活。life 是那天的生活记录，roleLine 是角色描述。 */
  async review(pk, date, life, roleLine) {
    const g = await this.get(pk);
    if (g.reviewed === date) return { skipped: '已回顾' };
    const events = (life?.log || []).map((e) => e.text);
    if (!events.length) { g.reviewed = date; await this.#save(pk, g); return { skipped: '那天没有生活记录' }; }
    const skills = Object.values(g.skills).map((s) => `${s.name}（Lv${levelOf(s.xp)}）`).join('、') || '还没有';
    const r = await this.host.llm([
      { role: 'system', content: '你在给一个虚拟角色记"成长"。看这个角色某一天做过的事，判断 TA 在哪些技能 / 爱好上有长进（学习、运动、手艺、兴趣、与人相处……都算）。'
        + '要合理、慢慢来：一天的长进 delta 只能是 0~2，没练就别加。偶尔有值得记的突破才写 milestone。只输出 JSON：{"skills":[{"name":"技能名，≤8字","delta":1,"note":"这次练了什么，≤20字"}],"milestone":"一句话里程碑，没有就空串"}' },
      { role: 'user', content: `${roleLine}\n日期：${date}\n已有的技能：${skills}\n那天做过的事：\n${events.map((e) => `- ${e}`).join('\n')}` }
    ], { maxTokens: 400, temperature: 0.5 });
    const t = String(r || '');
    let j = null;
    try { j = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { j = null; }
    const changed = [];
    for (const raw of (Array.isArray(j?.skills) ? j.skills : []).slice(0, 4)) {
      const name = str(raw?.name, 8);
      const delta = Math.max(0, Math.min(2, Math.round(Number(raw?.delta) || 0)));
      if (!name || !delta) continue;
      if (!g.skills[name] && Object.keys(g.skills).length >= MAX_SKILLS) continue;
      const prev = g.skills[name] || { name, xp: 0, since: date };
      const before = levelOf(prev.xp);
      g.skills[name] = { ...prev, xp: prev.xp + delta, note: str(raw?.note, 30), last: date };
      const after = levelOf(g.skills[name].xp);
      changed.push({ name, delta, levelUp: after > before ? after : 0 });
      if (after > before) g.milestones.push({ date, text: `${name}升到了 Lv${after}` });
    }
    const milestone = str(j?.milestone, 50);
    if (milestone) g.milestones.push({ date, text: milestone });
    g.milestones = g.milestones.slice(-MAX_MILESTONES);
    g.reviewed = date;
    await this.#save(pk, g);
    return { changed, milestone };
  }

  /** 给排日程 / 背景用的一句话。 */
  summary(g) {
    const top = Object.values(g.skills).sort((a, b) => (b.last || '').localeCompare(a.last || '') || b.xp - a.xp).slice(0, 3);
    if (!top.length) return '';
    const last = g.milestones.at(-1);
    return `最近在练：${top.map((s) => `${s.name}（Lv${levelOf(s.xp)}${s.note ? `，${s.note}` : ''}）`).join('、')}${last ? `；最近的进步：${last.text}` : ''}`;
  }

  async reset(pk) { await this.#save(pk, { skills: {}, milestones: [], reviewed: '' }); return true; }
}
