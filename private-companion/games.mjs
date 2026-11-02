// 陪伴游戏的规则引擎（纯逻辑，不碰网络 / 存储，便于单测）。
//
// 对应原插件 Game 能力里的陪伴游戏（astrbot_host/native_extensions/game，原作 menglimi）。移植版只做
// "手机上就能玩、不依赖别的设备"的几种：井字棋、五子棋、掷骰竞分、二十一点由代码判定（角色的走法也由代码算，
// 不花副 API）；海龟汤、你画我猜要角色"动脑"，由 rooms.mjs 调副 API。中国象棋需要完整引擎，暂不提供。
//
// 每种游戏：init(random) → state；move(state, input, random) → { state, error? }；
// 状态里 over / winner（'user' | 'bot' | 'draw'）由引擎写，rooms.mjs 据此收尾。

export const GAMES = Object.freeze({
  tictactoe: '井字棋',
  gomoku: '五子棋',
  pig_dice: '掷骰竞分',
  blackjack: '二十一点',
  turtle_soup: '海龟汤',
  draw_guess: '你画我猜'
});

/** 这些需要副 API（海龟汤出题 / 答题，你画我猜看图）。 */
export const LLM_GAMES = new Set(['turtle_soup', 'draw_guess']);

const pick = (list, random) => list[Math.floor(random() * list.length) % list.length];

// ── 井字棋：对方 X 先手，角色 O；角色用极小化极大，15% 的时候随手下（不然永远赢不了，没意思） ──

const LINES3 = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function winner3(b) {
  for (const [a, c, d] of LINES3) if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  return b.every(Boolean) ? 'draw' : '';
}
function minimax3(b, turn) {
  const w = winner3(b);
  if (w === 'O') return { score: 1 };
  if (w === 'X') return { score: -1 };
  if (w === 'draw') return { score: 0 };
  let best = { score: turn === 'O' ? -2 : 2, at: -1 };
  for (let i = 0; i < 9; i += 1) {
    if (b[i]) continue;
    b[i] = turn;
    const r = minimax3(b, turn === 'O' ? 'X' : 'O');
    b[i] = '';
    if ((turn === 'O' && r.score > best.score) || (turn === 'X' && r.score < best.score)) best = { score: r.score, at: i };
  }
  return best;
}
const tictactoe = {
  init: () => ({ board: Array(9).fill(''), over: false, winner: '', last: -1 }),
  move(st, input, random) {
    const i = Number(input?.cell);
    if (st.over) return { state: st, error: '这局已经结束了' };
    if (!Number.isInteger(i) || i < 0 || i > 8 || st.board[i]) return { state: st, error: '这一格不能下' };
    const board = [...st.board];
    board[i] = 'X';
    let w = winner3(board);
    let last = i;
    if (!w) {
      const empty = board.map((v, k) => (v ? -1 : k)).filter((k) => k >= 0);
      const at = random() < 0.15 ? pick(empty, random) : minimax3([...board], 'O').at;
      board[at] = 'O';
      last = at;
      w = winner3(board);
    }
    const winner = w === 'X' ? 'user' : (w === 'O' ? 'bot' : (w === 'draw' ? 'draw' : ''));
    return { state: { board, over: Boolean(winner), winner, last } };
  }
};

// ── 五子棋：15×15，对方黑先，角色白；按棋型打分（攻守都看），取最高分的点 ──

const N = 15;
const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];
function line5(board, x, y, color) {
  for (const [dx, dy] of DIRS) {
    let n = 1;
    for (const s of [1, -1]) {
      let cx = x + dx * s; let cy = y + dy * s;
      while (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy * N + cx] === color) { n += 1; cx += dx * s; cy += dy * s; }
    }
    if (n >= 5) return true;
  }
  return false;
}
/** 在 (x,y) 落 color 后这一点的棋型分。 */
function shapeScore(board, x, y, color) {
  let total = 0;
  for (const [dx, dy] of DIRS) {
    let n = 1; let open = 0;
    for (const s of [1, -1]) {
      let cx = x + dx * s; let cy = y + dy * s;
      while (cx >= 0 && cx < N && cy >= 0 && cy < N && board[cy * N + cx] === color) { n += 1; cx += dx * s; cy += dy * s; }
      if (cx >= 0 && cx < N && cy >= 0 && cy < N && !board[cy * N + cx]) open += 1;
    }
    if (n >= 5) total += 1_000_000;
    else if (n === 4) total += open === 2 ? 100_000 : (open === 1 ? 12_000 : 0);
    else if (n === 3) total += open === 2 ? 8_000 : (open === 1 ? 600 : 0);
    else if (n === 2) total += open === 2 ? 400 : (open === 1 ? 60 : 0);
    else total += open * 4;
  }
  return total;
}
export function gomokuBotMove(board, random = Math.random) {
  if (!board.some(Boolean)) return 7 * N + 7;
  let best = -1; let bestScore = -1;
  for (let i = 0; i < N * N; i += 1) {
    if (board[i]) continue;
    const x = i % N; const y = Math.floor(i / N);
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
      const nx = x + dx; const ny = y + dy;
      if (nx >= 0 && nx < N && ny >= 0 && ny < N && board[ny * N + nx]) { near = true; break; }
    }
    if (!near) continue;
    // 进攻略重于防守；同分时随机一点，免得每局一样
    const score = shapeScore(board, x, y, 'W') * 1.1 + shapeScore(board, x, y, 'B') + random();
    if (score > bestScore) { bestScore = score; best = i; }
  }
  return best;
}
const gomoku = {
  init: () => ({ size: N, board: Array(N * N).fill(''), over: false, winner: '', last: -1, moves: 0 }),
  move(st, input, random) {
    const i = Number(input?.cell);
    if (st.over) return { state: st, error: '这局已经结束了' };
    if (!Number.isInteger(i) || i < 0 || i >= N * N || st.board[i]) return { state: st, error: '这里不能下' };
    const board = [...st.board];
    board[i] = 'B';
    let winner = line5(board, i % N, Math.floor(i / N), 'B') ? 'user' : '';
    let last = i;
    if (!winner) {
      const at = gomokuBotMove(board, random);
      if (at < 0) winner = 'draw';
      else {
        board[at] = 'W';
        last = at;
        if (line5(board, at % N, Math.floor(at / N), 'W')) winner = 'bot';
        else if (board.every(Boolean)) winner = 'draw';
      }
    }
    return { state: { ...st, board, over: Boolean(winner), winner, last, moves: st.moves + 1 } };
  }
};

