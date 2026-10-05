// Property-based fuzzing of the server-side poker logic: lib/engine.js, lib/view.js, lib/ledger.js.
//
//   node --test test/fuzz.test.js                   ~2,000 hands (fast, default)
//   FELT_FUZZ=1 node --test test/fuzz.test.js       30,000 hands
//   FELT_FUZZ_HANDS=n FELT_FUZZ_SEED=s ...          custom size / master seed (failures print the game seed)
//
// A seeded driver plays many random games: 2..9 seats, NLH and PLO, stacks from 1 chip up, legal moves
// picked from viewFor(...).hand.legal, deliberately illegal moves (which must throw EngineError and leave
// the state byte-for-byte unchanged), clock jumps of every size, away/back, leaving now/after the hand,
// host adjust/remove/setAway, buy-ins/rebuys/approvals, run-it votes, show, revealRunout, pause, settings
// changes, host transfer and ending the game.
//
// After EVERY step the whole state is checked against invariants (chip conservation, no negative chips,
// exactly one valid player to act, deadline kind matches the phase, every card accounted for, cards dealt
// from the front of the deck), every viewer's view is scanned for hidden cards / the deck / token hashes,
// and the ledger must balance and settle. Every finished hand is re-played from its log by an independent
// betting referee and its pots / awards / reveals are recomputed with an independent brute-force evaluator
// and side-pot calculator.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../lib/engine.js';
import { viewFor } from '../lib/view.js';
import { summarize } from '../lib/ledger.js';
import { evaluateFor } from '../lib/evaluator.js';

const BIG = !!process.env.FELT_FUZZ && process.env.FELT_FUZZ !== '0';
const TOTAL_HANDS = Number(process.env.FELT_FUZZ_HANDS) || (BIG ? 30000 : 2000);
const MASTER_SEED = Number(process.env.FELT_FUZZ_SEED) || 0x5eed;
const T0 = 1_700_000_000_000;
const MAX_STEPS_PER_HAND = 4000; // driver steps while one hand is running (the driver acts ~60% of steps)
const MAX_DRAIN_JUMPS = 80; // deadline jumps for an unattended hand to finish (9 players × 4 streets + 3 runs + vote)

// ─── seeded randomness ───────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── independent reference evaluator (brute force over every 5-card hand) ─────

const RANK = '23456789TJQKA';
const rankV = (c) => RANK.indexOf(c[0]) + 2;

/** Score of exactly five cards: category * 16^5 + tie-breakers (base 16). */
function score5(cs) {
  const r = cs.map(rankV).sort((a, b) => b - a);
  const flush = cs.every((c) => c[1] === cs[0][1]);
  const cnt = new Map();
  for (const x of r) cnt.set(x, (cnt.get(x) || 0) + 1);
  const g = [...cnt].sort((a, b) => b[1] - a[1] || b[0] - a[0]); // [rank, count]
  let straight = 0;
  if (cnt.size === 5) {
    if (r[0] - r[4] === 4) straight = r[0];
    else if (r[0] === 14 && r[1] === 5) straight = 5; // wheel
  }
  let cat;
  let tb;
  if (straight && flush) [cat, tb] = [8, [straight]];
  else if (g[0][1] === 4) [cat, tb] = [7, [g[0][0], g[1][0]]];
  else if (g[0][1] === 3 && g[1][1] === 2) [cat, tb] = [6, [g[0][0], g[1][0]]];
  else if (flush) [cat, tb] = [5, r];
  else if (straight) [cat, tb] = [4, [straight]];
  else if (g[0][1] === 3) [cat, tb] = [3, g.map((x) => x[0])];
  else if (g[0][1] === 2 && g[1][1] === 2) [cat, tb] = [2, g.map((x) => x[0])];
  else if (g[0][1] === 2) [cat, tb] = [1, g.map((x) => x[0])];
  else [cat, tb] = [0, r];
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 16 + (tb[i] || 0);
  return s;
}
const catOf = (s) => Math.floor(s / 16 ** 5);

function combos(n, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) return void out.push(acc.slice());
    for (let i = start; i < n; i++) {
      acc.push(i);
      rec(i + 1, acc);
      acc.pop();
    }
  };
  rec(0, []);
  return out;
}
const C75 = combos(7, 5);
const C42 = combos(4, 2);
const C53 = combos(5, 3);

function refScore(variant, hole, board) {
  let best = -1;
  if (variant === 'PLO') {
    for (const h of C42) for (const b of C53) best = Math.max(best, score5([hole[h[0]], hole[h[1]], board[b[0]], board[b[1]], board[b[2]]]));
  } else {
    const all = [...hole, ...board];
    for (const c of C75) best = Math.max(best, score5(c.map((i) => all[i])));
  }
  return best;
}

// ─── independent side pots + awards ──────────────────────────────────────────

const cwFromButton = (button, seat) => (((seat - button - 1) % 64) + 64) % 64; // left of the button = 0, button = 63

/** Peel layers off the live players' commitments, smallest first; folded chips are dead money. */
function refPots(hand) {
  const rem = new Map(hand.order.map((pid) => [pid, hand.ps[pid].committed]));
  const live = hand.order.filter((pid) => !hand.ps[pid].folded);
  const pots = [];
  for (;;) {
    const open = live.filter((pid) => rem.get(pid) > 0);
    if (!open.length) break;
    const step = Math.min(...open.map((pid) => rem.get(pid)));
    let amount = 0;
    for (const pid of hand.order) {
      const t = Math.min(rem.get(pid), step);
      amount += t;
      rem.set(pid, rem.get(pid) - t);
    }
    pots.push({ amount, eligible: open });
  }
  let left = 0;
  for (const v of rem.values()) left += v;
  if (left) {
    if (pots.length) pots[pots.length - 1].amount += left;
    else pots.push({ amount: left, eligible: live });
  }
  return pots;
}

function refAwards(hand, boards) {
  const pots = refPots(hand);
  const awards = {};
  const contestedWinners = new Set();
  const add = (pid, n) => (awards[pid] = (awards[pid] || 0) + n);
  const runs = boards.length;
  const scores = boards.map((b) => {
    const m = {};
    for (const pid of hand.order) if (!hand.ps[pid].folded) m[pid] = refScore(hand.variant, hand.ps[pid].hole, b);
    return m;
  });
  for (const pot of pots) {
    if (pot.eligible.length === 1) {
      add(pot.eligible[0], pot.amount);
      continue;
    }
    const base = Math.floor(pot.amount / runs);
    for (let r = 0; r < runs; r++) {
      const part = base + (r === 0 ? pot.amount % runs : 0);
      const best = Math.max(...pot.eligible.map((pid) => scores[r][pid]));
      const ws = pot.eligible
        .filter((pid) => scores[r][pid] === best)
        .sort((a, b) => cwFromButton(hand.button, hand.ps[a].seat) - cwFromButton(hand.button, hand.ps[b].seat));
      const share = Math.floor(part / ws.length);
      const odd = part - share * ws.length;
      ws.forEach((w, i) => {
        add(w, share + (i < odd ? 1 : 0));
        contestedWinners.add(w);
      });
    }
  }
  return { pots, awards, contestedWinners, scores };
}

// ─── independent betting referee: re-plays a finished hand from its log ───────

const streetLabel = (len) => (len === 0 ? 'Flop' : len === 3 ? 'Turn' : 'River');

const PARTIAL = Symbol('partial');

/**
 * With `partial` (hand still in its betting phase) the replay stops where the log ends and returns the
 * referee's own view of the betting: who must act, the bet to match, the min raise, and per-player
 * bets / raise permission — compared against the engine at every step.
 */
