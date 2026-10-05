// dev/make-fixtures.mjs — builds dev/fixtures/*.json by scripting REAL games with lib/engine.js and
// rendering them with lib/view.js, so every fixture is exactly what /api/state would return.
//
//   node dev/make-fixtures.mjs            → writes dev/fixtures/<name>.json + dev/fixtures/manifest.json
//
// Each fixture file: { name, title, description, view }. The preview harness (dev/preview.html)
// loads them through dev/fixtures/index.js.

import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../lib/engine.js';
import { viewFor } from '../lib/view.js';
import { fullDeck } from '../lib/cards.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const T0 = Date.UTC(2026, 9, 2, 19, 30, 0); // a Friday, 7:30pm

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── a scripted game ─────────────────────────────────────────────────────────

const ROSTER = {
  maya: 'Maya',
  alex: 'Alex',
  dev: 'Dev',
  ari: 'Ari',
  kim: 'Kim',
  leo: 'Leo',
  jonah: 'Jonah',
  priya: 'Priya',
  sam: 'Sam',
  theo: 'Theo',
  rosa: 'Rosa',
};

class Game {
  /**
   * seats: { pid: seatIndex }, stacks: { pid: n } (default 200·bb), host = first pid.
   * extra: pids that join but stay unseated.
   */
  constructor({ seats, stacks = {}, settings = {}, host = 'maya', extra = [], seed = 7, name = 'Friday Night Game', code = 'RVR-4821', pre = null }) {
    this.ctx = { now: T0, rng: mulberry32(seed) };
    this.version = 1;
    const s = { approveBuyIns: false, ...settings };
    this.state = E.createRoom(
      { code, name, hostName: ROSTER[host] || host, hostId: host, hostTokenHash: 'x', settings: s },
      this.ctx,
    );
    for (const pid of [...Object.keys(seats), ...extra]) {
      if (pid === host) continue;
      E.addPlayer(this.state, { id: pid, name: ROSTER[pid] || pid, tokenHash: 'x' }, this.ctx);
      this.ctx.now += 20_000;
    }
    if (pre) pre(this);
    const bb = this.state.settings.bb;
    for (const [pid, seat] of Object.entries(seats)) {
      const amount = stacks[pid] ?? Math.min(this.state.settings.maxBuyIn, Math.max(this.state.settings.minBuyIn, 100 * bb));
      this.do(pid, { type: 'sit', seat, amount }); // same instant: no hand starts mid-seating
    }
  }

  do(pid, action) {
    E.apply(this.state, pid, action, this.ctx);
    this.version++;
    return this;
  }

  get hand() {
    return this.state.hand;
  }

  wait(ms) {
    this.ctx.now += ms;
    if (E.tick(this.state, this.ctx)) this.version++;
    return this;
  }

  /** Jump to the pending deadline and process it. */
  fire() {
    if (this.state.deadline == null) throw new Error('no deadline pending');
    this.ctx.now = Math.max(this.ctx.now, this.state.deadline);
    E.tick(this.state, this.ctx);
    this.version++;
    return this;
  }

  deal() {
    // A chat/other action after seating may already have ticked the first deal in — that's fine.
    if (this.state.hand && this.state.hand.phase === 'betting' && this.state.hand.log.every((e) => !e.pid || /posts/.test(e.text))) return this;
    if (this.state.hand) throw new Error('hand already running');
    this.fire();
    if (!this.state.hand) throw new Error('no hand started');
    return this;
  }

  /** Finish a completed hand (fires the nextHand deadline → next hand dealt when possible). */
  next() {
    if (!this.hand || this.hand.phase !== 'complete') throw new Error('hand not complete');
    return this.fire();
  }