// ── 掷骰竞分（Pig）：先到 50 分赢；掷到 1 本回合清零换人；角色本回合攒到 15 分（或够赢）就停 ──

const PIG_TARGET = 50;
function pigBotTurn(st, random) {
  const rolls = [];
  let turn = 0;
  for (let k = 0; k < 30; k += 1) {
    const d = 1 + Math.floor(random() * 6);
    rolls.push(d);
    if (d === 1) { turn = 0; break; }
    turn += d;
    if (turn >= 15 || st.scores.bot + turn >= PIG_TARGET) break;
  }
  const scores = { ...st.scores, bot: st.scores.bot + turn };
  return { scores, botRolls: rolls, botGained: turn };
}
const pig_dice = {
  init: () => ({ target: PIG_TARGET, scores: { user: 0, bot: 0 }, turn: 0, rolls: [], botRolls: [], botGained: 0, over: false, winner: '' }),
  move(st, input, random) {
    if (st.over) return { state: st, error: '这局已经结束了' };
    const action = String(input?.action || '');
    let next = { ...st, scores: { ...st.scores } };
    if (action === 'roll') {
      const d = 1 + Math.floor(random() * 6);
      next.rolls = [...st.rolls, d].slice(-20);
      if (d !== 1) {
        next.turn = st.turn + d;
        if (next.scores.user + next.turn >= PIG_TARGET) {
          next.scores.user += next.turn; next.turn = 0; next.over = true; next.winner = 'user';
        }
        return { state: next };
      }
      next.turn = 0;   // 掷到 1：本回合作废，轮到角色
    } else if (action === 'hold') {
      if (!st.turn) return { state: st, error: '先掷一次再停' };
      next.scores.user += st.turn;
      next.turn = 0;
      if (next.scores.user >= PIG_TARGET) { next.over = true; next.winner = 'user'; return { state: next }; }
    } else {
      return { state: st, error: '只能掷骰（roll）或停手（hold）' };
    }
    const bot = pigBotTurn(next, random);
    next = { ...next, ...bot, rolls: [] };
    if (next.scores.bot >= PIG_TARGET) { next.over = true; next.winner = 'bot'; }
    return { state: next };
  }
};

// ── 二十一点：角色当庄；对方要牌 / 停牌，庄家不到 17 点必须要；一局一结，可以接着下一局（记总比分） ──

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const drawCard = (random) => `${pick(SUITS, random)}${pick(RANKS, random)}`;
export function handValue(cards) {
  let total = 0; let aces = 0;
  for (const c of cards) {
    const r = c.slice(1);
    if (r === 'A') { aces += 1; total += 11; } else total += ['J', 'Q', 'K'].includes(r) ? 10 : Number(r);
  }
  while (total > 21 && aces) { total -= 10; aces -= 1; }
  return total;
}
function dealRound(st, random) {
  const user = [drawCard(random), drawCard(random)];
  const bot = [drawCard(random), drawCard(random)];
  return { ...st, user, bot, roundOver: false, result: '', round: (st.round || 0) + 1 };
}
function settle(st, random) {
  const bot = [...st.bot];
  const u = handValue(st.user);
  if (u <= 21) while (handValue(bot) < 17) bot.push(drawCard(random));
  const b = handValue(bot);
  let result;
  if (u > 21) result = 'bot';
  else if (b > 21 || u > b) result = 'user';
  else if (u < b) result = 'bot';
  else result = 'draw';
  const score = { ...st.score };
  if (result !== 'draw') score[result] += 1;
  return { ...st, bot, roundOver: true, result, score };
}
const blackjack = {
  init: (random) => dealRound({ score: { user: 0, bot: 0 }, over: false, winner: '' }, random),
  move(st, input, random) {
    const action = String(input?.action || '');
    if (action === 'next') {
      if (!st.roundOver) return { state: st, error: '这一局还没打完' };
      return { state: dealRound(st, random) };
    }
    if (action === 'end') {
      const s = st.score;
      return { state: { ...st, over: true, winner: s.user > s.bot ? 'user' : (s.user < s.bot ? 'bot' : 'draw') } };
    }
    if (st.roundOver) return { state: st, error: '这一局打完了，点「下一局」' };
    if (action === 'hit') {
      const next = { ...st, user: [...st.user, drawCard(random)] };
      return { state: handValue(next.user) > 21 ? settle(next, random) : next };
    }
    if (action === 'stand') return { state: settle(st, random) };
    return { state: st, error: '只能要牌（hit）、停牌（stand）、下一局（next）或结束（end）' };
  }
};