function referee(hand, partial = false) {
  const n = hand.order.length;
  const P = hand.order.map((pid) => ({
    pid,
    seat: hand.ps[pid].seat,
    stack: hand.ps[pid].startStack,
    bet: 0,
    committed: 0,
    folded: false,
    allIn: false,
    acted: false,
    matched: 0,
    locked: false,
  }));
  const by = Object.fromEntries(P.map((p) => [p.pid, p]));
  const log = hand.log;
  let i = 0;
  const next = (what) => {
    if (partial && i >= log.length) throw PARTIAL;
    const e = log[i++];
    assert.ok(e, `hand log ended early (expected ${what})`);
    return e;
  };
  const put = (p, a) => {
    assert.ok(a >= 0 && a <= p.stack, 'a player put in more chips than they had');
    p.stack -= a;
    p.bet += a;
    p.committed += a;
  };

  // Seating order: clockwise from the seat left of the button, button last.
  for (let k = 1; k < n; k++) assert.ok(cwFromButton(hand.button, P[k - 1].seat) < cwFromButton(hand.button, P[k].seat), 'hand order is clockwise');
  assert.equal(P[n - 1].seat, hand.button, 'the button is dealt in and acts last');
  for (const p of P) assert.ok(p.stack > 0, 'only players with chips are dealt in');
  const sbP = n === 2 ? P[1] : P[0];
  const bbP = n === 2 ? P[0] : P[1];
  assert.equal(hand.sbSeat, sbP.seat, 'small blind seat');
  assert.equal(hand.bbSeat, bbP.seat, 'big blind seat');
  for (const [p, amt, what] of [
    [sbP, hand.sb, 'small blind'],
    [bbP, hand.bb, 'big blind'],
  ]) {
    const e = next(what);
    assert.equal(e.pid, p.pid, `${what} posted by the right player`);
    const a = Math.min(amt, p.stack);
    put(p, a);
    if (p.stack === 0) p.allIn = true;
    assert.equal(e.text, `posts ${what}${p.allIn ? ' (all-in)' : ''}`);
    assert.equal(e.amount, a);
  }
  let currentBet = Math.max(sbP.bet, bbP.bet);
  let minRaise = hand.bb;
  let boardLen = 0;
  let lastAggressor = null;
  const dealt = [];
  const live = () => P.filter((p) => !p.folded);
  const needs = (p) => !p.folded && !p.allIn && (!p.acted || p.bet < currentBet);
  const nextFrom = (idx) => {
    for (let k = 0; k < n; k++) {
      const p = P[(idx + k) % n];
      if (needs(p)) return p;
    }
    return null;
  };
  const done = () => {
    const L = live();
    if (L.length <= 1) return true;
    const A = L.filter((p) => !p.allIn);
    if (A.length === 0) return true;
    if (A.length === 1) return A[0].bet >= currentBet;
    return A.every((p) => p.acted && p.bet === currentBet);
  };
  let ended = null;
  let expected = null;
  let oofCloses = 0;
  const closeStreet = () => {
    if (live().length <= 1) return void (ended = 'fold');
    for (const p of P) Object.assign(p, { bet: 0, acted: false, locked: false, matched: 0 });
    currentBet = 0;
    minRaise = hand.bb;
    if (boardLen === 5) return void (ended = 'showdown');
    if (live().filter((p) => !p.allIn).length <= 1) return void (ended = 'runout');
    const e = next('a street');
    assert.equal(e.pid, null, `expected ${streetLabel(boardLen)}, got "${e.text}"`);
    assert.equal(e.text, streetLabel(boardLen));
    const k = boardLen === 0 ? 3 : 1;
    assert.equal(e.cards.length, k);
    dealt.push(...e.cards);
    boardLen += k;
    expected = nextFrom(0);
    assert.ok(expected, 'someone acts on a new street');
  };
  if (done()) closeStreet();
  else expected = nextFrom(n === 2 ? 1 : 2 % n);

  while (!ended) {
    let e;
    try {
      e = next('an action');
    } catch (err) {
      if (err !== PARTIAL) throw err;
      return { partial: true, expected: expected && expected.pid, currentBet, minRaise, P, boardLen };
    }
    assert.notEqual(e.pid, null, `unexpected "${e.text}" while ${expected && expected.pid} is to act`);
    const p = by[e.pid];
    assert.ok(p, 'log entry for a player who was not dealt in');
    const t = e.text;
    if (/^folds \((left the table|removed by host)\)$/.test(t) && p !== expected) {
      assert.ok(!p.folded && !p.allIn, 'only a live, not-all-in player folds out of turn');
      p.folded = true;
      if (live().length <= 1) ended = 'fold';
      else if (done()) {
        oofCloses++;
        closeStreet();
      }
      continue;
    }
    assert.equal(p.pid, expected && expected.pid, `"${t}" out of turn (expected ${expected && expected.pid})`);
    const idx = P.indexOf(p);
    if (/^folds/.test(t)) {
      if (/\((timed out|away)\)$/.test(t)) assert.ok(p.bet < currentBet, 'an automatic fold when checking was free');
      p.folded = true;
    } else if (/^checks/.test(t)) {
      assert.equal(p.bet, currentBet, 'a check facing a bet');
    } else if (t === 'calls' || t === 'calls all-in') {
      assert.ok(p.bet < currentBet, 'a call with nothing to call');
      put(p, Math.min(currentBet - p.bet, p.stack));
      if (p.stack === 0) p.allIn = true;
      assert.equal(t === 'calls all-in', p.allIn);
      assert.equal(e.amount, p.bet);
    } else if (t === 'bets' || t === 'raises to' || t === 'all-in') {
      const to = e.amount;
      const allInTo = p.bet + p.stack;
      assert.ok(
        P.some((q) => q !== p && !q.folded && !q.allIn),
        'a raise when nobody else can act',
      );
      assert.ok(!p.locked, 'a re-raise after a short all-in that did not reopen the betting');
      assert.ok(Number.isInteger(to) && to > currentBet && to <= allInTo, `raise to ${to} (current ${currentBet}, all-in ${allInTo})`);
      const isAllIn = to === allInTo;
      assert.equal(t === 'all-in', isAllIn, `"${t}" vs all-in`);
      if (!isAllIn) {
        assert.ok(to >= currentBet + minRaise, `raise to ${to} below the minimum ${currentBet + minRaise}`);
        assert.equal(t, currentBet === 0 ? 'bets' : 'raises to');
      }
      if (hand.variant === 'PLO') {
        const pot = P.reduce((a, q) => a + q.committed, 0);
        const potTo = currentBet + pot + (currentBet - p.bet);
        assert.ok(to <= Math.max(potTo, currentBet + minRaise), `PLO raise to ${to} above the pot (${potTo})`);
      }
      const inc = to - currentBet;
      put(p, to - p.bet);
      if (p.stack === 0) p.allIn = true;
      currentBet = to;
      lastAggressor = p.pid;
      if (inc >= minRaise) {
        minRaise = inc;
        for (const q of P) if (q !== p && !q.folded && !q.allIn) Object.assign(q, { acted: false, locked: false });
      } else {
        for (const q of P) if (q !== p && !q.folded && !q.allIn && q.acted) q.locked = currentBet - q.matched < minRaise;
      }
    } else {
      assert.fail(`unexpected log entry "${t}" during the betting`);
    }
    p.acted = true;
    p.matched = currentBet;
    if (live().length <= 1) ended = 'fold';
    else if (done()) closeStreet();
    else {
      expected = nextFrom(idx + 1);
      assert.ok(expected);
    }
  }

  for (const p of P) {
    const h = hand.ps[p.pid];
    assert.equal(h.committed, p.committed, `committed of ${p.pid}`);
    assert.equal(h.folded, p.folded, `folded of ${p.pid}`);
    assert.equal(h.allIn, p.allIn, `allIn of ${p.pid}`);
  }
  assert.equal(hand.lastAggressor, lastAggressor, 'last aggressor');
  assert.deepEqual(hand.board.slice(0, boardLen), dealt, 'board = the streets dealt during the betting');

  // After the betting: reveals, the runout, and the payouts.
  const L = live().map((p) => p.pid);
  const shows = [];
  let runs = 1;
  if (ended === 'fold') {
    const e = next('the win');
    assert.equal(e.pid, L[0]);
    assert.equal(e.text, 'wins');
    assert.equal(e.amount, P.reduce((a, q) => a + q.committed, 0));
    return { ended, L, shows, runs, paid: { [L[0]]: e.amount }, boardLen, rest: log.slice(i), oofCloses };
  }
  if (ended === 'runout') {
    for (const pid of L) {
      const e = next('an all-in reveal');
      assert.equal(e.pid, pid, 'all-in: every live hand is turned up, in order');
      assert.equal(e.text, 'shows');
      assert.deepEqual(e.cards, hand.ps[pid].hole);
      shows.push(pid);
    }
    if (log[i] && log[i].pid === null && /^Running it/.test(log[i].text)) {
      const t = next('vote').text;
      runs = t === 'Running it once' ? 1 : t === 'Running it twice' ? 2 : Number(/^Running it (\d) times$/.exec(t)[1]);
    }
    assert.equal(hand.runs, runs, 'runs');
    assert.equal(hand.runBoards.length, runs);
    for (let r = 0; r < runs; r++) {
      let len = boardLen;
      while (len < 5) {
        const e = next('a runout street');
        assert.equal(e.pid, null);
        assert.equal(e.text, (runs > 1 ? `Run ${r + 1} · ` : '') + streetLabel(len));
        assert.equal(e.run, r);
        const k = len === 0 ? 3 : 1;
        assert.deepEqual(e.cards, hand.runBoards[r].slice(len, len + k));
        len += k;
      }
      assert.deepEqual(hand.runBoards[r].slice(0, boardLen), dealt, 'each run starts from the shared board');
    }
  } else {
    while (log[i] && log[i].text === 'shows' && log[i].pid) {
      const e = next('a reveal');
      assert.deepEqual(e.cards, hand.ps[e.pid].hole, 'a showdown reveal shows the whole hand');
      shows.push(e.pid);
    }
  }
  const paid = {};
  while (log[i] && log[i].pid && (log[i].text === 'gets back an uncalled bet' || log[i].text === 'wins the side pot' || /^wins( run \d)? with /.test(log[i].text))) {
    const e = next('a payout');
    paid[e.pid] = (paid[e.pid] || 0) + e.amount;
  }
  return { ended, L, shows, runs, paid, boardLen, rest: log.slice(i), oofCloses };
}

// ─── state helpers ───────────────────────────────────────────────────────────

const CARD_RE = /^[2-9TJQKA][shdc]$/;

function chipsInPlay(state) {
  let chips = 0;
  for (const p of Object.values(state.players)) chips += p.stack + p.pendingChips;
  const h = state.hand;
  if (h && h.phase !== 'complete') for (const pid of h.order) chips += h.ps[pid].committed;
  return chips;
}

function ledgerChips(state) {
  let t = 0;
  for (const e of state.ledger) t += e.type === 'cashout' ? -e.amount : e.amount;
  return t;
}

/** Every community card in the order it was dealt (run 0, then the other runs past the shared board). */
function dealSeq(h) {
  if (!h.runBoards.length) return h.board.slice();
  const out = h.runBoards[0].slice();
  for (let r = 1; r < h.runBoards.length; r++) out.push(...h.runBoards[r].slice(h.board.length));
  return out;
}

/**
 * Walk `obj` collecting every string leaf that looks like a card (with its path) and failing on any
 * secret: a `tokenHash` / `deck` key or a token-hash value.
 */
function cardLeaves(obj, path, out) {
  if (typeof obj === 'string') {
    if (obj.length === 2) {
      if (CARD_RE.test(obj)) out.push([obj, path]);
    } else if (obj.startsWith('tokenhash')) assert.fail(`token hash leaked at ${path}`);
  } else if (Array.isArray(obj)) {
    for (let k = 0; k < obj.length; k++) cardLeaves(obj[k], path + '[' + k + ']', out);
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      if (k === 'tokenHash' || k === 'deck') assert.fail(`secret key "${k}" leaked at ${path}`);
      cardLeaves(obj[k], path + '.' + k, out);
    }
  }
  return out;
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// ─── the fuzzer ──────────────────────────────────────────────────────────────

class Fuzzer {
  constructor(seed, handsWanted, stats) {
    this.seed = seed;
    this.R = mulberry32(seed);
    this.ctx = { now: T0 + (seed % 100000) * 7919, rng: mulberry32(seed ^ 0x9e3779b9) };
    this.handsWanted = handsWanted;
    this.stats = stats;
    this.track = null; // bookkeeping for the current hand
    this.prev = null; // facts about the state after the previous step
    this.lastLabel = '';
    this.stepNo = 0;
    this.idle = 0;
    this.handsDone = 0;
  }

  int(n) {
    return Math.floor(this.R() * n);
  }
  pick(arr) {
    return arr[this.int(arr.length)];
  }
  chance(p) {
    return this.R() < p;
  }

  get state() {
    return this.st;
  }
  pids() {
    return Object.keys(this.st.players);
  }
  seated() {
    return Object.values(this.st.players).filter((p) => p.seat != null);
  }
  unseated() {
    return Object.values(this.st.players).filter((p) => p.seat == null);
  }