  /** Give hole cards / stack the deck (board cards come off the top in order). */
  rig(holes, board = []) {
    const h = this.state.hand;
    const taken = new Set([...Object.values(holes).flat(), ...board, ...h.board]);
    const pool = fullDeck().filter((c) => !taken.has(c));
    // deterministic shuffle of the remainder so "random" cards vary
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.ctx.rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const pid of h.order) h.ps[pid].hole = holes[pid] ? holes[pid].slice() : pool.splice(0, h.ps[pid].hole.length);
    h.deck = [...board, ...pool];
    return this;
  }

  /**
   * Play scripted moves for whoever is to act: 'fold' | 'check' | 'call' | 'raise:N' | 'allin' | 'cc' (check/call).
   * Each move is preceded by `think` ms of thinking time.
   */
  play(moves, think = 3_000) {
    for (const m of moves) {
      const h = this.state.hand;
      if (!h || h.phase !== 'betting') throw new Error('not betting (move ' + m + ')');
      const pid = h.toAct;
      const L = E.legalActions(this.state, pid);
      this.ctx.now += think;
      let a;
      if (m === 'cc') a = { type: 'act', move: L.check ? 'check' : 'call' };
      else if (m === 'allin') a = L.raise ? { type: 'act', move: 'raise', to: L.maxTo } : { type: 'act', move: 'call' };
      else if (m === 'pot') a = { type: 'act', move: 'raise', to: L.potTo };
      else if (m.startsWith('raise:')) a = { type: 'act', move: 'raise', to: Number(m.slice(6)) };
      else a = { type: 'act', move: m };
      this.do(pid, a);
    }
    return this;
  }

  /** Play moves until `pid` is to act (others: check/call). */
  until(pid, think = 3_000) {
    for (let i = 0; i < 40; i++) {
      const h = this.state.hand;
      if (!h || h.phase !== 'betting') throw new Error('hand stopped before ' + pid + ' was to act');
      if (h.toAct === pid) return this;
      this.play(['cc'], think);
    }
    throw new Error('never reached ' + pid);
  }

  toAct() {
    return this.state.hand && this.state.hand.toAct;
  }

  /** Random-but-sane play to the end of the hand. */
  autoplay(rng = this.ctx.rng) {
    let guard = 0;
    while (this.state.hand && this.state.hand.phase !== 'complete' && guard++ < 200) {
      const h = this.state.hand;
      if (h.phase === 'betting') {
        const pid = h.toAct;
        const L = E.legalActions(this.state, pid);
        const r = rng();
        const think = 2_000 + Math.floor(rng() * 9_000);
        this.ctx.now = Math.min(this.ctx.now + think, (this.state.deadline ?? Infinity) - 1);
        if (!L.check && r < 0.28) this.do(pid, { type: 'act', move: 'fold' });
        else if (L.raise && r > 0.86) {
          const to = Math.min(L.maxTo, Math.max(L.minTo, Math.round(L.potTo * (0.5 + rng() * 0.4))));
          this.do(pid, { type: 'act', move: 'raise', to });
        } else this.do(pid, { type: 'act', move: L.check ? 'check' : 'call' });
      } else if (h.phase === 'ritVote') {
        for (const v of h.ritVoters) if (h.ritVotes[v] == null) this.do(v, { type: 'vote', runs: 1 });
      } else this.fire();
    }
    return this;
  }

  view(pid, { at } = {}) {
    const now = at != null ? at : this.ctx.now;
    return viewFor(this.state, pid, this.version, now);
  }
}

// ─── fixtures ────────────────────────────────────────────────────────────────

const fixtures = [];
function fixture(name, title, description, build) {
  try {
    const view = build();
    fixtures.push({ name, title, description, view });
  } catch (err) {
    console.error(`✗ ${name}: ${(err.stack || String(err)).split('\n').slice(0, 3).join('\n')}`);
    process.exitCode = 1;
  }
}

const SIX = { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4, leo: 5 };
const SIX_STACKS = { maya: 412, dev: 268, ari: 530, alex: 476, kim: 190, leo: 333 };

function chat(g, pid, text, dt = 30_000) {
  g.ctx.now += dt;
  g.do(pid, { type: 'chat', text });
}

function sixGame(opts = {}) {
  return new Game({
    seats: SIX,
    stacks: SIX_STACKS,
    settings: { seats: 8, maxBuyIn: 600, ...(opts.settings || {}) },
    seed: opts.seed ?? 11,
    extra: opts.extra || [],
    pre: (g) => {
      chat(g, 'dev', 'who brought the snacks');
      chat(g, 'kim', 'Leo did. again. legend', 12_000);
      chat(g, 'leo', 'gl all 🍀', 9_000);
    },
  });
}

fixture('visitor', 'Visitor (no session)', 'Someone opened the invite link and has not joined yet: JoinPrompt over a live table.', () => {
  const g = sixGame();
  g.deal().rig({ dev: ['Ks', 'Kc'] }, ['Kh', '9c', '4d', '2s', 'Jh']);
  g.play(['raise:6', 'cc', 'cc', 'cc', 'fold', 'cc']); // preflop
  g.until(g.toAct());
  g.play(['check', 'raise:18']);
  g.ctx.now += 4_000;
  return g.view(null);
});

