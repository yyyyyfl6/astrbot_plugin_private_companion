// 关系网（熟人卡）、互动纪念日、梦境 —— 移植自原插件的 relationships / 每日记忆反思 / Content 梦境（原作 menglimi）。
//
//   熟人卡 cards：{ [QQ]: { uin, nickname 称呼, relation 关系, birthday MM-DD, style 相处方式, notes 备注,
//                    impressions [{ text, at }] 每日反思自动积累的印象 } }
//   纪念日 anniv：[{ id, md MM-DD, year, label, uin, source auto|manual, quote 原话依据 }]
//                  —— auto 由每日反思从对方**原话**里提取（"第一次见面""第一次一起完成…"），日期取那句话真实发生的那天；
//                  生日不另存，直接读熟人卡。
//   梦境 dreams：{ 'YYYY-MM-DD': { text, mood } }，每天起床时由副 API 依据前一天的生活与日记生成。
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const MAX_CARDS = 40;
const MAX_IMPRESSIONS = 6;
const MAX_ANNIV = 60;
const MAX_DREAMS = 14;

export const normMd = (v) => {
  const m = /^(?:\d{4}-)?(\d{1,2})-(\d{1,2})$/.exec(String(v || '').trim());
  if (!m) return '';
  const mm = Number(m[1]); const dd = Number(m[2]);
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 ? `${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}` : '';
};

export function normCard(raw = {}, prev = {}) {
  const uin = String(raw.uin ?? prev.uin ?? '').replace(/\D/g, '').slice(0, 20);
  if (!uin) return null;
  const pick = (k, n) => (raw[k] !== undefined ? str(raw[k], n) : (prev[k] || ''));
  const impressions = Array.isArray(raw.impressions)
    ? raw.impressions.map((x) => (typeof x === 'string' ? { text: str(x, 60), at: Date.now() } : { text: str(x?.text, 60), at: Number(x?.at) || Date.now() })).filter((x) => x.text).slice(-MAX_IMPRESSIONS)
    : (prev.impressions || []);
  return {
    uin,
    nickname: pick('nickname', 20),
    relation: pick('relation', 30),
    birthday: raw.birthday !== undefined ? normMd(raw.birthday) : (prev.birthday || ''),
    style: pick('style', 120),
    notes: pick('notes', 200),
    // 按人细调主动频率：'' 跟随全局 | off 不主动找 | less 少一点 | more 多一点
    proactiveMode: ['off', 'less', 'more'].includes(raw.proactiveMode) ? raw.proactiveMode : (raw.proactiveMode === '' ? '' : (prev.proactiveMode || '')),
    impressions,
    updatedAt: Date.now()
  };
}

export class Relations {
  constructor({ host, now = () => Date.now() } = {}) {
    this.host = host;
    this.now = now;
  }

  async #get(key, fallback) { const v = await this.host.get(key); return v === null || v === undefined ? fallback : v; }