  buyAmount(s = this.st.settings) {
    const r = this.R();
    let a;
    if (r < 0.3) a = 1 + this.int(Math.max(1, s.bb * 3));
    else if (r < 0.65) a = s.bb * (3 + this.int(40));
    else a = s.minBuyIn + this.int(s.maxBuyIn - s.minBuyIn + 1);
    return Math.min(s.maxBuyIn, Math.max(s.minBuyIn, a));
  }

  // ── setup ──
  setup() {
    const sb = this.pick([1, 1, 1, 2, 5, 10]);
    const seats = 2 + this.int(8);
    const settings = {
      variant: this.chance(0.5) ? 'NLH' : 'PLO',
      sb,
      bb: sb * this.pick([1, 2, 2, 2, 3]),
      seats,
      minBuyIn: this.pick([1, 1, 1, 10]),
      maxBuyIn: this.pick([60, 200, 1000, 5000]),
      approveBuyIns: this.chance(0.5),
      maxRuns: 1 + this.int(3),
      revealRunout: this.pick(['anyone', 'winner', 'host', 'off']),
      showdownLosers: this.pick(['choose', 'show']),
      actionTime: 10 + this.int(111),
      nextHandDelay: 3 + this.int(28),
      autoAwayTimeouts: this.int(4),
    };
    this.st = E.createRoom(
      { code: 'FZZ-0001', name: 'Fuzz night', hostName: 'H0', hostId: 'p0', hostTokenHash: 'tokenhash-p0', settings },
      this.ctx,
    );
    this.nextPid = 1;
    const joiners = 1 + this.int(Math.min(seats, 9) - 1) + this.int(3);
    for (let k = 0; k < joiners; k++) this.join();
    this.observe('setup');
    const sitters = this.pids().slice(0, 2 + this.int(Math.max(1, Math.min(seats, this.pids().length) - 1)));
    for (const pid of sitters) {
      const free = [];
      for (let s = 0; s < this.st.settings.seats; s++) if (!E.seatReservedBy(this.st, s) && !Object.values(this.st.players).some((p) => p.seat === s)) free.push(s);
      if (!free.length) break;
      this.run(pid, { type: 'sit', seat: this.pick(free), amount: this.buyAmount() }, 'ok');
    }
    this.approveAll();
  }

  /** A fixed table instead of a random one: p0 (host) .. p(n-1) at seats 0.. with the given stacks. */
  table(settings, stacks) {
    this.st = E.createRoom(
      {
        code: 'FZZ-0002',
        name: 'Scripted',
        hostName: 'H0',
        hostId: 'p0',
        hostTokenHash: 'tokenhash-p0',
        settings: { approveBuyIns: false, minBuyIn: 1, maxBuyIn: 100000, maxRuns: 1, seats: 9, ...settings },
      },
      this.ctx,
    );
    this.nextPid = 1;
    for (let i = 1; i < stacks.length; i++) this.join();
    this.observe('setup');
    stacks.forEach((amount, i) => this.run('p' + i, { type: 'sit', seat: i, amount }, 'ok'));
    return this;
  }

  /** Jump to the pending deadline and process it. */
  fire() {
    assert.notEqual(this.st.deadline, null, 'a deadline is pending');
    this.ctx.now = Math.max(this.ctx.now, this.st.deadline);
    this.lastLabel = 'fire';
    assert.ok(E.tick(this.st, this.ctx));
    this.observe('tick');
    return this.st.hand;
  }

  join() {
    const id = 'p' + this.nextPid++;
    E.addPlayer(this.st, { id, name: 'P' + id.slice(1), tokenHash: 'tokenhash-' + id }, this.ctx);
  }

  approveAll() {
    for (const r of this.st.requests.slice()) this.run(this.st.hostId, { type: 'approve', id: r.id }, 'any');
  }

  // ── one apply with the error-path contract ──
  run(pid, action, expect = 'any') {
    this.lastLabel = `${pid} ${JSON.stringify(action)}`;
    // Process due deadlines first so that a rejected action can be compared byte-for-byte.
    if (E.tick(this.st, this.ctx)) this.observe('tick before ' + action.type);
    const before = JSON.stringify(this.st);
    try {
      E.apply(this.st, pid, action, this.ctx);
    } catch (err) {
      if (!(err instanceof E.EngineError)) throw err;
      assert.equal(JSON.stringify(this.st), before, `rejected ${action.type} (${err.message}) changed the state`);
      assert.ok(['bad_request', 'forbidden', 'not_your_turn', 'conflict', 'not_found'].includes(err.code), 'error code');
      assert.ok(typeof err.message === 'string' && err.message.length > 0);
      if (expect === 'ok') assert.fail(`legal ${action.type} was rejected: ${err.message}`);
      this.stats.rejected++;
      return false;
    }
    if (expect === 'err') assert.fail(`illegal action was accepted: ${this.lastLabel}`);
    this.stats.actions++;
    this.observe(action.type);
    return true;
  }

  // ── step kinds ──
  step() {
    this.stepNo++;
    const st = this.st;
    const hand = st.hand;
    const r = this.R();
    if (r < 0.05) return this.illegalStep();
    if (hand && hand.phase === 'betting' && r < 0.68) return this.legalActStep();
    if (hand && hand.phase === 'ritVote' && r < 0.6) return this.voteStep();
    if (hand && hand.phase === 'betting' && r < 0.72) return this.leaveMidHandStep();
    if (r < 0.82) return this.timeStep();
    return this.miscStep();
  }

  legalActStep() {
    const st = this.st;
    const hand = st.hand;
    const pid = hand.toAct;
    const v = viewFor(st, pid, 1, this.ctx.now);
    const L = v.hand.legal;
    assert.ok(L, 'the player to act gets legal moves in their view');
    this.checkLegal(pid, L);
    const raises = hand.log.filter((e) => e.text === 'raises to' || e.text === 'bets' || e.text === 'all-in').length;
    const pRaise = !L.raise ? 0 : raises > 8 ? 0.05 : L.minTo === L.maxTo ? 0.45 : 0.32;
    const x = this.R();
    let action;
    if (x < (L.check ? 0.04 : 0.22)) action = { type: 'act', move: 'fold' };
    else if (x < 1 - pRaise) action = { type: 'act', move: L.check ? (this.chance(0.08) ? 'call' : 'check') : 'call' };
    else {
      const half = Math.floor((L.minTo + L.potTo) / 2);
      const choices = [L.minTo, L.maxTo, L.potTo, half, L.minTo + this.int(L.maxTo - L.minTo + 1)];
      let to = Math.min(L.maxTo, Math.max(L.minTo, this.pick(choices)));
      action = { type: 'act', move: 'raise', to: this.chance(0.1) ? String(to) : to };
    }
    this.run(pid, action, 'ok');
  }

  /** Someone who is still in the hand leaves (or is removed) out of turn — often the biggest bettor. */
  leaveMidHandStep() {
    const hand = this.st.hand;
    const cands = hand.order.filter((pid) => pid !== hand.toAct && !hand.ps[pid].folded);
    if (!cands.length) return;
    const top = cands.slice().sort((a, b) => hand.ps[b].committed - hand.ps[a].committed)[0];
    const pid = this.chance(0.5) ? top : this.pick(cands);
    if (this.chance(0.6)) this.run(pid, { type: 'leave' }, 'ok');
    else this.run(this.st.hostId, { type: 'remove', pid }, 'ok');
  }

  voteStep() {
    const hand = this.st.hand;
    const voters = hand.ritVoters;
    const pid = this.pick(voters);
    const max = hand.ritMaxRuns || this.st.settings.maxRuns;
    // Each hand has a favourite outcome most voters go along with, so unanimous 2× / 3× runs are common.
    const t = this.track;
    if (t.voteTarget == null) t.voteTarget = 1 + this.int(max);
    const runs = this.chance(0.85) ? Math.min(max, t.voteTarget) : 1 + this.int(max);
    this.run(pid, { type: 'vote', runs }, 'ok');
  }

  timeStep() {
    const st = this.st;
    const d = st.deadline;
    const x = this.R();
    if (d != null && x < 0.78) this.ctx.now = Math.max(this.ctx.now, d + this.int(900));
    else if (x < 0.97) this.ctx.now += 1 + this.int(4000);
    else {
      this.ctx.now += 60_000 * (1 + this.int(30)); // someone comes back to a room nobody was watching
      this.stats.bigJumps++;
    }
    const y = this.R();
    if (y < 0.6) {
      const due = st.deadline != null && st.deadline <= this.ctx.now;
      this.lastLabel = 'tick()';
      const changed = E.tick(st, this.ctx);
      assert.equal(changed, due, 'tick() reports a change exactly when a deadline was due');
      if (changed) this.observe('tick');
      else this.observe('tick (no-op)');
    } else {
      this.run(y < 0.8 ? null : this.pick(this.pids()), { type: 'tick' }, 'ok');
    }
  }