fixture('spectator', 'Spectator (joined, no seat)', 'Joined but not seated — watching a hand on the flop. Empty seats show “Sit”.', () => {
  const g = sixGame({ extra: ['priya'] });
  g.deal().rig({}, ['Kh', '9c', '4d', '2s', 'Jh']);
  g.play(['raise:6', 'cc', 'cc', 'cc', 'fold', 'cc']);
  g.play(['check', 'raise:14']);
  g.ctx.now += 5_000;
  return g.view('priya');
});

fixture('seated-waiting', 'Seated, waiting', 'In the hand on the flop; someone else is deciding.', () => {
  const g = sixGame();
  g.deal().rig({ alex: ['Kd', 'Qd'] }, ['Kh', '9c', '4d', '2s', 'Jh']);
  // button = seat 0 (maya); order: dev(SB) ari(BB) alex kim leo maya
  g.play(['raise:6', 'cc', 'cc', 'fold', 'cc']); // alex raises to 6, kim calls, leo calls, maya folds, dev calls
  if (g.hand.street === 'preflop') g.play(['cc']);
  // flop: dev first
  g.play(['check', 'raise:18', 'cc']);
  g.ctx.now += 6_000;
  return g.view('alex');
});

fixture('my-turn-preflop', 'My turn — preflop', 'Hero in the big blind faces a raise and a call preflop (NLH). Countdown running.', () => {
  const g = sixGame({ seed: 14 });
  g.deal().autoplay(); // hand #1 moves the button to Dev
  g.next().rig({ alex: ['Ah', 'Kd'] });
  // first player in raises to 7, then alternate call / fold round to the hero
  const moves = ['raise:7', 'cc', 'fold', 'fold', 'cc', 'fold', 'cc'];
  for (let i = 0; g.toAct() !== 'alex'; i++) g.play([moves[i]]);
  g.ctx.now += 9_000;
  return g.view('alex');
});

fixture('my-turn-facing-bet', 'My turn — facing a bet (NLH)', 'Turn: Dev bets 60, Ari calls, hero to act with top pair.', () => {
  const g = sixGame({ seed: 5 });
  g.deal().rig({ alex: ['Kd', 'Qs'], dev: ['9h', '9s'] }, ['Kh', '9c', '4d', '2s', 'Jh']);
  // preflop: alex raises 6, kim folds, leo calls, maya folds, dev calls, ari calls
  g.play(['raise:6', 'fold', 'cc', 'fold', 'cc', 'cc']);
  // flop: dev, ari, alex, leo
  g.play(['raise:18', 'cc', 'cc', 'cc']);
  // turn: dev bets 60, ari calls, alex to act
  g.play(['raise:60', 'cc']);
  if (g.toAct() !== 'alex') g.until('alex');
  g.ctx.now += 11_000;
  return g.view('alex');
});

fixture('my-turn-facing-bet-plo', 'My turn — facing a bet (PLO)', 'Pot-Limit Omaha flop: hero faces a pot bet; raise capped at pot.', () => {
  const g = new Game({
    seats: { maya: 0, dev: 1, alex: 2, kim: 3, leo: 4 },
    stacks: { maya: 400, dev: 380, alex: 520, kim: 260, leo: 300 },
    settings: { variant: 'PLO', sb: 1, bb: 2, seats: 6, maxBuyIn: 600 },
    seed: 21,
  });
  g.deal().rig({ alex: ['Ah', 'Kh', 'Qd', 'Jc'], dev: ['9s', '9d', '8c', '7c'] }, ['Th', '9c', '2h', '5s', 'Ad']);
  // button maya(0); order dev SB, alex BB, kim, leo, maya
  g.play(['raise:7', 'cc', 'fold', 'cc', 'cc']); // kim raises 7, leo calls, maya folds, dev calls, alex calls
  if (g.hand.street === 'preflop') g.play(['cc']);
  // flop: dev first → pot bet
  g.play(['pot']);
  if (g.toAct() !== 'alex') g.until('alex');
  g.ctx.now += 4_000;
  return g.view('alex');
});