  // ── 熟人卡 ──
  async cards() { return this.#get('cards', {}); }
  async card(uin) { return (await this.cards())[String(uin)] || null; }

  async saveCard(raw) {
    const cards = await this.cards();
    const prev = cards[String(raw?.uin || '').replace(/\D/g, '')] || {};
    const card = normCard(raw, prev);
    if (!card) throw new Error('熟人卡要有 QQ 号');
    if (!cards[card.uin] && Object.keys(cards).length >= MAX_CARDS) throw new Error(`熟人卡最多 ${MAX_CARDS} 张`);
    cards[card.uin] = card;
    await this.host.set('cards', cards);
    return card;
  }

  async deleteCard(uin) {
    const cards = await this.cards();
    delete cards[String(uin)];
    await this.host.set('cards', cards);
    return true;
  }

  /** 每日反思得到的印象并进熟人卡（同义的不重复加；没有卡就建一张只有印象的）。 */
  async addImpressions(uin, list) {
    const items = (Array.isArray(list) ? list : []).map((x) => str(x, 60)).filter(Boolean).slice(0, 3);
    if (!items.length) return null;
    const cards = await this.cards();
    const prev = cards[uin] || { uin };
    const have = new Set((prev.impressions || []).map((x) => x.text));
    const impressions = [...(prev.impressions || []), ...items.filter((t) => !have.has(t)).map((text) => ({ text, at: this.now() }))].slice(-MAX_IMPRESSIONS);
    if (!cards[uin] && Object.keys(cards).length >= MAX_CARDS) return null;
    cards[uin] = { ...normCard({ uin }, prev), impressions };
    await this.host.set('cards', cards);
    return cards[uin];
  }

  cardText(card) {
    if (!card) return '';
    const parts = [
      card.nickname ? `你叫 TA「${card.nickname}」` : '',
      card.relation ? `关系：${card.relation}` : '',
      card.birthday ? `生日：${card.birthday}` : '',
      card.style ? `相处方式：${card.style}` : '',
      card.notes ? `备注：${card.notes}` : '',
      card.impressions?.length ? `你对 TA 的印象：${card.impressions.map((x) => x.text).join('；')}` : ''
    ].filter(Boolean);
    return parts.length ? `【熟人卡·QQ ${card.uin}】\n${parts.join('\n')}` : '';
  }

  // ── 纪念日 ──
  async anniversaries() { return this.#get('anniv', []); }

  async saveAnniversary(raw = {}) {
    const md = normMd(raw.md || raw.date);
    const label = str(raw.label, 40);
    const uin = String(raw.uin || '').replace(/\D/g, '');
    if (!md || !label) throw new Error('纪念日要有日期（MM-DD）和名称');
    const list = await this.anniversaries();
    const id = str(raw.id, 24) || `a${this.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    const item = { id, md, year: /^\d{4}$/.test(String(raw.year || '')) ? Number(raw.year) : (/^\d{4}-/.test(String(raw.date || '')) ? Number(String(raw.date).slice(0, 4)) : null), label, uin, source: raw.source === 'auto' ? 'auto' : 'manual', quote: str(raw.quote, 80), createdAt: this.now() };
    const next = list.filter((x) => x.id !== id);
    if (!list.some((x) => x.id === id) && next.length >= MAX_ANNIV) throw new Error(`纪念日最多 ${MAX_ANNIV} 个`);
    next.push(item);
    await this.host.set('anniv', next);
    return item;
  }

  async deleteAnniversary(id) {
    const list = await this.anniversaries();
    await this.host.set('anniv', list.filter((x) => x.id !== String(id)));
    return true;
  }

  /** 每日反思自动提取的互动纪念日：同一个人、同一个日期、名称相近的不重复记。 */
  async addAutoAnniversaries(uin, date, list) {
    const md = normMd(date);
    const out = [];
    const existing = await this.anniversaries();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 2)) {
      const label = str(raw?.label, 40);
      if (!label || !md) continue;
      if (existing.some((x) => x.uin === uin && x.md === md && (x.label === label || x.label.includes(label) || label.includes(x.label)))) continue;
      out.push(await this.saveAnniversary({ md, year: Number(date.slice(0, 4)), label, uin, source: 'auto', quote: raw?.quote }));
    }
    return out;
  }

  /** 某天（默认今天）对这个人有意义的日子：生日（熟人卡）+ 纪念日。 */
  async datesOn(uin, md) {
    const out = [];
    const card = await this.card(uin);
    if (card?.birthday === md) out.push({ kind: 'birthday', label: `${card.nickname || 'TA'}的生日` });
    for (const a of await this.anniversaries()) {
      if (a.md === md && (!a.uin || a.uin === uin)) out.push({ kind: 'anniversary', label: a.label, year: a.year });
    }
    return out;
  }

  /** 接下来 days 天内的日子（页面用）。 */
  async upcoming(uins, todayDate, days = 30) {
    const base = Date.parse(`${todayDate}T00:00:00+08:00`);
    const out = [];
    for (let i = 0; i < days; i += 1) {
      const d = new Date(base + i * 86400_000 + 8 * 3600_000).toISOString().slice(0, 10);
      for (const uin of uins) for (const x of await this.datesOn(uin, d.slice(5))) out.push({ ...x, date: d, uin, inDays: i });
    }
    return out;
  }

  // ── 梦境 ──
  /** 梦按人格分开存（默认人格沿用老键 dreams）。 */
  async dreams(pk = 'default') { return this.#get(pk && pk !== 'default' ? `dreams:${pk}` : 'dreams', {}); }

  async saveDream(date, dream, pk = 'default') {
    const book = await this.dreams(pk);
    book[date] = { text: str(dream.text, 240), mood: str(dream.mood, 20) };
    for (const d of Object.keys(book).sort().slice(0, -MAX_DREAMS)) delete book[d];
    await this.host.set(pk && pk !== 'default' ? `dreams:${pk}` : 'dreams', book);
    return book[date];
  }
}