  miscStep() {
    const st = this.st;
    const host = st.hostId;
    const hand = st.hand;
    const all = this.pids();
    const seated = this.seated();
    const unseated = this.unseated();
    const anyP = () => this.pick(all);
    const seatedP = () => (seated.length ? this.pick(seated).id : anyP());
    const options = [
      [3, () => this.run(anyP(), { type: 'chat', text: this.pick(['nice hand', 'gg', 'ship it', 'lol', 'one more']) }, 'ok')],
      [1.5, () => this.run(seatedP(), { type: 'away', on: true })],
      [1, () => this.run(seatedP(), { type: 'away', on: true, afterHand: true })],
      [4, () => {
        const away = seated.filter((p) => p.away);
        this.run(away.length ? this.pick(away).id : seatedP(), { type: 'away', on: false, waitForBB: this.chance(0.3) });
      }],
      [0.8, () => this.run(seatedP(), { type: 'leave' })],
      [1, () => this.run(seatedP(), { type: 'leave', afterHand: true })],
      [0.8, () => this.run(seatedP(), { type: 'cancelLeave' })],
      [3, () => {
        const p = unseated.length ? this.pick(unseated) : null;
        if (!p) return this.run(anyP(), { type: 'sit', seat: this.int(st.settings.seats), amount: this.buyAmount() });
        const seat = this.chance(0.2) ? null : this.int(st.settings.seats);
        this.run(p.id, { type: 'sit', seat, amount: this.buyAmount() });
      }],
      [3, () => {
        const busted = seated.filter((p) => p.stack + p.pendingChips === 0);
        const p = busted.length && this.chance(0.7) ? this.pick(busted) : seated.length ? this.pick(seated) : null;
        if (!p) return;
        const have = p.stack + p.pendingChips;
        const amount = have === 0 ? this.buyAmount() : 1 + this.int(Math.max(1, st.settings.maxBuyIn - have));
        this.run(p.id, { type: 'buyin', amount });
      }],
      [0.6, () => {
        const r = st.requests.length ? this.pick(st.requests) : null;
        if (r) this.run(r.pid, { type: 'cancelRequest', id: r.id }, 'ok');
      }],
      [4, () => {
        const r = st.requests.length ? this.pick(st.requests) : null;
        if (r) this.run(host, { type: 'approve', id: r.id, ...(this.chance(0.2) ? { amount: 1 + this.int(300) } : {}) });
      }],
      [0.6, () => {
        const r = st.requests.length ? this.pick(st.requests) : null;
        if (r) this.run(host, { type: 'deny', id: r.id }, 'ok');
      }],
      [1.5, () => {
        const mode = this.pick(['add', 'remove', 'set']);
        const amount = mode === 'set' ? this.int(300) : 1 + this.int(200);
        const target = seated.length ? this.pick(seated).id : anyP();
        this.run(host, {
          type: 'adjust',
          pid: target,
          mode,
          amount,
          reason: this.pick(['', 'cash rebuy', 'miscount fix', 'bounty']),
          countAsBuyIn: this.chance(0.5),
        });
      }],
      [1, () => this.run(host, { type: 'setAway', pid: seatedP(), on: this.chance(0.6) })],
      [0.35, () => this.run(host, { type: 'remove', pid: seatedP() })],
      [1, () => this.run(host, { type: 'settings', patch: this.randomPatch() })],
      [0.6, () => this.run(host, { type: 'pause', on: true }, 'ok')],
      [2, () => this.run(host, { type: 'pause', on: false }, 'ok')],
      [hand && hand.phase === 'complete' ? 6 : 0.3, () => {
        const pid = hand ? this.pick(hand.order) : anyP();
        const n = hand && hand.ps[pid] ? hand.ps[pid].hole.length : 2;
        const cards = [...new Set([this.int(n), this.int(n)])];
        this.run(pid, { type: 'show', cards });
      }],
      [hand && hand.phase === 'complete' ? 4 : 0.3, () => this.run(this.chance(0.4) ? host : anyP(), { type: 'revealRunout' })],
      [0.4, () => {
        const s = summarize(st).settlement;
        if (s.length) this.run(host, { type: 'markPaid', key: this.pick(s).key, paid: this.chance(0.8) }, 'ok');
      }],
      [0.12, () => this.run(host, { type: 'transferHost', pid: this.pick(all.filter((p) => p !== host)) || host })],
      [0.25, () => {
        if (all.length < 30) {
          this.join();
          this.observe('join');
        }
      }],
      [0.6, () => {
        // a random 'act' by a random dealt-in player (usually out of turn → rejected, state untouched)
        if (!hand) return;
        this.run(this.pick(hand.order), { type: 'act', move: this.pick(['fold', 'check', 'call', 'raise']), to: this.int(500) });
      }],
    ];
    let total = 0;
    for (const [w] of options) total += w;
    let x = this.R() * total;
    for (const [w, fn] of options) {
      if ((x -= w) <= 0) return fn();
    }
    return options[0][1]();
  }

  randomPatch() {
    const p = {};
    if (this.chance(0.3)) p.variant = this.pick(['NLH', 'PLO']);
    if (this.chance(0.25)) {
      const sb = this.pick([1, 1, 2, 5]);
      p.sb = sb;
      p.bb = sb * this.pick([1, 2, 2, 3]);
    }
    if (this.chance(0.3)) p.maxRuns = 1 + this.int(3);
    if (this.chance(0.2)) p.revealRunout = this.pick(['anyone', 'winner', 'host', 'off']);
    if (this.chance(0.2)) p.showdownLosers = this.pick(['choose', 'show']);
    if (this.chance(0.2)) p.actionTime = 10 + this.int(111);
    if (this.chance(0.2)) p.nextHandDelay = 3 + this.int(28);
    if (this.chance(0.2)) p.autoAwayTimeouts = this.int(4);
    if (this.chance(0.2)) p.approveBuyIns = this.chance(0.5);
    if (this.chance(0.15)) p.seats = 2 + this.int(8);
    if (this.chance(0.1)) {
      p.minBuyIn = this.pick([1, 1, 10, 50]);
      p.maxBuyIn = this.pick([100, 500, 2000]);
    }
    return p;
  }

  /** Moves that are certainly illegal: they must throw EngineError and change nothing. */
  illegalStep() {
    const st = this.st;
    const hand = st.hand;
    const host = st.hostId;
    const nonHost = this.pids().find((p) => p !== host);
    const cands = [];
    cands.push(() => this.run(this.pick(this.pids()), { type: 'nope' }, 'err'));
    cands.push(() => this.run('ghost', { type: 'chat', text: 'hi' }, 'err'));
    cands.push(() => this.run(this.pick(this.pids()), { type: 'chat', text: '   ' }, 'err'));
    if (nonHost) {
      cands.push(() => this.run(nonHost, { type: this.pick(['approve', 'deny', 'adjust', 'setAway', 'remove', 'settings', 'pause', 'markPaid', 'endGame', 'transferHost']), id: 1, pid: host, on: true, patch: {}, key: 'x', mode: 'add', amount: 5 }, 'err'));
    }
    cands.push(() => this.run(host, { type: 'settings', patch: { sb: 5, bb: 2 } }, 'err'));
    cands.push(() => this.run(host, { type: 'settings', patch: { variant: 'STUD' } }, 'err'));
    cands.push(() => this.run(host, { type: 'cancelRequest', id: 987654 }, 'err'));
    cands.push(() => this.run(host, { type: 'approve', id: 987654 }, 'err'));
    const seated = this.seated();
    if (seated.length) {
      const p = this.pick(seated);
      cands.push(() => this.run(p.id, { type: 'sit', seat: 0, amount: st.settings.minBuyIn }, 'err'));
      cands.push(() => this.run(host, { type: 'adjust', pid: p.id, mode: 'add', amount: -5 }, 'err'));
      cands.push(() => this.run(host, { type: 'adjust', pid: p.id, mode: 'double', amount: 5 }, 'err'));
      if (!st.requests.some((r) => r.pid === p.id)) {
        cands.push(() => this.run(p.id, { type: 'buyin', amount: st.settings.maxBuyIn + 1 }, 'err'));
        cands.push(() => this.run(p.id, { type: 'buyin', amount: 0 }, 'err'));
      }
    }
    const un = this.unseated();
    if (un.length) {
      const p = this.pick(un);
      cands.push(() => this.run(p.id, { type: 'leave' }, 'err'));
      cands.push(() => this.run(p.id, { type: 'away', on: true }, 'err'));
      cands.push(() => this.run(host, { type: 'adjust', pid: p.id, mode: 'add', amount: 5 }, 'err'));
      if (!st.requests.some((r) => r.pid === p.id)) {
        cands.push(() => this.run(p.id, { type: 'sit', seat: null, amount: st.settings.maxBuyIn + 1 }, 'err'));
        cands.push(() => this.run(p.id, { type: 'sit', seat: st.settings.seats, amount: st.settings.minBuyIn }, 'err'));
      }
    }
    if (!hand || hand.phase !== 'ritVote') cands.push(() => this.run(this.pick(this.pids()), { type: 'vote', runs: 1 }, 'err'));
    if (!hand || hand.phase !== 'complete') {
      const pid = hand ? this.pick(hand.order) : this.pick(this.pids());
      cands.push(() => this.run(pid, { type: 'show', cards: [0] }, 'err'));
      cands.push(() => this.run(pid, { type: 'revealRunout' }, 'err'));
    }
    if (!hand || hand.phase !== 'betting') cands.push(() => this.run(this.pick(this.pids()), { type: 'act', move: 'check' }, 'err'));
    if (hand && hand.phase === 'ritVote') {
      const max = hand.ritMaxRuns || st.settings.maxRuns;
      cands.push(() => this.run(this.pick(hand.ritVoters), { type: 'vote', runs: this.pick([0, max + 1, 'x', 1.5]) }, 'err'));
      const non = this.pids().filter((p) => !hand.ritVoters.includes(p));
      if (non.length) cands.push(() => this.run(this.pick(non), { type: 'vote', runs: 1 }, 'err'));
    }
    if (hand && hand.phase === 'complete') {
      const pid = this.pick(hand.order);
      cands.push(() => this.run(pid, { type: 'show', cards: [hand.ps[pid].hole.length] }, 'err'));
      cands.push(() => this.run(pid, { type: 'show', cards: [] }, 'err'));
    }
    if (hand && hand.phase === 'betting') {
      const pid = hand.toAct;
      const L = E.legalActions(st, pid);
      const others = hand.order.filter((q) => q !== pid);
      cands.push(() => this.run(this.pick(others), { type: 'act', move: this.pick(['fold', 'check', 'call']) }, 'err'));
      cands.push(() => this.run(pid, { type: 'act', move: 'muck' }, 'err'));
      if (!L.check) cands.push(() => this.run(pid, { type: 'act', move: 'check' }, 'err'));
      if (L.raise) {
        cands.push(() => this.run(pid, { type: 'act', move: 'raise', to: L.maxTo + 1 + this.int(5) }, 'err'));
        cands.push(() => this.run(pid, { type: 'act', move: 'raise', to: this.pick(['abc', L.minTo + 0.5, null, -1]) }, 'err'));
        if (L.minTo > hand.currentBet + 1 || L.minTo === L.maxTo) {
          cands.push(() => this.run(pid, { type: 'act', move: 'raise', to: L.minTo === L.maxTo ? L.minTo - 1 : L.minTo - 1 - this.int(L.minTo - hand.currentBet - 1) }, 'err'));
        }
      } else {
        cands.push(() => this.run(pid, { type: 'act', move: 'raise', to: hand.currentBet + hand.minRaise }, 'err'));
      }
    }
    this.stats.illegal++;
    return this.pick(cands)();
  }