fixture('allin-vote', 'All-in — run it vote', 'Hero all-in on the flop against Dev; Dev voted twice, hero has not voted yet.', () => {
  const g = new Game({ seats: { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4 }, stacks: { maya: 300, dev: 520, ari: 210, alex: 236, kim: 400 }, settings: { maxRuns: 3, maxBuyIn: 600 }, seed: 3 });
  g.deal().rig({ alex: ['Ah', 'Kh'], dev: ['Qs', 'Qd'] }, ['Qh', '7h', '2c', '5d', '9s']);
  // button maya(0) → dev SB, ari BB, alex, kim, maya
  g.play(['raise:6', 'fold', 'fold', 'cc', 'fold']); // alex raises, kim/maya fold, dev calls, ari folds
  // flop: dev bets, alex jams, dev calls
  g.play(['raise:12', 'allin', 'call']);
  if (g.hand.phase !== 'ritVote') throw new Error('expected ritVote, got ' + g.hand.phase);
  g.ctx.now += 1_500;
  g.do('dev', { type: 'vote', runs: 2 });
  g.ctx.now += 2_500;
  return g.view('alex');
});

fixture('runout-2-boards', 'Running it twice', 'Both voted twice: run 1 finished, run 2 mid-deal; equity shown under each player.', () => {
  const g = new Game({ seats: { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4 }, stacks: { maya: 300, dev: 520, ari: 210, alex: 236, kim: 400 }, settings: { maxRuns: 3, maxBuyIn: 600 }, seed: 3 });
  g.deal().rig({ alex: ['Ah', 'Kh'], dev: ['Qs', 'Qd'] }, ['Qh', '7h', '2c', '5d', '9s', 'Th', 'Kc']);
  g.play(['raise:6', 'fold', 'fold', 'cc', 'fold']);
  g.play(['raise:12', 'allin', 'call']);
  g.ctx.now += 1_500;
  g.do('dev', { type: 'vote', runs: 2 });
  g.ctx.now += 2_000;
  g.do('alex', { type: 'vote', runs: 2 });
  // runout: run 0 turn, river; run 1 turn
  for (let i = 0; i < 3 && g.hand.phase === 'runout'; i++) g.fire();
  g.ctx.now += 600;
  return g.view('alex');
});

fixture('showdown-complete', 'Showdown complete', 'River showdown: Dev wins with a set, hero lost and may show; next-hand countdown.', () => {
  const g = sixGame({ seed: 5 });
  g.deal().rig({ alex: ['Kd', 'Qs'], dev: ['9h', '9s'] }, ['Kh', '9c', '4d', '2s', 'Jh']);
  g.play(['raise:6', 'fold', 'cc', 'fold', 'cc', 'cc']);
  g.play(['raise:18', 'cc', 'cc', 'cc']);
  g.play(['raise:60', 'fold', 'cc', 'fold']);
  // river: dev bets, alex calls
  g.play(['raise:120', 'cc']);
  if (g.hand.phase !== 'complete') throw new Error('expected complete, got ' + g.hand.phase);
  g.ctx.now += 2_000;
  return g.view('alex');
});

fixture('fold-ending-runout-revealed', 'Fold ending — runout revealed', 'Everyone folded to Dev’s turn bet; hero revealed the cards that would have come.', () => {
  const g = sixGame({ seed: 8 });
  g.deal().rig({ alex: ['Jd', 'Td'], dev: ['As', '8s'] }, ['Qd', '7c', '2d', 'Ks', '9d']);
  g.play(['raise:6', 'fold', 'fold', 'fold', 'cc', 'fold']); // alex raise, kim/leo/maya fold, dev call, ari fold
  g.play(['raise:9', 'cc']); // flop dev bets, alex calls
  g.play(['raise:40', 'fold']); // turn dev bets, alex folds
  if (g.hand.phase !== 'complete') throw new Error('expected complete');
  g.ctx.now += 1_800;
  g.do('alex', { type: 'revealRunout' });
  g.ctx.now += 700;
  return g.view('alex');
});

fixture('away', 'Away', 'Hero is away; the table keeps playing without them.', () => {
  const g = sixGame();
  g.deal().autoplay();
  g.ctx.now += 2_000;
  g.do('alex', { type: 'away', on: true });
  g.next(); // next hand without alex
  g.rig({});
  g.play(['raise:5', 'cc']);
  g.ctx.now += 3_000;
  return g.view('alex');
});

fixture('busted', 'Busted', 'Hero lost their whole stack; the next hand runs without them. Request a buy-in.', () => {
  const g = new Game({ seats: { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4 }, stacks: { maya: 300, dev: 520, ari: 210, alex: 120, kim: 400 }, settings: { maxRuns: 1, maxBuyIn: 600 }, seed: 9 });
  g.deal().rig({ alex: ['Ac', 'Qc'], dev: ['Js', 'Jd'] }, ['Jh', '8c', '3s', '5d', '2h']);
  g.play(['raise:6', 'fold', 'fold', 'cc', 'fold']);
  g.play(['raise:10', 'allin', 'call']);
  while (g.hand.phase !== 'complete') g.fire();
  g.next();
  g.rig({});
  g.play(['cc']);
  g.ctx.now += 4_000;
  return g.view('alex');
});

