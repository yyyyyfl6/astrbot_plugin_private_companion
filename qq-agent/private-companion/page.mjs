// 「陪伴小屋」页面的 RPC（QQ Agent 插件接口 v3 的 page 能力；页面本体在 page.html）。
// 控制台把页面放在沙箱 iframe 里，页面里的按钮经宿主转到这里：只能读写本插件自己的数据。
import { bjDate, bjHm, roleLine } from './companion.mjs';

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

export async function pageCall(c, method, params = {}) {
  const s = c.settings;
  const uinOf = (v) => String(v || '').replace(/\D/g, '');
  switch (method) {
    case 'overview': {
      const st = await c.status();
      const today = bjDate(c.now());
      return {
        now: `${today} ${bjHm(c.now())}`,
        persona: st.persona,
        settings: { targets: s.targets, roleName: s.roleName, roleNote: s.roleNote, proactive: s.proactive, quiet: `${String(Math.floor(s.quietStart / 60)).padStart(2, '0')}:${String(s.quietStart % 60).padStart(2, '0')}~${String(Math.floor(s.quietEnd / 60)).padStart(2, '0')}:${String(s.quietEnd % 60).padStart(2, '0')}`, dailyMax: s.dailyMax, gap: `${s.minGap}~${s.maxGap}`, phone: s.phoneEnabled },
        today: st.today,
        dream: (await c.rel.dreams(st.persona.pk))[today] || null,
        chats: st.chats,
        phone: st.phone,
        upcoming: (await c.rel.upcoming(s.targets, today, 30)).slice(0, 8),
        lastTick: st.lastTick
      };
    }
    case 'cards.list': {
      const cards = await c.rel.cards();
      return { cards: Object.values(cards).sort((a, b) => (s.targets.includes(b.uin) - s.targets.includes(a.uin)) || b.updatedAt - a.updatedAt), targets: s.targets };
    }
    case 'cards.save': return { card: await c.rel.saveCard(params.card || {}) };
    case 'cards.delete': return { ok: await c.rel.deleteCard(uinOf(params.uin)) };
    case 'anniv.list': return { items: (await c.rel.anniversaries()).sort((a, b) => a.md.localeCompare(b.md)), upcoming: await c.rel.upcoming(s.targets, bjDate(c.now()), 60) };
    case 'anniv.save': return { item: await c.rel.saveAnniversary(params.item || {}) };
    case 'anniv.delete': return { ok: await c.rel.deleteAnniversary(clip(params.id, 24)) };
    case 'diary.list': {
      const uin = uinOf(params.uin) || s.targets[0] || '';
      const book = uin ? await c.diary(uin) : {};
      return { uin, targets: s.targets, entries: Object.keys(book).sort().reverse().map((date) => ({ date, ...book[date] })) };
    }
    case 'diary.write': {
      const uin = uinOf(params.uin);
      if (!s.targets.includes(uin)) throw new Error('只能给陪伴对象写日记');
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(params.date || '')) ? params.date : bjDate(c.now());
      const entry = await c.writeDiary(uin, date);
      if (!entry) throw new Error(`${date} 这天对方说的话太少（或者原话已经写进日记、清掉了），写不了`);
      return { date, entry };
    }
    case 'diary.delete': {
      const uin = uinOf(params.uin);
      const book = await c.diary(uin);
      delete book[clip(params.date, 10)];
      await c.host.set(`diary:${uin}`, book);
      return { ok: true };
    }
    case 'life.get': {
      const p = s.targets[0] ? await c.personaOf(s.targets[0]) : { pk: 'default' };
      return { persona: p.name, today: (await c.status()).today, yesterday: await c.life(bjDate(c.now() - 86400_000), p.pk), dreams: await c.rel.dreams(p.pk) };
    }
    case 'life.replan': {
      const p = s.targets[0] ? await c.personaOf(s.targets[0]) : { pk: 'default' };
      await c.host.set(p.pk !== 'default' ? `life:${p.pk}:${bjDate(c.now())}` : `life:${bjDate(c.now())}`, null);
      return { life: await c.ensurePlan(p) };
    }
    case 'life.step': {
      const p = s.targets[0] ? await c.personaOf(s.targets[0]) : { pk: 'default' };
      const life = (await c.life(undefined, p.pk)) || await c.ensurePlan(p);
      return { life: await c.stepLife(life, p) };
    }
    // ── 表达学习 ──
    case 'expr.list': return { ...(await c.expr.state()), enabled: s.exprEnabled, sample: c.expr.sample.length };
    case 'expr.learn': return c.expr.learn({ force: true, day: bjDate(c.now()) });
    case 'expr.accept': return { rule: await c.expr.accept(clip(params.id, 24), params.patch || {}) };
    case 'expr.reject': return { ok: await c.expr.reject(clip(params.id, 24)) };
    case 'expr.retire': return { ok: await c.expr.retire(clip(params.id, 24)) };
    case 'expr.add': return { rule: await c.expr.add(params.rule || {}) };
    case 'expr.export': return { pack: await c.expr.exportPack() };
    case 'expr.import': return c.expr.importPack(params.pack);
    // ── 成长记录（当前人格） ──
    case 'growth.get': {
      const p = s.targets[0] ? await c.personaOf(s.targets[0]) : { pk: 'default', name: s.roleName };
      return { persona: p.name, enabled: s.growthEnabled, growth: await c.growth.get(p.pk) };
    }
    case 'growth.review': {
      const p = s.targets[0] ? await c.personaOf(s.targets[0]) : { pk: 'default' };
      const date = bjDate(c.now() - 86400_000);
      const g = await c.growth.get(p.pk);
      if (g.reviewed === date) { g.reviewed = ''; await c.host.set(c.growth.key(p.pk), g); }
      const today = await c.life(undefined, p.pk);
      const life = (await c.life(date, p.pk)) || today;
      return c.growth.review(p.pk, life?.date || date, life, roleLine(s, p));
    }
    case 'growth.reset': {
      const p = s.targets[0] ? await c.personaOf(s.targets[0]) : { pk: 'default' };
      return { ok: await c.growth.reset(p.pk) };
    }
    case 'log.list': return { log: await c.host.get('log') || [], lastTick: c.lastReport || null };
    case 'proactive.test': {
      const uin = uinOf(params.uin);
      if (!s.targets.includes(uin)) throw new Error('只能主动联系陪伴对象');
      await c.host.wake(`private:${uin}`, '管理员在「陪伴小屋」里请你现在主动找对方说句话。看看你此刻的生活和最近聊过什么，找个自然的由头。');
      return { ok: true };
    }
    case 'phone.status': return { phone: await c.phone.summary() };
    default:
      throw new Error(`未知操作 ${method}`);
  }
}