  /** Nothing happening for a while: bring people back, rebuy the busted, seat spectators. */
  heal() {
    const st = this.st;
    const host = st.hostId;
    this.run(host, { type: 'pause', on: false }, 'ok');
    for (const p of this.seated()) if (p.away) this.run(p.id, { type: 'away', on: false }, 'ok');
    for (const p of this.seated()) {
      if (p.stack + p.pendingChips === 0 && !st.requests.some((r) => r.pid === p.id)) this.run(p.id, { type: 'buyin', amount: this.buyAmount() }, 'ok');
    }
    for (const p of this.unseated()) {
      if (this.seated().length >= 3) break;
      if (st.requests.some((r) => r.pid === p.id)) continue;
      this.run(p.id, { type: 'sit', seat: null, amount: this.buyAmount() });
    }
    if (this.seated().length + st.requests.filter((r) => r.kind === 'sit').length < 2 && this.pids().length < 30) {
      this.join();
      this.observe('join');
    }
    this.approveAll();
  }

  /** Leave the hand alone: only deadlines fire. It must finish within a bounded number of jumps. */
  drain() {
    const no = this.st.hand && this.st.hand.no;
    if (!no) return;
    for (let k = 0; k < MAX_DRAIN_JUMPS; k++) {
      if (!this.st.hand || this.st.hand.no !== no || this.st.hand.phase === 'complete') return;
      this.ctx.now = this.st.deadline + 1;
      this.lastLabel = 'drain tick';
      assert.ok(E.tick(this.st, this.ctx));
      this.observe('tick');
    }
    assert.fail(`hand ${no} did not finish within ${MAX_DRAIN_JUMPS} unattended deadlines`);
  }

  // ── the per-step oracle ──
  observe(kind) {
    const st = this.st;
    const now = this.ctx.now;
    const prev = this.prev;
    this.checkState();
    this.checkLedger();
    this.checkViews();

    const h = st.hand;
    // hand bookkeeping
    if (this.track && (!h || h.no !== this.track.no)) {
      // the tracked hand is over
      if (!this.track.verified) this.stats.unverified++;
      const lh = st.lastHand;
      if (lh && lh.no === this.track.no) this.checkArchive(lh, this.track);
      this.track = null;
    }
    if (h && !this.track) {
      this.track = { no: h.no, steps: 0, verified: false, hole: {}, shown: {}, startedOnTick: kind.startsWith('tick') };
      this.onNewHand(h, prev, kind);
      this.stats.hands++;
      this.handsDone++;
    }
    if (h) {
      const t = this.track;
      t.steps++;
      assert.ok(t.steps < MAX_STEPS_PER_HAND, `hand ${h.no} is still running after ${t.steps} steps`);
      // community cards come off the front of the deck, in order, no burns
      if (prev && prev.handNo === h.no) {
        const seq = dealSeq(h);
        assert.deepEqual(seq.slice(0, prev.seq.length), prev.seq, 'dealt cards never change');
        const fresh = seq.slice(prev.seq.length);
        assert.deepEqual(fresh, prev.deck.slice(0, fresh.length), 'new board cards come off the top of the deck');
        assert.deepEqual(h.deck, prev.deck.slice(fresh.length), 'the deck only shrinks from the front');
        if (h.runout && !prev.runout) this.checkRunoutReveal(h, prev);
        if (kind.startsWith('tick')) this.checkTimeouts(h, prev);
      }
      for (const pid of h.order) if (h.ps[pid].raiseLocked) this.stats.raiseLocks++;
      for (const pid of h.order) {
        t.hole[pid] = h.ps[pid].hole;
        t.shown[pid] = h.ps[pid].shown.slice();
      }
      if (h.phase === 'complete' && !t.verified) {
        // next-hand timer: nextHandDelay (+1.5 s per extra run) after the hand completed
        const delay = (s) => s.nextHandDelay * 1000 + 1500 * (h.runs - 1);
        assert.ok(
          st.deadline === h.completedAt + delay(st.settings) || (prev && st.deadline === h.completedAt + delay(prev.settings)),
          `next-hand timer ${st.deadline - h.completedAt} ms after the hand`,
        );
        this.verifyComplete(h, prev);
        t.verified = true;
        this.stats.verified++;
      }
    }
    this.prev = {
      handNo: h ? h.no : null,
      phase: h ? h.phase : null,
      seq: h ? dealSeq(h) : [],
      deck: h ? h.deck.slice() : [],
      runout: h ? h.runout : null,
      button: st.button,
      waiters: new Set(Object.values(st.players).filter((p) => p.waitForBB).map((p) => p.id)),
      settings: st.settings,
      hostId: st.hostId,
      logLen: h ? h.log.length : 0,
      timeouts: Object.fromEntries(Object.values(st.players).map((p) => [p.id, p.timeouts])),
      now,
    };
  }

  onNewHand(h, prev, kind) {
    const st = this.st;
    assert.equal(h.variant, h.ps[h.order[0]].hole.length === 4 ? 'PLO' : 'NLH');
    for (const pid of h.order) assert.equal(h.ps[pid].hole.length, h.variant === 'PLO' ? 4 : 2);
    assert.ok(h.order.length >= 2 && h.order.length <= 9);
    if (!kind.startsWith('tick') || !prev || prev.handNo != null) return;
    // Dealt on a pure clock step: the line-up must follow §6.1 exactly.
    for (const p of Object.values(st.players)) {
      if (h.ps[p.id]) {
        assert.equal(h.ps[p.id].seat, p.seat, 'dealt at their seat');
        continue;
      }
      const eligible = p.seat != null && p.stack > 0 && !p.away && !p.leaveAfterHand && !p.waitForBB;
      assert.ok(!eligible, `${p.id} (seat ${p.seat}) was eligible but not dealt into hand ${h.no}`);
    }
    const regular = h.order.filter((pid) => !prev.waiters.has(pid));
    const waiters = h.order.filter((pid) => prev.waiters.has(pid));
    if (regular.length >= 2) {
      const rs = regular.map((pid) => h.ps[pid].seat).sort((a, b) => a - b);
      const expectBtn = prev.button == null ? rs[0] : rs.find((s) => s > prev.button) ?? rs[0];
      assert.equal(h.button, expectBtn, 'the button moves to the next eligible seat');
      assert.ok(waiters.length <= 1, 'at most one waiting player comes in, as the big blind');
      for (const w of waiters) assert.equal(h.ps[w].seat, h.bbSeat, 'a player waiting for the big blind is dealt in only as the big blind');
    }
  }

  /** Timeouts on a clock step: counted, and auto-away kicks in at the threshold (§6.4). */
  checkTimeouts(h, prev) {
    const st = this.st;
    const fresh = h.log.slice(prev.logLen);
    const count = {};
    for (const e of fresh) if (e.pid && / \(timed out\)$/.test(e.text)) count[e.pid] = (count[e.pid] || 0) + 1;
    for (const [pid, k] of Object.entries(count)) {
      const p = st.players[pid];
      assert.equal(p.timeouts, prev.timeouts[pid] + k, `timeouts of ${pid} counted`);
      const limit = st.settings.autoAwayTimeouts;
      if (limit > 0 && p.timeouts >= limit) assert.ok(p.away, `${pid} goes away after ${p.timeouts} timeouts`);
      this.stats.timeouts += k;
    }
    // the action timer runs actionTime seconds from when the turn started
    if (h.phase === 'betting') assert.ok(st.deadline <= this.ctx.now + 120_000);
  }

  checkRunoutReveal(h, prev) {
    const st = this.st;
    assert.equal(h.phase, 'complete');
    assert.equal(h.results.endedBy, 'fold');
    assert.ok(h.board.length < 5);
    assert.deepEqual(h.runout.cards, h.deck.slice(0, 5 - h.board.length), 'the runout is exactly the next cards of the deck');
    const ok = (s, host) =>
      s.revealRunout === 'anyone' ||
      (s.revealRunout === 'host' && h.runout.by === host) ||
      (s.revealRunout === 'winner' && h.results.winners.includes(h.runout.by));
    assert.ok(ok(st.settings, st.hostId) || ok(prev.settings, prev.hostId), 'revealRunout permission');
    const e = h.log.find((x) => x.text === 'reveals the runout');
    assert.ok(e && e.pid === h.runout.by);
    this.stats.runoutReveals++;
  }

