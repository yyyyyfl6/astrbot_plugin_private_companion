// 人格交接（陪伴这一侧）：QQ Agent 的多人格在切换时会把**聊天内容**总结成交接摘要交给新人格
// （宿主做，见 skins.handoffOnSwitch）。陪伴插件这边补上宿主不知道的那一半：
//
//   · 旧人格今天跟对方提过的"自己的生活"（在做什么、心情）—— 那是旧人格的日子，新人格不能当成自己做过的；
//   · 今天已经主动找过几次、用过哪些由头（早安 / 纪念日…）—— 新人格别再道一遍早安；
//   · 已经追问过的待跟进 —— 别再问一遍。
//
// 口径与宿主的交接摘要一致：**转述，非亲历**；只写明确记录过的事，不编；一直挂到下一次切换为止。
// 每日主动上限按"人"算、不按人格算：切人格不能绕过上限；切换后下一次主动往后推一段，让新人格先自然接上话。
const str = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

const KIND_LABEL = { morning: '早安', date: '特别的日子', thought: '分享自己的事', followup: '追问待跟进', miss: '想念 / 问近况' };

export class Handoff {
  constructor({ host, now = () => Date.now() } = {}) {
    this.host = host;
    this.now = now;
  }

  key(uin) { return `handoff:${uin}`; }

  async get(uin) {
    const v = await this.host.get(this.key(uin));
    return v && typeof v === 'object' ? v : null;
  }

  /**
   * 生成一份交接。from / to：{ pk, name }；oldLife：旧人格今天的生活；chat：这个人的陪伴状态；today：北京日期。
   * current：旧人格此刻在做的那一项（companion.current(oldLife)）。
   */
  build({ from, to, oldLife = null, current = null, chat = {}, today = '', at = this.now(), hm = '' }) {
    const lines = [];
    if (oldLife && oldLife.date === today) {
      const did = (oldLife.log || []).slice(-3).map((e) => `${e.time} ${e.text}`).join('；');
      const doing = current ? `${current.text}（${current.time} 起）` : '';
      if (did || doing) lines.push(`【${from.name}】今天过的是它自己的日子：${[doing && `此刻：${doing}`, did && `今天做过 ${did}`].filter(Boolean).join('，')}，心情${oldLife.mood || '平常'}。那不是你的经历；TA 问起，就说那是之前那位的事，别当成你做过的。`);
    }
    const kinds = chat.wakeDay === today ? (chat.kinds || []) : [];
    const wakes = chat.wakeDay === today ? Number(chat.wakes) || 0 : 0;
    if (wakes) lines.push(`今天【${from.name}】已经主动找过 TA ${wakes} 次（${kinds.map((k) => KIND_LABEL[k] || k).join('、') || '—'}）${kinds.includes('morning') ? '，早安已经道过了' : ''}。`);
    const asked = (chat.askedFollowups || []).slice(-3);
    if (asked.length) lines.push(`这些事已经问过 TA 了，别再追问：${asked.join('；')}。`);
    return {
      from: { pk: str(from.pk, 40), name: str(from.name, 30) },
      to: { pk: str(to.pk, 40), name: str(to.name, 30) },
      at,
      hm,
      lines: lines.map((x) => str(x, 220))
    };
  }

  async save(uin, h) { await this.host.set(this.key(uin), h); }

  /** 挂进背景的那一段：只给交接的接收方（当前人格就是 to 时）。 */
  contextText(h, persona) {
    if (!h || !persona || h.to?.pk !== persona.pk) return '';
    const head = `【人格交接·陪伴（来自【${h.from.name || '另一人格'}】的转述，非亲历）】${h.hm ? `${h.hm} 起` : ''}这段私聊由你接手。`;
    if (!h.lines?.length) return `${head}之前没有需要交代的陪伴记录。你自己的生活以【你的生活】为准。`;
    return `${head}\n${h.lines.map((x) => `- ${x}`).join('\n')}\n你自己的生活以【你的生活】为准；只采用这里明确写出的内容，不要编。`;
  }
}