fixture('host-with-requests', 'Host with pending requests', 'Hero is the host; a seat request and a rebuy are waiting for approval.', () => {
  const g = new Game({
    seats: { maya: 3, dev: 0, ari: 1, kim: 4, leo: 5 },
    stacks: { maya: 412, dev: 268, ari: 530, kim: 190, leo: 333 },
    settings: { seats: 8, maxBuyIn: 600 },
    extra: ['jonah', 'priya'],
    seed: 12,
  });
  g.do('maya', { type: 'settings', patch: { approveBuyIns: true } });
  g.deal().rig({ maya: ['8c', '8d'] }, ['Kh', '9c', '4d', '2s', 'Jh']);
  g.ctx.now += 5_000;
  g.do('jonah', { type: 'sit', seat: 6, amount: 200 });
  g.ctx.now += 9_000;
  g.do('kim', { type: 'buyin', amount: 200 });
  g.play(['raise:6', 'cc', 'cc']);
  chat(g, 'jonah', 'can I jump in? 🙏', 4_000);
  g.ctx.now += 3_000;
  return g.view('maya');
});

function longSession() {
  const g = new Game({
    seats: { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4, leo: 5, jonah: 6, priya: 7 },
    stacks: { maya: 200, dev: 200, ari: 200, alex: 200, kim: 200, leo: 300, jonah: 200, priya: 400 },
    settings: { seats: 8, minBuyIn: 100, maxBuyIn: 400, maxRuns: 2 },
    seed: 42,
  });
  const rng = mulberry32(99);
  for (let n = 0; n < 41; n++) {
    if (!g.hand) g.deal();
    g.autoplay(rng);
    // rebuys for anyone short / busted, now and then
    for (const p of Object.values(g.state.players)) {
      if (p.seat == null || p.leaveAfterHand) continue;
      const hand = g.state.hand;
      if (p.stack === 0 && !(hand && hand.ps[p.id] && hand.phase !== 'complete')) {
        if (n < 34) g.do(p.id, { type: 'buyin', amount: 200 });
      }
    }
    if (n === 18) g.do('maya', { type: 'adjust', pid: 'leo', mode: 'add', amount: 50, reason: 'Cash rebuy', countAsBuyIn: true });
    if (n === 26 && g.state.players.priya.seat != null) g.do('priya', { type: 'leave', afterHand: true });
    if (n === 29) chat(g, 'priya', 'thanks all, gotta run ✌️', 5_000);
    g.next();
  }
  return g;
}

fixture('ledger-after-session', 'Ledger after a long session', '41 hands with rebuys, an adjustment and a cash-out; hero is the host (open the Ledger).', () => {
  const g = longSession();
  if (g.hand && g.hand.phase !== 'complete') g.autoplay();
  const s = (summarize) => summarize;
  void s;
  // mark the first settlement as paid
  const v0 = g.view('maya');
  const first = v0.ledger.settlement && v0.ledger.settlement[0];
  if (first) g.do('maya', { type: 'markPaid', key: first.key, paid: true });
  g.ctx.now += 1_000;
  return g.view('maya');
});

fixture('ended', 'Game ended', 'The host ended the game: everyone cashed out; read-only ledger and settle-up.', () => {
  const g = longSession();
  if (g.hand && g.hand.phase !== 'complete') g.autoplay();
  g.do('maya', { type: 'endGame' });
  while (g.state.hand) g.fire();
  g.ctx.now += 3_000;
  return g.view('alex');
});

fixture('9-handed', '9-handed', 'Full ring: nine players, bets out on the flop, one away, one folded.', () => {
  const g = new Game({
    seats: { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4, leo: 5, jonah: 6, priya: 7, sam: 8 },
    stacks: { maya: 412, dev: 268, ari: 530, alex: 476, kim: 190, leo: 333, jonah: 254, priya: 388, sam: 600 },
    settings: { seats: 9, maxBuyIn: 600 },
    seed: 17,
  });
  g.deal().rig({ alex: ['Th', 'Ts'] }, ['Ts', '6c', '3h', 'Ad', 'Kc'].filter((c) => c !== 'Ts').concat([]));
  g.play(['raise:6', 'fold', 'cc', 'cc', 'fold', 'cc', 'fold', 'cc', 'cc']);
  while (g.hand.street === 'preflop') g.play(['cc']);
  g.play(['check', 'raise:20', 'cc']);
  g.ctx.now += 3_000;
  g.do('sam', { type: 'away', on: true, afterHand: true });
  return g.view('alex');
});