  // ── invariants on the raw state ──
  checkState() {
    const st = this.st;
    const now = this.ctx.now;
    assert.equal(chipsInPlay(st), ledgerChips(st), 'chip conservation (SPEC §6.3)');
    const seats = new Set();
    const reqPids = new Set();
    for (const p of Object.values(st.players)) {
      assert.ok(Number.isInteger(p.stack) && p.stack >= 0, `stack of ${p.id} = ${p.stack}`);
      assert.ok(Number.isInteger(p.pendingChips) && p.pendingChips >= 0, `pendingChips of ${p.id}`);
      assert.equal(!!p.away, p.awayBy != null, `away/awayBy agree for ${p.id}`);
      if (p.seat == null) {
        assert.equal(p.stack, 0, `unseated ${p.id} holds no chips`);
        assert.equal(p.pendingChips, 0);
        assert.ok(!p.away && !p.leaveAfterHand, `unseated ${p.id} is not away / leaving`);
      } else {
        assert.ok(Number.isInteger(p.seat) && p.seat >= 0 && p.seat < st.settings.seats, `seat ${p.seat} in range`);
        assert.ok(!seats.has(p.seat), 'one player per seat');
        seats.add(p.seat);
      }
      if (p.pendingChips) assert.ok(st.hand && st.hand.ps[p.id], 'pending chips only while dealt into a hand');
    }
    for (const r of st.requests) {
      const p = st.players[r.pid];
      assert.ok(p, 'request from a joined player');
      assert.ok(!reqPids.has(r.pid), 'one pending request per player');
      reqPids.add(r.pid);
      assert.equal(r.kind === 'sit', p.seat == null, `request kind ${r.kind} matches seat state of ${r.pid}`);
      assert.ok(Number.isInteger(r.amount) && r.amount >= 1);
    }
    if (st.deadline != null) assert.ok(st.deadline > now, `deadline ${st.deadline} is in the future (now ${now})`);
    assert.equal(st.deadline == null, st.deadlineKind == null, 'deadline and kind are set together');
    assert.ok(st.chat.length <= 60);

    const h = st.hand;
    if (!h) {
      assert.ok(!st.pauseAfterHand && !st.endAfterHand, 'no "after the hand" flags without a hand');
      const startable = E.canStartHand(st);
      if (startable) assert.equal(st.deadlineKind, 'nextHand', 'a startable table has the next-hand timer armed');
      else assert.equal(st.deadline, null, 'no timer when no hand can start');
      if (st.ended) {
        assert.ok(st.paused);
        assert.equal(this.seated().length, 0, 'an ended game has nobody seated');
        assert.equal(st.requests.length, 0);
      }
      return;
    }
    assert.ok(!st.ended, 'no hand in an ended game');
    // cards: all 52 accounted for, none twice
    const cards = [...h.order.flatMap((pid) => h.ps[pid].hole), ...h.deck, ...dealSeq(h)];
    assert.equal(new Set(cards).size, cards.length, 'no card appears twice');
    assert.equal(cards.length, 52, 'every card is accounted for');
    if (h.runBoards.length > 1) for (const b of h.runBoards) assert.deepEqual(b.slice(0, h.board.length), h.board);

    const live = h.order.filter((pid) => !h.ps[pid].folded);
    assert.ok(live.length >= 1);
    let maxBet = 0;
    for (const pid of h.order) {
      const x = h.ps[pid];
      assert.ok(Number.isInteger(x.bet) && x.bet >= 0, 'bet ≥ 0');
      assert.ok(Number.isInteger(x.committed) && x.committed >= x.bet, 'committed ≥ bet');
      assert.ok(!(x.folded && x.allIn), 'nobody is folded and all-in');
      maxBet = Math.max(maxBet, x.bet);
      const p = st.players[pid];
      if (p.seat === x.seat && !this.cashedOutThisHand(pid, h)) {
        const won = h.phase === 'complete' ? x.won : 0;
        assert.equal(p.stack, x.startStack - x.committed + won, `stack of ${pid} = start − committed (+ won)`);
        if (x.allIn) assert.equal(p.stack - won, 0, 'all-in means no chips behind');
      }
    }
    assert.ok(h.minRaise >= h.bb, 'minRaise ≥ bb');
    switch (h.phase) {
      case 'betting': {
        assert.equal(maxBet, h.currentBet, 'currentBet is the highest bet');
        assert.ok(live.length >= 2);
        const t = h.toAct && h.ps[h.toAct];
        assert.ok(t, 'someone is to act during the betting');
        assert.ok(!t.folded && !t.allIn, 'the player to act is live and not all-in');
        const p = st.players[h.toAct];
        assert.ok(p && p.seat != null && !p.away, 'the player to act is seated and not away (away players are auto-acted)');
        assert.ok(!t.acted || t.bet < h.currentBet, 'the player to act still has something to do');
        assert.equal(st.deadlineKind, 'action');
        const actors = live.filter((pid) => !h.ps[pid].allIn);
        assert.ok(actors.length >= 1);
        if (actors.length === 1) assert.ok(h.ps[actors[0]].bet < h.currentBet, 'a lone actor only acts facing a bet');
        assert.equal(h.street, { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' }[h.board.length]);
        assert.equal(h.runBoards.length, 0);
        // independent replay of the betting so far
        const ref = referee(h, true);
        assert.ok(ref.partial, 'the referee also thinks the betting is still open');
        assert.equal(h.toAct, ref.expected, 'the right player is to act');
        assert.equal(h.currentBet, ref.currentBet, 'current bet');
        assert.equal(h.minRaise, ref.minRaise, 'min raise');
        assert.equal(h.board.length, ref.boardLen);
        for (const q of ref.P) {
          const x = h.ps[q.pid];
          assert.equal(x.bet, q.bet, `bet of ${q.pid}`);
          assert.equal(x.committed, q.committed, `committed of ${q.pid}`);
          assert.equal(x.folded, q.folded);
          assert.equal(x.allIn, q.allIn);
        }
        const me = ref.P.find((q) => q.pid === h.toAct);
        const others = ref.P.some((q) => q !== me && !q.folded && !q.allIn);
        const mayRaise = others && !me.locked && me.bet + me.stack > ref.currentBet;
        assert.equal(E.legalActions(st, h.toAct).raise, mayRaise, 'raise permission (short all-in rule)');
        break;
      }
      case 'ritVote':
        assert.equal(h.toAct, null);
        assert.equal(st.deadlineKind, 'ritVote');
        assert.ok(sameSet(h.ritVoters, live), 'every live player votes');
        assert.ok(!h.ritVoters.every((v) => h.ritVotes[v] != null), 'a complete vote closes at once');
        for (const v of h.ritVoters) if (st.players[v].away) assert.ok(h.ritVotes[v] != null, 'away voters vote once automatically');
        for (const pid of live) assert.ok(h.ps[pid].shown.every(Boolean), 'all-in: live hands are face up');
        assert.ok(h.board.length < 5);
        this.checkEquity(h, live);
        break;
      case 'runout':
        assert.equal(h.toAct, null);
        assert.equal(st.deadlineKind, 'runout');
        assert.ok(h.runBoards.length === h.currentRun + 1 && h.currentRun < h.runs, 'runs dealt one after another');
        for (const pid of live) assert.ok(h.ps[pid].shown.every(Boolean), 'all-in: live hands are face up');
        this.checkEquity(h, live);
        break;
      case 'complete': {
        assert.equal(h.toAct, null);
        assert.equal(st.deadlineKind, 'nextHand');
        assert.ok(h.results);
        const awarded = Object.values(h.results.awards).reduce((a, b) => a + b, 0);
        assert.equal(awarded, E.potTotal(h), 'the whole pot is awarded');
        for (const pid of h.order) assert.equal(h.ps[pid].bet, 0);
        break;
      }
      default:
        assert.fail('unknown phase ' + h.phase);
    }
  }

  cashedOutThisHand(pid, h) {
    for (let k = this.st.ledger.length - 1; k >= 0; k--) {
      const e = this.st.ledger[k];
      if (e.t < h.startedAt) break;
      if (e.pid === pid && e.type === 'cashout') return true;
    }
    return false;
  }

  checkEquity(h, live) {
    assert.ok(h.equity, 'equity is computed during the vote / runout');
    const vals = live.map((pid) => h.equity.by[pid]);
    for (const v of vals) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100, `equity value ${v}`);
    const sum = vals.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) <= live.length, `equity sums to about 100 (got ${sum})`);
    // Exact cross-check when the board is complete or one card is to come (brute force over the stub).
    const run = h.equity.run;
    const board = h.phase === 'runout' ? h.runBoards[run] : h.board;
    assert.equal(run, h.phase === 'runout' ? h.currentRun : 0, 'equity is for the run being dealt');
    if (board.length < 4) return;
    const key = `${h.no}/${run}/${board.length}`;
    if (this.eqChecked === key) return;
    this.eqChecked = key;
    const used = new Set([...live.flatMap((pid) => h.ps[pid].hole), ...board]);
    if (h.phase === 'runout') h.runBoards.forEach((b, r) => r !== run && b.slice(h.board.length).forEach((c) => used.add(c)));
    // folded players' cards are unknown, so they stay in the stub
    const boards = board.length === 5 ? [board] : RANK.split('').flatMap((r) => 'shdc'.split('').map((x) => r + x)).filter((c) => !used.has(c)).map((c) => [...board, c]);
    const share = Object.fromEntries(live.map((pid) => [pid, 0]));
    for (const b of boards) {
      const sc = live.map((pid) => refScore(h.variant, h.ps[pid].hole, b));
      const best = Math.max(...sc);
      const ws = live.filter((_, k) => sc[k] === best);
      for (const w of ws) share[w] += 1 / ws.length;
    }
    for (const pid of live) {
      const exact = (100 * share[pid]) / boards.length;
      assert.ok(Math.abs(h.equity.by[pid] - exact) <= 1, `equity of ${pid}: ${h.equity.by[pid]} vs exact ${exact.toFixed(2)}`);
    }
    this.stats.equityExact++;
  }

  // ── the ledger ──
  checkLedger() {
    const st = this.st;
    const L = summarize(st);
    const T = L.totals;
    assert.equal(T.chipsOnTable, chipsInPlay(st), 'ledger chips on table = chips in play');
    assert.equal(T.diff, T.uncountedAdjust, 'the books balance up to uncounted adjustments');
    assert.equal(T.balanced, T.diff === 0);
    // Chips that players who already left put into the running hand are on the table but in nobody's row
    // until the pot is pushed.
    let orphan = 0;
    const h = st.hand;
    if (h && h.phase !== 'complete') {
      for (const pid of h.order) if (st.players[pid].seat !== h.ps[pid].seat) orphan += h.ps[pid].committed;
    }
    const sumNet = L.players.reduce((a, r) => a + r.net, 0);
    assert.equal(sumNet, T.diff - orphan, 'Σ net = diff (minus pot chips of players who left)');
    for (const r of L.players) assert.equal(r.net, r.cashOuts + r.stack - r.buyIns);
    // Recorded payments (ticked: paid, key from>to:amount#id) come first, then what is still owed
    // after them (key from>to:amount, paid only via a legacy tick).
    const paidOut = {};
    const received = {};
    const owed = {}; // outstanding only
    const owes = {};
    const recorded = L.settlement.filter((s) => /#\d+$/.test(s.key));
    assert.deepEqual(L.settlement.slice(0, recorded.length), recorded, 'recorded payments are listed first');
    assert.equal(recorded.length, (st.payments || []).length);
    for (const s of L.settlement) {
      assert.ok(Number.isInteger(s.amount) && s.amount > 0, 'settlement payments are positive');
      assert.notEqual(s.from, s.to);
      if (recorded.includes(s)) {
        assert.ok(s.key.startsWith(`${s.from}>${s.to}:${s.amount}#`));
        assert.equal(s.paid, true);
      } else {
        assert.equal(s.key, `${s.from}>${s.to}:${s.amount}`);
        assert.equal(s.paid, !!st.paid[s.key]);
        owes[s.from] = (owes[s.from] || 0) + s.amount;
        owed[s.to] = (owed[s.to] || 0) + s.amount;
      }
      paidOut[s.from] = (paidOut[s.from] || 0) + s.amount;
      received[s.to] = (received[s.to] || 0) + s.amount;
    }
    // what each player still owes / is owed once the recorded payments are counted
    const left = (r) => r.net + recorded.reduce((a, s) => a + (s.from === r.pid ? s.amount : 0) - (s.to === r.pid ? s.amount : 0), 0);
    const nonzero = L.players.filter((r) => left(r) !== 0);
    assert.ok(L.settlement.length - recorded.length <= Math.max(0, nonzero.length - 1), 'at most n − 1 outstanding payments');
    for (const r of L.players) {
      const x = left(r);
      if (x < 0) assert.ok((owes[r.pid] || 0) <= -x && !owed[r.pid]);
      if (x > 0) assert.ok((owed[r.pid] || 0) <= x && !owes[r.pid]);
      if (x === 0) assert.ok(!owes[r.pid] && !owed[r.pid]);
      if (T.balanced && !orphan) assert.equal((received[r.pid] || 0) - (paidOut[r.pid] || 0), r.net, `settle-up squares ${r.pid}`);
    }
    if (T.balanced) this.stats.balancedSettles++;
  }

  // ── views: nothing secret, legal moves sane ──
  checkViews() {
    const st = this.st;
    const now = this.ctx.now;
    const h = st.hand;
    const viewers = [null, ...Object.keys(st.players)];
    const runoutCards = new Set(h && h.runout ? h.runout.cards : []);
    const deckSecret = h ? h.deck.filter((c) => !runoutCards.has(c)) : [];
    let lhPublic = null;
    if (st.lastHand) {
      const lh = st.lastHand;
      lhPublic = new Set([...(lh.boards || []).flat(), ...(lh.runout ? lh.runout.cards : []), ...(lh.players || []).flatMap((p) => p.cards.filter(Boolean))]);
    }
    let first = true;
    for (const viewer of viewers) {
      const v = viewFor(st, viewer, 7, now);
      // The ledger and chat do not depend on the viewer (summarize(state) / state.chat): scan them once,
      // and only when they changed.
      const sig = `${st.ledger.length}/${st.chat.length && st.chat[st.chat.length - 1].id}/${Object.keys(st.paid).length}/${v.ledger.players.length}`;
      if (first && sig !== this.sharedSig) {
        this.sharedSig = sig;
        assert.equal(cardLeaves([v.ledger, v.chat], 'ledger', []).length, 0, 'no cards in ledger / chat');
      }
      first = false;
      assert.equal(v.serverNow, now);
      assert.equal(v.isHost, viewer === st.hostId);
      assert.equal(v.deadline, st.deadline);
      assert.equal(v.deadlineKind, st.deadlineKind);
      for (const r of v.requests) assert.ok(v.isHost || r.pid === viewer, 'others’ requests are host-only');
      assert.equal(v.seats.length, st.settings.seats);
      if (viewer == null) assert.equal(v.me, null);

      // hidden cards of the running hand
      const hidden = new Set(deckSecret);
      if (h) for (const pid of h.order) if (pid !== viewer) h.ps[pid].hole.forEach((c, i) => !h.ps[pid].shown[i] && hidden.add(c));
      const { lastHand, ledger, chat, ...rest } = v;
      for (const [c, path] of cardLeaves(rest, 'view', []))assert.ok(!hidden.has(c), `${viewer} can see hidden card ${c} at ${path}`);
      if (lastHand && viewer === null) {
        // lastHand is built from the archive alone (no viewer-specific cards): check it once
        for (const [c, path] of cardLeaves(lastHand, 'lastHand', [])) assert.ok(lhPublic.has(c), `unshown last-hand card ${c} at ${path}`);
      }

      if (!h) {
        assert.equal(v.hand, null);
        continue;
      }
      const vh = v.hand;
      assert.equal(vh.potTotal, E.potTotal(h));
      assert.equal(vh.players.length, h.order.length);
      for (const vp of vh.players) {
        const x = h.ps[vp.pid];
        assert.deepEqual(vp.cards, x.hole.map((c, i) => (vp.pid === viewer || x.shown[i] ? c : null)));
        if (vp.handName != null) assert.ok(vp.cards.every(Boolean), 'hand names only for fully visible hands');
      }
      if (viewer && v.me) {
        assert.deepEqual(v.me.hole, h.ps[viewer] ? h.ps[viewer].hole : null);
      }
      const L = vh.legal;
      if (h.phase === 'betting' && viewer === h.toAct) {
        assert.ok(L, 'legal moves for the player to act');
        this.checkLegal(viewer, L);
      } else {
        assert.equal(L, null, 'legal moves only for the player to act');
      }
      assert.equal(vh.canShow, E.canShow(st, viewer));
    }
  }

  /** The legal-move object, recomputed independently from the spec (§6.2). */
  checkLegal(pid, L) {
    const st = this.st;
    const h = st.hand;
    const x = h.ps[pid];
    const stack = st.players[pid].stack;
    const toCall = h.currentBet - x.bet;
    assert.equal(L.fold, true);
    assert.equal(L.check, toCall === 0);
    assert.equal(L.call, Math.min(Math.max(0, toCall), stack));
    const allInTo = x.bet + stack;
    const others = h.order.some((q) => q !== pid && !h.ps[q].folded && !h.ps[q].allIn);
    assert.equal(L.raise, others && !x.raiseLocked && allInTo > h.currentBet, 'raise allowed');
    if (!L.raise) return;
    assert.ok(L.minTo <= L.maxTo, `minTo ${L.minTo} ≤ maxTo ${L.maxTo}`);
    assert.ok(L.minTo > h.currentBet && L.maxTo <= allInTo);
    assert.ok(L.potTo >= L.minTo && L.potTo <= L.maxTo);
    const fullMin = h.currentBet + h.minRaise;
    if (allInTo < fullMin) {
      assert.equal(L.minTo, allInTo);
      assert.equal(L.maxTo, allInTo);
    } else {
      assert.equal(L.minTo, fullMin);
      if (h.variant === 'NLH') assert.equal(L.maxTo, allInTo);
      else assert.equal(L.maxTo, Math.min(allInTo, Math.max(fullMin, h.currentBet + E.potTotal(h) + toCall)), 'PLO cap');
    }
  }

  // ── a hand just finished: replay it and recompute the money ──
  verifyComplete(h, prev) {
    const st = this.st;
    const ref = referee(h);
    this.stats.outOfTurnCloses += ref.oofCloses;
    const live = h.order.filter((pid) => !h.ps[pid].folded);
    assert.deepEqual(ref.L, live);
    const total = E.potTotal(h);
    const res = h.results;
    const nz = (m) => Object.fromEntries(Object.entries(m).filter(([, v]) => v > 0));
    for (const pid of h.order) assert.equal(h.ps[pid].won, res.awards[pid] || 0, `won of ${pid}`);
    // only reveals / runout reveals may follow the payouts
    for (const e of ref.rest) assert.ok(e.text === 'shows' || e.text === 'reveals the runout', `unexpected "${e.text}" after the hand`);

    if (ref.ended === 'fold') {
      this.stats.foldEnds++;
      assert.equal(res.endedBy, 'fold');
      assert.deepEqual(nz(res.awards), { [live[0]]: total });
      assert.deepEqual(res.winners, [live[0]]);
      assert.equal(ref.shows.length, 0);
      for (const pid of h.order) {
        const before = prev && prev.handNo === h.no ? null : null;
        void before;
        // nobody's cards are turned up by a fold ending (voluntary shows come later, after the 'wins' line)
        const shownByLog = ref.rest.some((e) => e.text === 'shows' && e.pid === pid);
        if (!shownByLog) assert.ok(h.ps[pid].shown.every((s) => !s), `${pid}'s cards stay hidden after a fold ending`);
      }
      return;
    }
    assert.equal(res.endedBy, 'showdown');
    this.stats.showdowns++;
    if (ref.ended === 'runout') this.stats.runouts++;
    if (h.runs > 1) this.stats.multiRuns++;
    const boards = h.runBoards;
    assert.equal(boards.length, h.runs);
    for (const b of boards) assert.equal(b.length, 5);
    const R = refAwards(h, boards);
    // pots
    assert.equal(res.pots.length, R.pots.length, 'number of pots');
    res.pots.forEach((p, k) => {
      assert.equal(p.amount, R.pots[k].amount, `pot ${k} amount`);
      assert.ok(sameSet(p.eligible, R.pots[k].eligible), `pot ${k} eligible`);
    });
    if (R.pots.length > 1) this.stats.sidePots++;
    const topLive = Math.max(...live.map((pid) => h.ps[pid].committed));
    if (h.order.some((pid) => h.ps[pid].committed > topLive)) this.stats.deadAboveTop++;
    if (h.runs > 1 && res.pots.some((p) => p.eligible.length > 1 && p.amount % h.runs)) this.stats.unevenRunSplits++;
    assert.deepEqual(nz(res.awards), nz(R.awards), 'awards match the reference');
    assert.deepEqual(nz(ref.paid), nz(R.awards), 'the log reports every payout');
    // run winners (best hand among everyone live) and evaluator categories
    boards.forEach((b, r) => {
      const best = Math.max(...live.map((pid) => R.scores[r][pid]));
      const ws = live.filter((pid) => R.scores[r][pid] === best);
      assert.ok(sameSet(res.runs[r].winners, ws), `run ${r} winners`);
      assert.deepEqual(res.runs[r].board, b);
      for (const pid of live) {
        assert.equal(evaluateFor(h.variant, h.ps[pid].hole, b).category, catOf(R.scores[r][pid]), 'evaluator category');
      }
    });
    if (Object.values(R.awards).filter((v) => v > 0).length > 1) this.stats.splits++;
    // mandatory reveals (§6.3)
    if (ref.ended === 'runout') {
      assert.deepEqual(ref.shows, live, 'all-in: everyone live was turned up');
    } else {
      const expectFor = (s) => {
        const first = h.lastAggressor && !h.ps[h.lastAggressor].folded ? h.lastAggressor : live[0];
        const must = new Set([...R.contestedWinners, first]);
        if (s.showdownLosers === 'show') for (const pid of live) must.add(pid);
        const start = live.indexOf(first);
        const out = [];
        for (let k = 0; k < live.length; k++) {
          const pid = live[(start + k) % live.length];
          if (must.has(pid)) out.push(pid);
        }
        return out;
      };
      const a = expectFor(st.settings);
      const b = prev ? expectFor(prev.settings) : a;
      assert.ok(
        JSON.stringify(ref.shows) === JSON.stringify(a) || JSON.stringify(ref.shows) === JSON.stringify(b),
        `showdown reveals ${JSON.stringify(ref.shows)} expected ${JSON.stringify(a)}`,
      );
    }
    for (const pid of h.order) {
      if (!h.ps[pid].folded) continue;
      const shownByLog = ref.rest.some((e) => e.text === 'shows' && e.pid === pid);
      if (!shownByLog) assert.ok(h.ps[pid].shown.every((s) => !s), `folded ${pid}'s cards stay hidden`);
    }
  }

  /** The archived hand (state.lastHand) agrees with what we saw while it was live. */
  checkArchive(lh, t) {
    assert.ok(lh.results, 'archived results');
    for (const ap of lh.players) {
      const hole = t.hole[ap.pid];
      ap.cards.forEach((c, i) => {
        if (c != null) assert.equal(c, hole[i], 'archived shown card');
        if (t.verified) assert.equal(c != null, t.shown[ap.pid][i], 'archived cards are exactly the shown ones');
      });
    }
  }

  // ── driver ──
  play() {
    this.setup();
    let lastProgress = 0;
    let lastHands = 0;
    while (this.handsDone < this.handsWanted && !this.st.ended) {
      this.step();
      if (!this.st.hand && this.st.deadline == null) this.idle++;
      else this.idle = 0;
      if (this.idle > 12) {
        this.heal();
        this.idle = 0;
      }
      if (this.handsDone !== lastHands) {
        lastHands = this.handsDone;
        lastProgress = this.stepNo;
      }
      assert.ok(this.stepNo - lastProgress < 6000, 'the game made no progress for 6000 steps');
      if (this.chance(0.002)) this.drain();
    }
    if (!this.st.ended) {
      this.drain();
      if (this.chance(0.5)) {
        this.run(this.st.hostId, { type: 'endGame' }, 'ok');
        this.drain();
        if (this.st.hand) {
          // complete: next-hand deadline wraps it up and ends the game
          this.ctx.now = this.st.deadline + 1;
          E.tick(this.st, this.ctx);
          this.observe('tick');
        }
      }
    }
    if (this.st.ended) this.checkEnded();
  }

  checkEnded() {
    const st = this.st;
    this.stats.endedGames++;
    assert.equal(st.hand, null);
    assert.equal(st.deadline, null);
    assert.equal(this.seated().length, 0);
    const L = summarize(st);
    assert.equal(L.totals.chipsOnTable, 0);
    assert.equal(L.totals.diff, L.totals.uncountedAdjust);
    for (const pid of this.pids()) {
      this.run(pid, { type: 'sit', seat: 0, amount: st.settings.minBuyIn }, 'err');
      this.run(pid, { type: 'away', on: true }, 'err');
    }
    this.run(st.hostId, { type: 'pause', on: false }, 'err');
    this.run(this.pick(this.pids()), { type: 'chat', text: 'good game' }, 'ok');
    this.ctx.now += 3_600_000;
    assert.equal(E.tick(st, this.ctx), false, 'nothing ever happens in an ended game');
  }
}