// ── 你画我猜：对方画、角色猜（副 API 看图，最多猜 3 次）。题目由代码出，不告诉角色 ──

export const DRAW_WORDS = ['猫', '房子', '太阳', '自行车', '雨伞', '鱼', '苹果', '月亮', '花', '汽车', '树', '眼镜', '蛋糕',
  '吉他', '雪人', '飞机', '钥匙', '手机', '西瓜', '小狗', '兔子', '星星', '蘑菇', '杯子', '船', '彩虹', '风筝', '冰淇淋'];
const draw_guess = {
  init: (random) => ({ word: pick(DRAW_WORDS, random), guesses: [], over: false, winner: '', rounds: 0, score: { user: 0, bot: 0 } }),
  // 猜的那一步要看图，由 rooms.mjs 异步完成后调 applyGuess；这里只处理换题 / 结束
  move(st, input, random) {
    const action = String(input?.action || '');
    if (action === 'next') return { state: { ...st, word: pick(DRAW_WORDS.filter((w) => w !== st.word), random), guesses: [], roundOver: false } };
    if (action === 'end') return { state: { ...st, over: true, winner: st.score.bot > 0 ? 'bot' : 'draw' } };
    return { state: st, error: '画好了点「让 TA 猜」' };
  }
};
const norm = (s) => String(s || '').replace(/[\s。！!？?，,、“”"'：:]/g, '').toLowerCase();
export function applyGuess(st, guess) {
  const g = String(guess || '').slice(0, 20);
  const right = Boolean(norm(g)) && norm(g).includes(norm(st.word));
  const guesses = [...st.guesses, { text: g, right }];
  const roundOver = right || guesses.length >= 3;
  const score = { ...st.score };
  if (right) score.bot += 1;
  return { ...st, guesses, roundOver, rounds: roundOver ? st.rounds + 1 : st.rounds, score };
}

// ── 海龟汤：副 API 出题（汤面 / 汤底），对方提问，角色只答"是 / 不是 / 无关 / 接近了"；对方说出汤底或放弃时揭晓 ──

const turtle_soup = {
  init: () => ({ title: '', surface: '', bottom: '', qa: [], over: false, winner: '', ready: false }),
  move(st, input) {
    if (String(input?.action || '') === 'reveal') return { state: { ...st, over: true, winner: 'bot', revealed: true } };
    return { state: st, error: '直接打字提问就行，想看答案点「揭晓」' };
  }
};

export const ENGINES = { tictactoe, gomoku, pig_dice, blackjack, turtle_soup, draw_guess };

/** 给对方看的状态（藏起不该看的：二十一点庄家暗牌、海龟汤汤底、你画我猜的题目只给画的人看——画的人就是对方，所以给）。 */
export function publicState(type, st) {
  if (type === 'blackjack') {
    const bot = st.roundOver ? st.bot : [st.bot[0], '🂠'];
    return { ...st, bot, userValue: handValue(st.user), botValue: st.roundOver ? handValue(st.bot) : null };
  }
  if (type === 'turtle_soup') {
    const { bottom, ...rest } = st;
    return st.over ? st : rest;
  }
  return st;
}

/** 一句话战况（给角色看 / 收尾记进背景）。 */
export function describe(type, st) {
  const name = GAMES[type] || type;
  const res = { user: '对方赢了', bot: '你赢了', draw: '平局' }[st.winner] || '还没下完';
  if (type === 'pig_dice') return `${name}：比分 对方 ${st.scores.user} : 你 ${st.scores.bot}，${res}`;
  if (type === 'blackjack') return `${name}：打了 ${st.round} 局，比分 对方 ${st.score.user} : 你 ${st.score.bot}`;
  if (type === 'draw_guess') return `${name}：对方画了 ${st.rounds} 幅，你猜中 ${st.score.bot} 幅`;
  if (type === 'turtle_soup') return `${name}「${st.title || '未出题'}」：对方问了 ${st.qa.length} 个问题${st.over ? '，已揭晓汤底' : ''}`;
  return `${name}：${res}`;
}