fixture('heads-up', 'Heads-up', 'Two players; hero is on the button (small blind) and acts first preflop.', () => {
  const g = new Game({ seats: { maya: 0, alex: 4 }, stacks: { maya: 380, alex: 420 }, settings: { seats: 6, maxBuyIn: 600 }, seed: 4 });
  g.deal().rig({ alex: ['Qc', 'Jc'] });
  if (g.toAct() !== 'alex') g.until('alex');
  g.ctx.now += 2_000;
  return g.view('alex');
});

fixture('paused-between-hands', 'Paused', 'Host paused the game between hands; hero is seated.', () => {
  const g = sixGame();
  g.deal().autoplay();
  g.do('maya', { type: 'pause', on: true });
  g.next();
  g.ctx.now += 5_000;
  return g.view('alex');
});

// ─── states found in review (each must keep working; test/e2e.mjs checks them in the preview) ─────

/** Everyone still in folds until one player is left. */
function foldOut(g) {
  for (let i = 0; i < 20 && g.hand && g.hand.phase === 'betting'; i++) g.play(['fold']);
  if (!g.hand || g.hand.phase !== 'complete' || g.hand.results.endedBy !== 'fold') throw new Error('expected a fold ending');
}

fixture('away-hand-complete', 'Away — hand over', 'Hero went away mid-hand and was folded; the hand ended by fold. Hero can still show and reveal the runout.', () => {
  const g = sixGame({ seed: 12 });
  g.deal();
  g.ctx.now += 2_000;
  g.do('alex', { type: 'away', on: true });
  foldOut(g);
  g.ctx.now += 1_500;
  const v = g.view('alex');
  if (!v.me.away || !v.hand.canShow || !v.hand.canRevealRunout) throw new Error('away hero should be able to show and reveal');
  return v;
});

fixture('spectator-fold-ending', 'Spectator — fold ending', 'Joined but not seated; the hand ended by fold and anyone may reveal the runout.', () => {
  const g = sixGame({ extra: ['priya'], seed: 13 });
  g.deal();
  foldOut(g);
  g.ctx.now += 1_500;
  const v = g.view('priya');
  if (v.me.seat != null || !v.hand.canRevealRunout) throw new Error('spectator should be able to reveal the runout');
  return v;
});

fixture('removed-by-host', 'Removed by the host (all-in)', 'Hero is all-in; the host removed them, so they are cashed out when the hand ends (no “Stay seated”).', () => {
  const g = new Game({ seats: { maya: 0, alex: 1, dev: 2, ari: 3 }, stacks: { maya: 300, alex: 40, dev: 300, ari: 300 }, settings: { minBuyIn: 20 }, seed: 14 });
  g.deal();
  g.until('alex');
  g.play(['allin']);
  g.ctx.now += 1_000;
  g.do('maya', { type: 'remove', pid: 'alex' });
  const v = g.view('alex');
  if (!v.me.leaveAfterHand || !v.me.removedByHost) throw new Error('expected a deferred host removal');
  return v;
});

// ─── write ───────────────────────────────────────────────────────────────────

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.json')) unlinkSync(path.join(OUT, f));
for (const f of fixtures) {
  writeFileSync(path.join(OUT, f.name + '.json'), JSON.stringify(f, null, 1) + '\n');
}
writeFileSync(
  path.join(OUT, 'manifest.json'),
  JSON.stringify(fixtures.map(({ name, title, description }) => ({ name, title, description })), null, 2) + '\n',
);
console.log(`wrote ${fixtures.length} fixtures to ${path.relative(process.cwd(), OUT) || OUT}`);
for (const f of fixtures) {
  const v = f.view;
  const h = v.hand;
  console.log(
    `  ${f.name.padEnd(30)} ${h ? `hand #${h.no} ${h.phase}/${h.street} toAct=${h.toAct}` : 'no hand'}${v.me ? ` me=${v.me.name}${v.me.away ? ' away' : ''}${v.me.busted ? ' busted' : ''}` : ' (anonymous)'}${v.ended ? ' ENDED' : ''}${v.paused ? ' paused' : ''}`,
  );
}