function runGames(totalHands, masterSeed) {
  const stats = {
    games: 0,
    hands: 0,
    verified: 0,
    unverified: 0,
    showdowns: 0,
    foldEnds: 0,
    runouts: 0,
    multiRuns: 0,
    sidePots: 0,
    splits: 0,
    runoutReveals: 0,
    actions: 0,
    rejected: 0,
    illegal: 0,
    bigJumps: 0,
    endedGames: 0,
    balancedSettles: 0,
    raiseLocks: 0,
    timeouts: 0,
    deadAboveTop: 0,
    unevenRunSplits: 0,
    outOfTurnCloses: 0,
    equityExact: 0,
  };
  const pick = mulberry32(masterSeed);
  while (stats.hands < totalHands) {
    const seed = (Math.floor(pick() * 2 ** 31) ^ stats.games) >>> 0;
    const want = Math.min(totalHands - stats.hands, 10 + Math.floor(pick() * 250));
    const f = new Fuzzer(seed, want, stats);
    try {
      f.play();
    } catch (err) {
      err.message = `[fuzz game seed=${seed} step=${f.stepNo} hand=${f.st && f.st.hand ? f.st.hand.no : '-'} last=${f.lastLabel}] ${err.message}`;
      throw err;
    }
    stats.games++;
  }
  return stats;
}

test(`fuzz: ${TOTAL_HANDS} random hands keep every invariant (seed ${MASTER_SEED})`, { timeout: 3_600_000 }, (t) => {
  const t0 = Date.now();
  const stats = runGames(TOTAL_HANDS, MASTER_SEED);
  t.diagnostic(`${JSON.stringify(stats)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  assert.ok(stats.hands >= TOTAL_HANDS);
  assert.ok(stats.verified > stats.hands * 0.8, 'most hands were checked at completion');
  if (TOTAL_HANDS >= 1000) {
    for (const k of ['showdowns', 'foldEnds', 'runouts', 'multiRuns', 'sidePots', 'splits', 'raiseLocks', 'timeouts', 'runoutReveals', 'equityExact', 'endedGames']) {
      assert.ok(stats[k] > 0, `coverage: no ${k} in ${TOTAL_HANDS} hands`);
    }
  }
});


// ─── scripted scenarios for paths random play reaches rarely (same per-step oracle) ──────────────

const scripted = (settings, stacks, seed = 1) => {
  const stats = new Proxy({}, { get: (o, k) => o[k] || 0, set: (o, k, v) => ((o[k] = v), true) });
  return new Fuzzer(seed, 0, stats).table(settings, stacks);
};
const play = (f, pid, move, to) => f.run(pid, { type: 'act', move, ...(to != null ? { to } : {}) }, 'ok');

test('scenario: a player who leaves after out-betting every remaining all-in player — dead money goes to the top pot', () => {
  const f = scripted({}, [200, 31, 62]);
  const h = f.fire(); // button p0, SB p1, BB p2; p0 first to act
  assert.deepEqual([h.sbSeat, h.bbSeat, h.toAct], [1, 2, 'p0']);
  play(f, 'p0', 'call');
  play(f, 'p1', 'call');
  play(f, 'p2', 'check');
  play(f, 'p1', 'check');
  play(f, 'p2', 'check');
  play(f, 'p0', 'raise', 100);
  play(f, 'p1', 'call'); // all-in for 29 more
  f.run('p0', { type: 'leave' }, 'ok'); // folds out of turn with 100 in, cashes out the rest
  assert.equal(f.st.players.p0.seat, null);
  play(f, 'p2', 'call'); // all-in for 60 — less than p0's dead 100
  while (f.st.hand.phase !== 'complete') f.fire();
  const r = f.st.hand.results;
  assert.deepEqual(r.pots.map((p) => [p.amount, p.eligible.slice().sort()]), [
    [93, ['p1', 'p2']],
    [102, ['p2']],
  ]);
  assert.equal(r.awards.p2 >= 102, true, 'p2 gets back the uncalled part including the dead money above');
});

test('scenario: an out-of-turn fold that leaves one actor against an all-in closes the street at once', () => {
  const f = scripted({}, [200, 200, 20]);
  f.fire();
  play(f, 'p0', 'call');
  play(f, 'p1', 'call');
  play(f, 'p2', 'raise', 20); // all-in
  play(f, 'p0', 'call');
  play(f, 'p1', 'call');
  const h = f.st.hand;
  assert.equal(h.street, 'flop');
  assert.equal(h.toAct, 'p1', 'p1 has the option on the flop');
  f.run('p0', { type: 'leave' }, 'ok');
  assert.notEqual(f.st.hand.phase, 'betting', 'p1 has nobody left to bet against: straight to the runout');
  while (f.st.hand.phase !== 'complete') f.fire();
});

test('scenario: short all-ins that add up to a full raise reopen the betting; ones that do not, do not', () => {
  for (const [bbStack, reopened] of [
    [19, true],
    [17, false],
  ]) {
    const f = scripted({}, [500, 14, bbStack, 500]);
    const h = f.fire(); // button p0, SB p1, BB p2, UTG p3
    assert.equal(h.toAct, 'p3');
    play(f, 'p3', 'raise', 10); // full raise (+8)
    play(f, 'p0', 'call');
    play(f, 'p1', 'raise', 14); // all-in, +4: short
    play(f, 'p2', 'raise', bbStack); // all-in, short again
    assert.equal(f.st.hand.toAct, 'p3');
    assert.equal(E.legalActions(f.st, 'p3').raise, reopened);
    if (!reopened) f.run('p3', { type: 'act', move: 'raise', to: 40 }, 'err');
    else play(f, 'p3', 'raise', 40);
    while (f.st.hand.phase === 'betting') play(f, f.st.hand.toAct, 'call');
    while (f.st.hand.phase !== 'complete') f.fire();
  }
});

test('scenario: 9-handed PLO all-in preflop run three times uses 51 of 52 cards', () => {
  const f = scripted({ variant: 'PLO', maxRuns: 3 }, [2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
  f.fire();
  while (f.st.hand.phase === 'betting') {
    const pid = f.st.hand.toAct;
    const L = E.legalActions(f.st, pid);
    play(f, pid, L.raise ? 'raise' : 'call', L.raise ? L.maxTo : null);
  }
  assert.equal(f.st.hand.phase, 'ritVote');
  for (const v of f.st.hand.ritVoters.slice()) if (f.st.hand.phase === 'ritVote') f.run(v, { type: 'vote', runs: 3 }, 'ok');
  assert.equal(f.st.hand.runs, 3);
  while (f.st.hand.phase !== 'complete') f.fire();
  assert.equal(f.st.hand.deck.length, 1);
  assert.equal(f.st.hand.results.runs.length, 3);
});

test('scenario: one-chip stacks with sb = bb = 1 — everybody is all-in from the blinds', () => {
  const f = scripted({ sb: 1, bb: 1, maxRuns: 2 }, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  f.fire();
  while (f.st.hand.phase === 'betting') play(f, f.st.hand.toAct, 'call');
  while (f.st.hand.phase !== 'complete') f.fire();
  assert.equal(Object.values(f.st.hand.results.awards).reduce((a, b) => a + b, 0), 9);
  f.fire(); // the next hand needs two players with chips
});

test('scenario: a room nobody watches for days times everyone out, sends them away and goes quiet', () => {
  const f = scripted({ autoAwayTimeouts: 2, actionTime: 10 }, [100, 100, 100, 100]);
  let jumps = 0;
  while (f.st.deadline != null) {
    assert.ok(++jumps < 60, 'the room settles down');
    f.ctx.now += 86_400_000;
    f.lastLabel = 'day jump';
    E.tick(f.st, f.ctx);
    f.observe('tick');
  }
  assert.equal(f.st.hand, null);
  // play stops once fewer than two players are left who are not away
  assert.ok(f.seated().filter((p) => !p.away).length <= 1);
  assert.ok(f.seated().filter((p) => p.away).every((p) => p.awayBy === 'timeout' && p.timeouts >= 2));
  assert.ok(f.st.handNo >= 1);
});
