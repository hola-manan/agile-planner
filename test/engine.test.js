// Tests for lib/engine.js (SPEC §5–§8). Run: node --test test/
//
// Conventions: a seeded PRNG drives every shuffle; rig() replaces hole cards / the deck after a deal
// so outcomes are exact; act() checks the chip-conservation invariant after EVERY action and fails()
// checks that a rejected action left the state byte-for-byte unchanged (validate-before-mutate).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../lib/engine.js';
import { fullDeck, shuffle } from '../lib/cards.js';
import { evaluateFor } from '../lib/evaluator.js';
import { summarize } from '../lib/ledger.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 1_700_000_000_000;

/** Σ chips that exist at the table right now. */
function chipsInPlay(state) {
  let chips = 0;
  for (const p of Object.values(state.players)) chips += p.stack + p.pendingChips;
  const h = state.hand;
  if (h && h.phase !== 'complete') for (const pid of h.order) chips += h.ps[pid].committed;
  return chips;
}

/** Σ buy-ins + Σ adjustments (counted or not) − Σ cash-outs, straight from the ledger. */
function ledgerChips(state) {
  let t = 0;
  for (const e of state.ledger) t += e.type === 'cashout' ? -e.amount : e.amount;
  return t;
}

function check(state) {
  assert.equal(chipsInPlay(state), ledgerChips(state), 'chip conservation');
  const seats = new Set();
  for (const p of Object.values(state.players)) {
    assert.ok(Number.isInteger(p.stack) && p.stack >= 0, `stack of ${p.id} is a non-negative integer`);
    assert.ok(Number.isInteger(p.pendingChips) && p.pendingChips >= 0);
    if (p.seat == null) {
      assert.equal(p.stack, 0, `unseated ${p.id} holds no chips`);
      assert.equal(p.pendingChips, 0);
    } else {
      assert.ok(p.seat >= 0 && p.seat < state.settings.seats, 'seat in range');
      assert.ok(!seats.has(p.seat), 'one player per seat');
      seats.add(p.seat);
    }
  }
  const h = state.hand;
  if (h) {
    const cards = [...h.order.flatMap((pid) => h.ps[pid].hole), ...h.deck];
    const boards = h.runBoards.length ? h.runBoards : [h.board];
    const shared = h.runs > 1 ? h.board.length : 0;
    cards.push(...boards[0]);
    for (let r = 1; r < boards.length; r++) cards.push(...boards[r].slice(shared));
    assert.equal(new Set(cards).size, cards.length, 'no card appears twice');
    assert.equal(cards.length, 52, 'every card is accounted for');
    if (h.phase === 'betting') {
      const t = h.ps[h.toAct];
      assert.ok(t && !t.folded && !t.allIn, 'the player to act can act');
      assert.equal(state.deadlineKind, 'action');
    }
    if (h.phase === 'complete') {
      const awarded = Object.values(h.results.awards).reduce((a, b) => a + b, 0);
      assert.equal(awarded, E.potTotal(h), 'the whole pot is awarded');
    }
  }
}

function newGame({ n = 3, seats = null, stacks = null, settings = {}, seed = 1, sit = true } = {}) {
  const ctx = { now: T0, rng: mulberry32(seed) };
  const state = E.createRoom(
    {
      code: 'TST-0001',
      name: 'Test game',
      hostName: 'P0',
      hostId: 'p0',
      hostTokenHash: 'tokenhash-p0',
      settings: { approveBuyIns: false, minBuyIn: 1, maxBuyIn: 100000, ...settings },
    },
    ctx,
  );
  for (let i = 1; i < n; i++) E.addPlayer(state, { id: `p${i}`, name: `P${i}`, tokenHash: `tokenhash-p${i}` }, ctx);
  const g = { state, ctx };
  if (sit) {
    for (let i = 0; i < n; i++) act(g, `p${i}`, { type: 'sit', seat: seats ? seats[i] : i, amount: stacks ? stacks[i] : 200 });
  }
  return g;
}

function act(g, pid, action) {
  E.apply(g.state, pid, action, g.ctx);
  check(g.state);
  return g.state;
}

function fails(g, pid, action, code, re) {
  const before = JSON.stringify(g.state);
  assert.throws(
    () => E.apply(g.state, pid, action, g.ctx),
    (err) => {
      assert.ok(err instanceof E.EngineError, `expected an EngineError, got ${err && err.stack}`);
      if (code) assert.equal(err.code, code, `error code for ${JSON.stringify(action)}: ${err.message}`);
      if (re) assert.match(err.message, re);
      return true;
    },
  );
  assert.equal(JSON.stringify(g.state), before, 'a rejected action must not change the state');
}

function wait(g, ms) {
  g.ctx.now += ms;
  const changed = E.tick(g.state, g.ctx);
  check(g.state);
  return changed;
}

/** Jump to the pending deadline and process it. */
function fire(g) {
  assert.notEqual(g.state.deadline, null, 'a deadline is pending');
  g.ctx.now = Math.max(g.ctx.now, g.state.deadline);
  E.tick(g.state, g.ctx);
  check(g.state);
}

function deal(g) {
  assert.equal(g.state.hand, null, 'no hand is running');
  assert.equal(g.state.deadlineKind, 'nextHand');
  fire(g);
  assert.ok(g.state.hand, 'a hand started');
  return g.state.hand;
}

/** Finish the completed hand and deal the next one (if possible). */
function nextHand(g) {
  assert.equal(g.state.hand.phase, 'complete');
  fire(g);
  return g.state.hand;
}

/** Give players specific hole cards and put `board` on top of the remaining deck. */
function rig(g, holes, board = []) {
  const h = g.state.hand;
  const taken = new Set([...Object.values(holes).flat(), ...board, ...h.board]);
  const pool = fullDeck().filter((c) => !taken.has(c));
  for (const pid of h.order) h.ps[pid].hole = holes[pid] ? holes[pid].slice() : pool.splice(0, h.ps[pid].hole.length);
  h.deck = [...board, ...pool];
}

const hand = (g) => g.state.hand;
const toAct = (g) => g.state.hand.toAct;
const ps = (g, pid) => g.state.hand.ps[pid];
const stack = (g, pid) => g.state.players[pid].stack;
const player = (g, pid) => g.state.players[pid];
/** Chips a player holds: behind + pending + in a live pot. */
function holding(g, pid) {
  const h = g.state.hand;
  const inPot = h && h.phase !== 'complete' && h.ps[pid] ? h.ps[pid].committed : 0;
  return stack(g, pid) + player(g, pid).pendingChips + inPot;
}
const lastLog = (g) => g.state.hand.log[g.state.hand.log.length - 1];
const legal = (g, pid) => E.legalActions(g.state, pid);

function foldOut(g) {
  while (g.state.hand && g.state.hand.phase === 'betting') act(g, toAct(g), { type: 'act', move: 'fold' });
}

function checkDown(g) {
  while (g.state.hand && g.state.hand.phase === 'betting') {
    const pid = toAct(g);
    act(g, pid, { type: 'act', move: legal(g, pid).check ? 'check' : 'call' });
  }
}

function runOut(g) {
  while (g.state.hand && (g.state.hand.phase === 'runout' || g.state.hand.phase === 'ritVote')) fire(g);
}

// ─── room setup & settings ───────────────────────────────────────────────────

describe('room setup', () => {
  test('createRoom builds the spec state with the host joined but not seated', () => {
    const ctx = { now: T0, rng: mulberry32(1) };
    const s = E.createRoom(
      {
        code: 'RVR-4821',
        name: '  Friday   Night Game ',
        hostName: '  Maya ',
        hostId: 'h1',
        hostTokenHash: 'abc',
        settings: { variant: 'plo', sb: '5', bb: 10, seats: 12, actionTime: 3, maxRuns: 7 },
      },
      ctx,
    );
    assert.equal(s.schema, 1);
    assert.equal(s.code, 'RVR-4821');
    assert.equal(s.name, 'Friday Night Game');
    assert.equal(s.createdAt, T0);
    assert.equal(s.hostId, 'h1');
    assert.deepEqual(Object.keys(s.players), ['h1']);
    const host = s.players.h1;
    assert.equal(host.name, 'Maya');
    assert.equal(host.seat, null);
    assert.equal(host.stack, 0);
    assert.equal(host.tokenHash, 'abc');
    assert.equal(host.joinedAt, T0);
    assert.deepEqual(s.settings, {
      ...E.DEFAULT_SETTINGS,
      variant: 'PLO',
      sb: 5,
      bb: 10,
      seats: 9,
      actionTime: 10,
      maxRuns: 3,
    });
    for (const [k, v] of Object.entries({ hand: null, lastHand: null, deadline: null, deadlineKind: null, button: null })) {
      assert.equal(s[k], v, k);
    }
    assert.equal(s.handNo, 0);
    assert.equal(s.seq, 0);
    assert.deepEqual([s.requests, s.pendingAdjust, s.ledger, s.chat], [[], [], [], []]);
    assert.deepEqual(s.paid, {});
    assert.equal(s.paused || s.pauseAfterHand || s.ended || s.endAfterHand, false);
  });

  test('createRoom defaults a blank game name and validates the host name and settings', () => {
    const ctx = { now: T0, rng: mulberry32(1) };
    const base = { code: 'ABC-1234', hostName: 'Ann', hostId: 'a', hostTokenHash: 'x' };
    assert.equal(E.createRoom({ ...base, name: '   ' }, ctx).name, 'Home Game');
    assert.equal(E.createRoom({ ...base }, ctx).settings.variant, 'NLH');
    assert.throws(() => E.createRoom({ ...base, hostName: '   ' }, ctx), { code: 'bad_request' });
    assert.throws(() => E.createRoom({ ...base, hostName: 'x'.repeat(21) }, ctx), { code: 'bad_request' });
    assert.throws(() => E.createRoom({ ...base, settings: { sb: 5, bb: 2 } }, ctx), { code: 'bad_request' });
  });

  test('sanitizeSettings clamps ranges, merges over the base and rejects nonsense', () => {
    const base = E.sanitizeSettings({});
    assert.deepEqual(base, { ...E.DEFAULT_SETTINGS });
    const s = E.sanitizeSettings(
      { seats: 1, nextHandDelay: 99, autoAwayTimeouts: -3, actionTime: 500, approveBuyIns: 'false', revealRunout: 'HOST', foo: 1 },
      base,
    );
    assert.equal(s.seats, 2);
    assert.equal(s.nextHandDelay, 30);
    assert.equal(s.autoAwayTimeouts, 0);
    assert.equal(s.actionTime, 120);
    assert.equal(s.approveBuyIns, false);
    assert.equal(s.revealRunout, 'host');
    assert.equal('foo' in s, false);
    assert.deepEqual(E.sanitizeSettings({ bb: 4 }, { ...base, sb: 2 }), { ...base, sb: 2, bb: 4 });
    assert.deepEqual(E.sanitizeSettings({ sb: null, bb: '' }, base), base, 'null / empty mean unchanged');
    const bad = [
      { sb: 5, bb: 2 },
      { minBuyIn: 500, maxBuyIn: 100 },
      { variant: 'stud' },
      { bb: 2.5 },
      { sb: 0 },
      { maxBuyIn: -4 },
      { revealRunout: 'everyone' },
      { showdownLosers: 'never' },
      { approveBuyIns: 'maybe' },
      { seats: 'many' },
    ];
    for (const patch of bad) {
      assert.throws(
        () => E.sanitizeSettings(patch, base),
        (e) => e instanceof E.EngineError && e.code === 'bad_request',
        JSON.stringify(patch),
      );
    }
    assert.throws(() => E.sanitizeSettings('nope', base), { code: 'bad_request' });
  });

  test('addPlayer validates names, rejects a duplicate id and caps the room at 30 players', () => {
    const g = newGame({ n: 1, sit: false });
    const p = E.addPlayer(g.state, { id: 'x', name: '  Bob  Smith ', tokenHash: 'th' }, g.ctx);
    assert.equal(p.name, 'Bob Smith');
    assert.equal(g.state.players.x, p);
    assert.equal(p.seat, null);
    assert.throws(() => E.addPlayer(g.state, { id: 'x', name: 'Again', tokenHash: 't' }, g.ctx), { code: 'conflict' });
    assert.throws(() => E.addPlayer(g.state, { id: 'y', name: '', tokenHash: 't' }, g.ctx), { code: 'bad_request' });
    assert.throws(() => E.addPlayer(g.state, { id: 'y', name: 'a'.repeat(21), tokenHash: 't' }, g.ctx), { code: 'bad_request' });
    for (let i = 0; i < 28; i++) E.addPlayer(g.state, { id: `q${i}`, name: `Q${i}`, tokenHash: 't' }, g.ctx);
    assert.equal(Object.keys(g.state.players).length, 30);
    assert.throws(() => E.addPlayer(g.state, { id: 'z', name: 'Late', tokenHash: 't' }, g.ctx), { code: 'conflict' });
  });

  test('apply rejects unknown actions, strangers and non-hosts', () => {
    const g = newGame({ n: 2 });
    fails(g, 'p1', { type: 'dance' }, 'bad_request', /Unknown action/);
    fails(g, 'p1', null, 'bad_request');
    fails(g, 'nobody', { type: 'chat', text: 'hi' }, 'forbidden', /Join/);
    fails(g, null, { type: 'chat', text: 'hi' }, 'forbidden');
    for (const type of ['approve', 'deny', 'adjust', 'setAway', 'remove', 'settings', 'pause', 'markPaid', 'endGame', 'transferHost']) {
      fails(g, 'p1', { type }, 'forbidden', /Only the host/);
    }
    E.apply(g.state, null, { type: 'tick' }, g.ctx); // anyone may tick
  });
});

// ─── starting hands: positions, blinds, rotation ─────────────────────────────

describe('starting a hand', () => {
  test('sitting down schedules the first hand; lowest seat gets the button; blinds post; UTG acts', () => {
    const g = newGame({ n: 3, seats: [2, 5, 7], seed: 11 });
    assert.equal(g.state.deadlineKind, 'nextHand');
    assert.equal(g.state.deadline, T0 + 3000);
    const h = deal(g);
    assert.equal(h.no, 1);
    assert.equal(g.state.handNo, 1);
    assert.equal(h.startedAt, T0 + 3000);
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat, g.state.button], [2, 5, 7, 2]);
    assert.deepEqual(h.order, ['p1', 'p2', 'p0']);
    assert.deepEqual([ps(g, 'p1').bet, ps(g, 'p2').bet, ps(g, 'p0').bet], [1, 2, 0]);
    assert.deepEqual([stack(g, 'p1'), stack(g, 'p2'), stack(g, 'p0')], [199, 198, 200]);
    assert.deepEqual([h.currentBet, h.minRaise, h.street, h.phase], [2, 2, 'preflop', 'betting']);
    assert.equal(h.toAct, 'p0');
    assert.equal(g.state.deadlineKind, 'action');
    assert.equal(g.state.deadline, g.ctx.now + 25000);
    assert.deepEqual([h.sb, h.bb, h.variant], [1, 2, 'NLH']);
    // dealt one card at a time round-robin from `order`, from a shuffle of the seeded rng
    const deck = shuffle(fullDeck(), mulberry32(11));
    assert.deepEqual(ps(g, 'p1').hole, [deck[0], deck[3]]);
    assert.deepEqual(ps(g, 'p2').hole, [deck[1], deck[4]]);
    assert.deepEqual(ps(g, 'p0').hole, [deck[2], deck[5]]);
    assert.deepEqual(h.deck, deck.slice(6));
    assert.deepEqual(h.log.map((e) => e.text), ['posts small blind', 'posts big blind']);
    for (const pid of h.order) assert.equal(ps(g, pid).lastAction, null);
    // the board comes off the top of the deck, no burns
    checkDown(g);
    assert.deepEqual(hand(g).board, deck.slice(6, 11));
  });

  test('heads-up: the button posts the small blind and acts first preflop, last after the flop', () => {
    const g = newGame({ n: 2 });
    let h = deal(g);
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat], [0, 0, 1]);
    assert.deepEqual(h.order, ['p1', 'p0']);
    assert.deepEqual([ps(g, 'p0').bet, ps(g, 'p1').bet], [1, 2]);
    assert.equal(toAct(g), 'p0');
    act(g, 'p0', { type: 'act', move: 'call' });
    assert.equal(toAct(g), 'p1', 'the big blind has the option');
    assert.equal(legal(g, 'p1').check, true);
    act(g, 'p1', { type: 'act', move: 'check' });
    assert.equal(h.street, 'flop');
    assert.equal(toAct(g), 'p1', 'the big blind acts first after the flop');
    act(g, 'p1', { type: 'act', move: 'check' });
    assert.equal(toAct(g), 'p0');
    act(g, 'p0', { type: 'act', move: 'raise', to: 2 });
    act(g, 'p1', { type: 'act', move: 'fold' });
    h = nextHand(g);
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat, h.toAct], [1, 1, 0, 'p1']);
  });

  test('the button moves to the next eligible seat, skipping empty, away and busted seats', () => {
    const g = newGame({ n: 4, seats: [0, 2, 5, 7] });
    let h = deal(g);
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat, h.toAct], [0, 2, 5, 'p3']);
    foldOut(g);
    act(g, 'p1', { type: 'away', on: true }); // between hands
    h = nextHand(g);
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat], [5, 7, 0]);
    assert.deepEqual(h.order, ['p3', 'p0', 'p2']);
    assert.ok(!h.ps.p1, 'away players are not dealt in');
    // the host zeroes p3's stack — deferred because p3 is in this hand
    act(g, 'p0', { type: 'adjust', pid: 'p3', mode: 'set', amount: 0, reason: 'test', countAsBuyIn: false });
    assert.equal(g.state.pendingAdjust.length, 1);
    foldOut(g);
    h = nextHand(g);
    assert.equal(stack(g, 'p3'), 0, 'busted');
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat], [0, 0, 5], 'heads-up between the two left');
    assert.deepEqual(h.order, ['p2', 'p0']);
  });

  test('short stacks post what they have; a short big blind sets currentBet but minRaise stays bb', () => {
    let g = newGame({ n: 3, stacks: [500, 3, 500], settings: { sb: 5, bb: 10 } });
    deal(g);
    assert.deepEqual([ps(g, 'p1').bet, ps(g, 'p1').allIn, stack(g, 'p1')], [3, true, 0]);
    assert.deepEqual([ps(g, 'p2').bet, hand(g).currentBet, hand(g).minRaise], [10, 10, 10]);
    assert.equal(hand(g).log[0].text, 'posts small blind (all-in)');
    assert.deepEqual(legal(g, 'p0'), { fold: true, check: false, call: 10, raise: true, minTo: 20, maxTo: 500, potTo: 33 });

    g = newGame({ n: 3, stacks: [500, 500, 4], settings: { sb: 5, bb: 10 } });
    deal(g);
    assert.deepEqual([ps(g, 'p2').bet, ps(g, 'p2').allIn], [4, true]);
    assert.deepEqual([ps(g, 'p1').bet, hand(g).currentBet, hand(g).minRaise], [5, 5, 10]);
    const L = legal(g, 'p0');
    assert.deepEqual([L.call, L.minTo, L.maxTo], [5, 15, 500]);
  });

  test('heads-up: a blind all-in for less than the big blind goes straight to the runout; the excess comes back', () => {
    const g = newGame({ n: 2, stacks: [3, 500], settings: { sb: 5, bb: 10, maxRuns: 1 } });
    deal(g);
    assert.equal(hand(g).phase, 'runout');
    assert.equal(hand(g).toAct, null);
    assert.ok(hand(g).order.every((pid) => ps(g, pid).shown.every(Boolean)), 'all-in hands are face up');
    rig(g, { p0: ['2c', '7d'], p1: ['As', 'Ad'] }, ['Kh', 'Qh', '9s', '5c', '3d']);
    runOut(g);
    const r = hand(g).results;
    assert.equal(r.endedBy, 'showdown');
    assert.deepEqual(
      r.pots.map((p) => [p.amount, p.eligible, !!p.returned]),
      [
        [6, ['p1', 'p0'], false],
        [7, ['p1'], true],
      ],
    );
    assert.deepEqual(r.awards, { p1: 13 });
    assert.deepEqual([stack(g, 'p0'), stack(g, 'p1')], [0, 503]);
  });

  test('waitForBB: a returning player is dealt in only when the big blind reaches them', () => {
    const g = newGame({ n: 4 });
    let h = deal(g); // button 0, SB 1, BB 2, UTG 3
    assert.equal(toAct(g), 'p3');
    act(g, 'p3', { type: 'away', on: true }); // on their turn → folded at once
    assert.equal(ps(g, 'p3').folded, true);
    assert.equal(lastLog(g).text, 'folds (away)');
    foldOut(g);
    h = nextHand(g);
    assert.equal(h.button, 1);
    assert.ok(!h.ps.p3);
    act(g, 'p3', { type: 'away', on: false, waitForBB: true });
    assert.deepEqual([player(g, 'p3').away, player(g, 'p3').waitForBB], [false, true]);
    foldOut(g);
    h = nextHand(g); // button 2, SB 0, BB 1: p3 would not be the big blind
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat], [2, 0, 1]);
    assert.ok(!h.ps.p3);
    foldOut(g);
    h = nextHand(g); // button 0, SB 1, BB 2
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat], [0, 1, 2]);
    assert.ok(!h.ps.p3);
    foldOut(g);
    h = nextHand(g); // button 1, SB 2 — the big blind is p3's seat now
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat], [1, 2, 3]);
    assert.ok(h.ps.p3);
    assert.equal(ps(g, 'p3').bet, 2);
    assert.equal(player(g, 'p3').waitForBB, false);
  });

  test('waitForBB never stops the game: with fewer than two other players the waiter is dealt in', () => {
    const g = newGame({ n: 2 });
    deal(g);
    act(g, 'p0', { type: 'act', move: 'fold' });
    act(g, 'p1', { type: 'away', on: true });
    fire(g);
    assert.equal(g.state.hand, null);
    assert.equal(g.state.deadline, null, 'nothing scheduled with one eligible player');
    act(g, 'p1', { type: 'away', on: false, waitForBB: true });
    assert.equal(g.state.deadlineKind, 'nextHand');
    const h = deal(g);
    assert.ok(h.ps.p0 && h.ps.p1);
    assert.equal(player(g, 'p1').waitForBB, false);
  });

  test('no hand starts without two eligible players, while paused, or for players leaving', () => {
    const g = newGame({ n: 2, sit: false });
    act(g, 'p0', { type: 'sit', seat: 0, amount: 100 });
    assert.equal(g.state.deadline, null);
    assert.equal(E.canStartHand(g.state), false);
    act(g, 'p1', { type: 'sit', seat: 1, amount: 100 });
    assert.equal(E.canStartHand(g.state), true);
    act(g, 'p0', { type: 'pause', on: true });
    assert.equal(g.state.paused, true);
    assert.equal(g.state.deadline, null, 'pausing cancels the pending deal');
    act(g, 'p0', { type: 'pause', on: false });
    assert.equal(g.state.deadline, g.ctx.now + 3000);
  });
});

// ─── betting ─────────────────────────────────────────────────────────────────

describe('betting', () => {
  test('NLH: the opening bet is at least the big blind; raises are at least the last full raise', () => {
    const g = newGame({ n: 3 });
    deal(g); // button p0 (UTG 3-handed), SB p1, BB p2
    assert.deepEqual(legal(g, 'p0'), { fold: true, check: false, call: 2, raise: true, minTo: 4, maxTo: 200, potTo: 7 });
    assert.equal(legal(g, 'p1'), null, 'not your turn → no legal object');
    fails(g, 'p0', { type: 'act', move: 'raise', to: 3 }, 'bad_request', /minimum raise is to 4/);
    fails(g, 'p0', { type: 'act', move: 'raise', to: 201 }, 'bad_request', /200/);
    fails(g, 'p0', { type: 'act', move: 'raise', to: 'lots' }, 'bad_request');
    fails(g, 'p0', { type: 'act', move: 'check' }, 'bad_request', /2 to call/);
    fails(g, 'p0', { type: 'act', move: 'dance' }, 'bad_request');
    fails(g, 'p1', { type: 'act', move: 'call' }, 'not_your_turn');
    act(g, 'p0', { type: 'act', move: 'raise', to: 10 });
    assert.deepEqual([hand(g).currentBet, hand(g).minRaise, hand(g).lastAggressor], [10, 8, 'p0']);
    assert.deepEqual(ps(g, 'p0').lastAction, { type: 'raise', amount: 10 });
    assert.deepEqual(lastLog(g), { street: 'preflop', pid: 'p0', text: 'raises to', amount: 10 });
    assert.deepEqual([legal(g, 'p1').call, legal(g, 'p1').minTo], [9, 18]);
    fails(g, 'p1', { type: 'act', move: 'raise', to: 17 }, 'bad_request', /minimum raise is to 18/);
    act(g, 'p1', { type: 'act', move: 'raise', to: 30 });
    assert.equal(hand(g).minRaise, 20);
    assert.deepEqual([legal(g, 'p2').call, legal(g, 'p2').minTo], [28, 50]);
    act(g, 'p2', { type: 'act', move: 'call' });
    assert.deepEqual(ps(g, 'p2').lastAction, { type: 'call', amount: 30 });
    act(g, 'p0', { type: 'act', move: 'call' });
    const h = hand(g);
    assert.equal(h.street, 'flop');
    assert.deepEqual([h.currentBet, h.minRaise, h.board.length], [0, 2, 3]);
    assert.equal(toAct(g), 'p1', 'first player left of the button acts first postflop');
    for (const pid of h.order) {
      assert.equal(ps(g, pid).bet, 0);
      assert.equal(ps(g, pid).lastAction, null, 'action tags clear on a new street');
      assert.equal(ps(g, pid).committed, 30);
    }
    assert.deepEqual(legal(g, 'p1'), { fold: true, check: true, call: 0, raise: true, minTo: 2, maxTo: 170, potTo: 90 });
    fails(g, 'p1', { type: 'act', move: 'raise', to: 1 }, 'bad_request', /minimum bet is 2/);
    act(g, 'p1', { type: 'act', move: 'call' }); // nothing to call: treated as a check
    assert.deepEqual(ps(g, 'p1').lastAction, { type: 'check', amount: 0 });
    act(g, 'p2', { type: 'act', move: 'raise', to: 2 });
    assert.deepEqual(ps(g, 'p2').lastAction, { type: 'bet', amount: 2 });
    assert.deepEqual(lastLog(g), { street: 'flop', pid: 'p2', text: 'bets', amount: 2 });
    assert.deepEqual([legal(g, 'p0').call, legal(g, 'p0').minTo], [2, 4]);
  });

  test('street transitions: flop, turn, river, showdown — with the right first actor each street', () => {
    const g = newGame({ n: 3 });
    deal(g);
    rig(g, { p0: ['Ah', 'Kh'], p1: ['2c', '7d'], p2: ['Qs', 'Qd'] }, ['3c', '8s', '9h', 'Td', '4s']);
    const seen = [];
    while (hand(g).phase === 'betting') {
      seen.push([hand(g).street, hand(g).board.length, toAct(g)]);
      const pid = toAct(g);
      act(g, pid, { type: 'act', move: legal(g, pid).check ? 'check' : 'call' });
    }
    assert.deepEqual(seen, [
      ['preflop', 0, 'p0'],
      ['preflop', 0, 'p1'],
      ['preflop', 0, 'p2'],
      ['flop', 3, 'p1'],
      ['flop', 3, 'p2'],
      ['flop', 3, 'p0'],
      ['turn', 4, 'p1'],
      ['turn', 4, 'p2'],
      ['turn', 4, 'p0'],
      ['river', 5, 'p1'],
      ['river', 5, 'p2'],
      ['river', 5, 'p0'],
    ]);
    const h = hand(g);
    assert.deepEqual(h.board, ['3c', '8s', '9h', 'Td', '4s']);
    assert.deepEqual(
      h.log.filter((e) => e.pid === null).map((e) => [e.text, e.cards]),
      [
        ['Flop', ['3c', '8s', '9h']],
        ['Turn', ['Td']],
        ['River', ['4s']],
      ],
    );
    assert.equal(h.phase, 'complete');
    assert.equal(h.street, 'showdown');
    assert.deepEqual(h.runBoards, [h.board], 'a river showdown has runBoards = [board]');
    assert.deepEqual(h.results.runs, [
      { board: h.board, winners: ['p2'], handName: 'Pair of Queens', amount: 6, awards: { p2: 6 } },
    ]);
  });

  test('a short all-in raise does not reopen the betting for players who already acted', () => {
    const g = newGame({ n: 4, stacks: [200, 15, 200, 200] });
    deal(g); // button p0, SB p1, BB p2, UTG p3
    act(g, 'p3', { type: 'act', move: 'raise', to: 10 }); // full raise, minRaise 8
    act(g, 'p0', { type: 'act', move: 'call' });
    assert.deepEqual(legal(g, 'p1'), { fold: true, check: false, call: 9, raise: true, minTo: 15, maxTo: 15, potTo: 15 });
    fails(g, 'p1', { type: 'act', move: 'raise', to: 14 }, 'bad_request', /only raise is all-in for 15/);
    act(g, 'p1', { type: 'act', move: 'raise', to: 15 }); // +5: short
    assert.deepEqual([hand(g).currentBet, hand(g).minRaise], [15, 8]);
    assert.deepEqual(ps(g, 'p1').lastAction, { type: 'allin', amount: 15 });
    assert.equal(lastLog(g).text, 'all-in');
    assert.deepEqual([ps(g, 'p3').raiseLocked, ps(g, 'p0').raiseLocked, ps(g, 'p2').raiseLocked], [true, true, false]);
    // the big blind hasn't acted yet, so may raise
    assert.deepEqual([legal(g, 'p2').raise, legal(g, 'p2').minTo], [true, 23]);
    act(g, 'p2', { type: 'act', move: 'call' });
    assert.equal(toAct(g), 'p3', 'players who acted must respond to the short raise');
    assert.deepEqual(legal(g, 'p3'), { fold: true, check: false, call: 5, raise: false, minTo: 0, maxTo: 0, potTo: 0 });
    fails(g, 'p3', { type: 'act', move: 'raise', to: 30 }, 'bad_request', /less than a full raise/);
    act(g, 'p3', { type: 'act', move: 'call' });
    assert.equal(legal(g, 'p0').raise, false);
    act(g, 'p0', { type: 'act', move: 'call' });
    assert.equal(hand(g).street, 'flop');
    assert.ok(hand(g).order.every((pid) => !ps(g, pid).raiseLocked), 'locks clear each street');
    assert.equal(toAct(g), 'p2', 'the all-in small blind is skipped');
    assert.equal(legal(g, 'p2').raise, true);
  });

  test('a full raise after a short all-in reopens the betting for everyone', () => {
    const g = newGame({ n: 4, stacks: [200, 15, 200, 200] });
    deal(g);
    act(g, 'p3', { type: 'act', move: 'raise', to: 10 });
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'raise', to: 15 });
    act(g, 'p2', { type: 'act', move: 'raise', to: 40 }); // +25 ≥ 8: full
    assert.equal(hand(g).minRaise, 25);
    assert.deepEqual([ps(g, 'p3').raiseLocked, ps(g, 'p3').acted, ps(g, 'p0').raiseLocked], [false, false, false]);
    assert.deepEqual([legal(g, 'p3').raise, legal(g, 'p3').minTo, legal(g, 'p3').call], [true, 65, 30]);
    act(g, 'p3', { type: 'act', move: 'raise', to: 65 });
    assert.equal(legal(g, 'p0').raise, true);
  });

  test('short all-ins that add up to a full raise do reopen the betting (TDA)', () => {
    const g = newGame({ n: 4, stacks: [15, 20, 200, 200] });
    deal(g); // UTG p3, then p0 (15), p1 (SB, 20), p2 (BB)
    act(g, 'p3', { type: 'act', move: 'raise', to: 10 }); // minRaise 8
    act(g, 'p0', { type: 'act', move: 'raise', to: 15 }); // +5 short
    assert.equal(ps(g, 'p3').raiseLocked, true);
    act(g, 'p1', { type: 'act', move: 'raise', to: 20 }); // +5 short, but p3 now faces +10 ≥ 8
    assert.equal(ps(g, 'p3').raiseLocked, false);
    act(g, 'p2', { type: 'act', move: 'call' });
    assert.deepEqual([legal(g, 'p3').raise, legal(g, 'p3').minTo], [true, 28]);
  });

  test('raising is impossible when nobody else can act; a short call goes all-in', () => {
    let g = newGame({ n: 2, stacks: [200, 50] });
    deal(g);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'raise', to: 50 }); // BB shoves
    assert.deepEqual(legal(g, 'p0'), { fold: true, check: false, call: 48, raise: false, minTo: 0, maxTo: 0, potTo: 0 });
    fails(g, 'p0', { type: 'act', move: 'raise', to: 150 }, 'bad_request', /Everyone else is all-in/);
    act(g, 'p0', { type: 'act', move: 'call' });
    assert.equal(hand(g).phase, 'ritVote');

    g = newGame({ n: 2, stacks: [30, 200] });
    deal(g);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'raise', to: 100 });
    assert.equal(legal(g, 'p0').call, 28);
    act(g, 'p0', { type: 'act', move: 'call' });
    assert.deepEqual(ps(g, 'p0').lastAction, { type: 'allin', amount: 30 });
    assert.ok(hand(g).log.some((e) => e.pid === 'p0' && e.text === 'calls all-in' && e.amount === 30));
    assert.equal(stack(g, 'p0'), 0);
    // the 70 nobody could call goes back to p1 at settlement
    rig(g, { p0: ['As', 'Ad'], p1: ['7c', '2d'] }, ['Kh', 'Qh', '9s', '5c', '3d']);
    runOut(g);
    assert.deepEqual(hand(g).results.awards, { p0: 60, p1: 70 });
  });

  test('PLO: four hole cards, pot-limit raises and Omaha (2 + 3) evaluation at showdown', () => {
    const g = newGame({ n: 3, settings: { variant: 'PLO' } });
    const h = deal(g);
    for (const pid of h.order) assert.equal(ps(g, pid).hole.length, 4);
    assert.equal(h.deck.length, 40);
    rig(
      g,
      { p0: ['Js', '3c', '4c', '5h'], p1: ['7c', '7h', '8c', '9c'], p2: ['2h', '2d', '3h', '3d'] },
      ['As', 'Ks', 'Qs', '2s', '7d'],
    );
    assert.deepEqual(legal(g, 'p0'), { fold: true, check: false, call: 2, raise: true, minTo: 4, maxTo: 7, potTo: 7 });
    fails(g, 'p0', { type: 'act', move: 'raise', to: 8 }, 'bad_request', /Pot limit/);
    act(g, 'p0', { type: 'act', move: 'raise', to: 7 }); // pot raise
    // SB: pot 10, 6 to call → potTo = 7 + 10 + 6 = 23
    assert.deepEqual(legal(g, 'p1'), { fold: true, check: false, call: 6, raise: true, minTo: 12, maxTo: 23, potTo: 23 });
    act(g, 'p1', { type: 'act', move: 'raise', to: 23 });
    // BB: pot 32, 21 to call → potTo = 23 + 32 + 21 = 76
    assert.deepEqual([legal(g, 'p2').potTo, legal(g, 'p2').maxTo, legal(g, 'p2').minTo], [76, 76, 39]);
    act(g, 'p2', { type: 'act', move: 'fold' });
    act(g, 'p0', { type: 'act', move: 'call' });
    assert.equal(hand(g).street, 'flop');
    assert.deepEqual([legal(g, 'p1').potTo, legal(g, 'p1').maxTo], [48, 48], 'opening pot bet = the pot');
    checkDown(g);
    const r = hand(g).results;
    // On a four-spade board p0's single spade is no flush in Omaha; p1's 7c7h + 7d As Ks is trips.
    assert.deepEqual(r.runs[0].winners, ['p1']);
    assert.equal(r.runs[0].handName, 'Three Sevens');
    assert.equal(evaluateFor('PLO', ps(g, 'p0').hole, hand(g).board).name, 'Ace high');
    assert.deepEqual(r.awards, { p1: 48 });
  });
});

// ─── endings, pots, settlement ───────────────────────────────────────────────

describe('settlement', () => {
  test('everyone folds: the last player takes the whole pot at once and nobody shows', () => {
    const g = newGame({ n: 3 });
    deal(g);
    act(g, 'p0', { type: 'act', move: 'raise', to: 6 });
    act(g, 'p1', { type: 'act', move: 'fold' });
    act(g, 'p2', { type: 'act', move: 'fold' });
    const h = hand(g);
    assert.equal(h.phase, 'complete');
    assert.equal(h.toAct, null);
    assert.deepEqual(h.results, {
      endedBy: 'fold',
      pots: [{ amount: 9, eligible: ['p0'], winnersByRun: [['p0']] }],
      awards: { p0: 9 },
      runs: [],
      winners: ['p0'],
    });
    assert.equal(ps(g, 'p0').won, 9);
    assert.deepEqual([stack(g, 'p0'), stack(g, 'p1'), stack(g, 'p2')], [203, 199, 198]);
    for (const pid of h.order) assert.ok(ps(g, pid).shown.every((s) => !s), 'no cards shown');
    assert.deepEqual([g.state.deadlineKind, g.state.deadline, h.completedAt], ['nextHand', g.ctx.now + 8000, g.ctx.now]);
    assert.deepEqual(lastLog(g), { street: 'preflop', pid: 'p0', text: 'wins', amount: 9 });
  });

  test('multi-way side pots with folded dead money', () => {
    const g = newGame({ n: 4, stacks: [500, 50, 150, 500], settings: { maxRuns: 1 } });
    deal(g); // button p0, SB p1, BB p2, UTG p3
    rig(g, { p0: ['2h', '3h'], p1: ['As', 'Ad'], p2: ['Ks', 'Kd'], p3: ['Qs', 'Qd'] }, ['2c', '7h', '9s', '3d', '4h']);
    act(g, 'p3', { type: 'act', move: 'raise', to: 20 });
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'raise', to: 50 });
    act(g, 'p2', { type: 'act', move: 'raise', to: 150 });
    act(g, 'p3', { type: 'act', move: 'call' });
    act(g, 'p0', { type: 'act', move: 'fold' });
    assert.equal(hand(g).phase, 'runout');
    runOut(g);
    const r = hand(g).results;
    assert.deepEqual(
      r.pots.map((p) => [p.amount, p.eligible, p.winnersByRun]),
      [
        [170, ['p1', 'p2', 'p3'], [['p1']]],
        [200, ['p2', 'p3'], [['p2']]],
      ],
    );
    assert.deepEqual(r.awards, { p1: 170, p2: 200 });
    assert.deepEqual([stack(g, 'p0'), stack(g, 'p1'), stack(g, 'p2'), stack(g, 'p3')], [480, 170, 200, 350]);
    assert.deepEqual(r.winners, ['p1', 'p2']);
  });

  test('chips a folded player put in above every remaining player go to the top pot', () => {
    const g = newGame({ n: 3, stacks: [200, 30, 50], settings: { maxRuns: 1 } });
    deal(g); // button p0, SB p1 (30), BB p2 (50)
    rig(g, { p0: ['2h', '3h'], p1: ['As', 'Ad'], p2: ['Ks', 'Kd'] }, ['2c', '7h', '9s', '3d', '4h']);
    act(g, 'p0', { type: 'act', move: 'raise', to: 100 });
    act(g, 'p0', { type: 'leave' }); // leaves out of turn: folded, 100 dead
    assert.deepEqual([ps(g, 'p0').folded, player(g, 'p0').seat, toAct(g)], [true, null, 'p1']);
    act(g, 'p1', { type: 'act', move: 'call' }); // all-in 30
    act(g, 'p2', { type: 'act', move: 'call' }); // all-in 50
    runOut(g);
    assert.deepEqual(
      E.buildPots(hand(g)).map((p) => [p.amount, p.eligible]),
      [
        [90, ['p1', 'p2']],
        [90, ['p2']],
      ],
    );
    assert.deepEqual(hand(g).results.awards, { p1: 90, p2: 90 });
  });

  test('split pot: equal shares, the odd chip goes to the winner closest left of the button', () => {
    const g = newGame({ n: 3 });
    deal(g); // button p0, SB p1, BB p2
    rig(g, { p0: ['2c', '3d'], p1: ['4c', '5d'], p2: ['2d', '3c'] }, ['As', 'Ks', 'Qs', 'Js', 'Ts']);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'fold' });
    checkDown(g);
    const r = hand(g).results;
    assert.deepEqual(r.runs[0].winners, ['p2', 'p0']);
    assert.equal(r.runs[0].handName, 'Royal flush');
    assert.deepEqual(r.awards, { p2: 3, p0: 2 }, 'pot of 5: p2 (left of the button) gets the odd chip');
  });

  test('showdown: winners and the last aggressor must show; other losers may muck', () => {
    const g = newGame({ n: 3 });
    deal(g);
    rig(g, { p0: ['Ah', 'Kh'], p1: ['2c', '7d'], p2: ['Qs', 'Qd'] }, ['3c', '8s', '9h', 'Td', '4s']);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'check' });
    for (let i = 0; i < 6; i++) act(g, toAct(g), { type: 'act', move: 'check' }); // flop and turn
    // the river: p1 and p2 check; p0 bets, both call
    assert.equal(hand(g).street, 'river');
    assert.equal(toAct(g), 'p1');
    act(g, 'p1', { type: 'act', move: 'check' });
    act(g, 'p2', { type: 'act', move: 'check' });
    act(g, 'p0', { type: 'act', move: 'raise', to: 10 });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'call' });
    const h = hand(g);
    assert.equal(h.phase, 'complete');
    assert.deepEqual(h.results.winners, ['p2']);
    assert.deepEqual(ps(g, 'p0').shown, [true, true], 'last aggressor shows');
    assert.deepEqual(ps(g, 'p2').shown, [true, true], 'winner shows');
    assert.deepEqual(ps(g, 'p1').shown, [false, false], 'a losing caller may muck');
    const shows = h.log.filter((e) => e.text === 'shows').map((e) => [e.pid, e.cards]);
    assert.deepEqual(shows, [
      ['p0', ['Ah', 'Kh']],
      ['p2', ['Qs', 'Qd']],
    ]);
    assert.equal(ps(g, 'p2').handName, 'Pair of Queens');
    assert.equal(ps(g, 'p1').handName, null);
  });

  test("showdown: without a bet the first player left of the button shows; 'show' reveals every hand", () => {
    let g = newGame({ n: 3 });
    deal(g);
    rig(g, { p0: ['Ah', 'Kh'], p1: ['2c', '7d'], p2: ['Qs', 'Qd'] }, ['3c', '8s', '9h', 'Td', '4s']);
    checkDown(g);
    assert.equal(hand(g).lastAggressor, null);
    assert.deepEqual(
      ['p0', 'p1', 'p2'].map((pid) => ps(g, pid).shown.every(Boolean)),
      [false, true, true],
      'p1 (first left of the button) and the winner p2',
    );

    g = newGame({ n: 3, settings: { showdownLosers: 'show' } });
    deal(g);
    checkDown(g);
    assert.ok(['p0', 'p1', 'p2'].every((pid) => ps(g, pid).shown.every(Boolean)));
  });

  test('show: once the hand is over anyone dealt in can show any of their cards, even a preflop fold', () => {
    const g = newGame({ n: 3 });
    E.addPlayer(g.state, { id: 'sp', name: 'Spec', tokenHash: 't' }, g.ctx);
    deal(g);
    fails(g, 'p0', { type: 'show', cards: [0] }, 'conflict', /once the hand is over/);
    act(g, 'p0', { type: 'act', move: 'fold' });
    act(g, 'p1', { type: 'act', move: 'fold' });
    const hole = ps(g, 'p0').hole;
    act(g, 'p0', { type: 'show', cards: [1] });
    assert.deepEqual(ps(g, 'p0').shown, [false, true]);
    assert.deepEqual(lastLog(g), { street: 'preflop', pid: 'p0', text: 'shows', amount: null, cards: [hole[1]] });
    const n = hand(g).log.length;
    act(g, 'p0', { type: 'show', cards: [1, 1] });
    assert.equal(hand(g).log.length, n, 'showing again is a no-op');
    act(g, 'p2', { type: 'show', cards: [0, 1] });
    assert.deepEqual(ps(g, 'p2').shown, [true, true]);
    fails(g, 'p0', { type: 'show', cards: [5] }, 'bad_request');
    fails(g, 'p0', { type: 'show', cards: [] }, 'bad_request');
    fails(g, 'p0', { type: 'show' }, 'bad_request');
    fails(g, 'sp', { type: 'show', cards: [0] }, 'forbidden');
    assert.equal(E.canShow(g.state, 'p0'), true);
    act(g, 'p0', { type: 'show', cards: [0] });
    assert.equal(E.canShow(g.state, 'p0'), false);
  });

  test('revealRunout shows exactly the cards that would have come, once', () => {
    const g = newGame({ n: 3 });
    E.addPlayer(g.state, { id: 'sp', name: 'Spec', tokenHash: 't' }, g.ctx);
    deal(g);
    rig(g, {}, ['2c', '3c', '4c', '5c', '6c', '7c']);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'check' });
    assert.deepEqual(hand(g).board, ['2c', '3c', '4c']);
    fails(g, 'p1', { type: 'revealRunout' }, 'conflict');
    act(g, 'p1', { type: 'act', move: 'raise', to: 2 });
    act(g, 'p2', { type: 'act', move: 'fold' });
    act(g, 'p0', { type: 'act', move: 'fold' });
    assert.equal(E.canRevealRunout(g.state, 'sp'), true, "'anyone' includes spectators");
    act(g, 'sp', { type: 'revealRunout' });
    assert.deepEqual(hand(g).runout, { cards: ['5c', '6c'], by: 'sp' });
    assert.deepEqual(lastLog(g).cards, ['5c', '6c']);
    assert.deepEqual(hand(g).board, ['2c', '3c', '4c'], 'nothing is dealt');
    fails(g, 'p1', { type: 'revealRunout' }, 'conflict', /already/);
    assert.equal(E.canRevealRunout(g.state, 'p1'), false);
    fire(g);
    assert.deepEqual(g.state.lastHand.runout, { cards: ['5c', '6c'], by: 'sp' });
  });

  test("revealRunout permissions follow the setting ('winner' / 'host' / 'off'); never after a showdown", () => {
    const setup = (mode) => {
      const g = newGame({ n: 3, settings: { revealRunout: mode } });
      deal(g);
      act(g, 'p0', { type: 'act', move: 'fold' });
      act(g, 'p1', { type: 'act', move: 'fold' }); // p2 wins preflop: 5 cards would have come
      return g;
    };
    let g = setup('winner');
    fails(g, 'p0', { type: 'revealRunout' }, 'forbidden', /winner/);
    act(g, 'p2', { type: 'revealRunout' });
    assert.equal(hand(g).runout.cards.length, 5);
    assert.deepEqual(hand(g).runout.cards, hand(g).deck.slice(0, 5));

    g = setup('host');
    fails(g, 'p2', { type: 'revealRunout' }, 'forbidden', /host/);
    act(g, 'p0', { type: 'revealRunout' });

    g = setup('off');
    fails(g, 'p0', { type: 'revealRunout' }, 'forbidden', /turned off/);
    assert.equal(E.canRevealRunout(g.state, 'p2'), false);

    g = newGame({ n: 2 });
    deal(g);
    checkDown(g);
    fails(g, 'p0', { type: 'revealRunout' }, 'conflict');
  });
});

// ─── all-in runouts / run it twice ───────────────────────────────────────────

describe('all-in runout', () => {
  function shoveAndCall(g, holes, deckTop) {
    deal(g);
    rig(g, holes, deckTop);
    act(g, 'p0', { type: 'act', move: 'raise', to: 200 });
    act(g, 'p1', { type: 'act', move: 'call' });
  }
  const HOLES = { p0: ['Ah', 'Ac'], p1: ['Kh', 'Kc'] };
  // run 1: 2s 7d 9c Th Ks → kings; run 2: 3s 8d Jc 4h Ad → aces; run 3: 5s 6s 2h 9d Qc → aces
  const DECK = ['2s', '7d', '9c', 'Th', 'Ks', '3s', '8d', 'Jc', '4h', 'Ad', '5s', '6s', '2h', '9d', 'Qc'];

  test('cards flip, the vote is unanimous for two runs, both run from one deck, the pot splits per run', () => {
    const g = newGame({ n: 2, settings: { maxRuns: 2 } });
    shoveAndCall(g, HOLES, DECK);
    const h = hand(g);
    assert.equal(h.phase, 'ritVote');
    assert.deepEqual(h.ritVoters, ['p1', 'p0']);
    assert.ok(h.order.every((pid) => ps(g, pid).shown.every(Boolean)), 'mandatory reveal');
    assert.deepEqual([g.state.deadlineKind, g.state.deadline], ['ritVote', g.ctx.now + 12000]);
    assert.equal(h.equity.run, 0);
    assert.ok(h.equity.by.p0 > 70 && h.equity.by.p0 < 92, `AA vs KK preflop ≈ 82%, got ${h.equity.by.p0}`);
    const sum = h.equity.by.p0 + h.equity.by.p1;
    assert.ok(sum >= 99 && sum <= 101);
    fails(g, 'p0', { type: 'vote', runs: 3 }, 'bad_request');
    fails(g, 'p0', { type: 'vote', runs: 0 }, 'bad_request');
    act(g, 'p0', { type: 'vote', runs: 2 });
    assert.equal(h.phase, 'ritVote');
    act(g, 'p1', { type: 'vote', runs: 2 });
    assert.deepEqual([h.phase, h.runs, h.currentRun], ['runout', 2, 0]);
    assert.deepEqual(h.runBoards, [[]]);
    assert.equal(lastLog(g).text, 'Running it twice');
    const t = g.ctx.now;
    assert.deepEqual([g.state.deadlineKind, g.state.deadline], ['runout', t + 1800]);

    const expect = [
      [0, ['2s', '7d', '9c']],
      [0, ['2s', '7d', '9c', 'Th']],
      [0, ['2s', '7d', '9c', 'Th', 'Ks']],
      [1, ['3s', '8d', 'Jc']],
      [1, ['3s', '8d', 'Jc', '4h']],
    ];
    expect.forEach(([run, board], i) => {
      fire(g);
      assert.equal(g.ctx.now, t + 1800 * (i + 1));
      assert.equal(h.currentRun, run);
      assert.deepEqual(h.runBoards[run], board);
      assert.equal(h.equity.run, run, 'equity follows the current run');
      assert.deepEqual([g.state.deadlineKind, g.state.deadline], ['runout', g.ctx.now + 1800]);
    });
    assert.deepEqual(h.runResults[0], { winners: ['p1'], handName: 'Three Kings' });
    // run 2 turn (3s 8d Jc 4h): KK needs the Kd — the Ks is dead on run 1's board → 1/39
    assert.deepEqual(h.equity.by, { p1: 3, p0: 97 });
    fire(g);
    assert.equal(h.phase, 'complete');
    assert.deepEqual(h.board, [], 'the shared board stays as it was when the money went in');
    assert.deepEqual(
      h.results.runs.map((r) => [r.board, r.winners, r.handName, r.amount]),
      [
        [['2s', '7d', '9c', 'Th', 'Ks'], ['p1'], 'Three Kings', 200],
        [['3s', '8d', 'Jc', '4h', 'Ad'], ['p0'], 'Three Aces', 200],
      ],
    );
    assert.deepEqual(h.results.pots[0].winnersByRun, [['p1'], ['p0']]);
    assert.deepEqual([stack(g, 'p0'), stack(g, 'p1')], [200, 200]);
    assert.equal(h.equity, null);
    assert.deepEqual([g.state.deadlineKind, g.state.deadline], ['nextHand', g.ctx.now + 8000 + 1500]);
  });

  test('three runs: the odd chip of the split goes to run one', () => {
    const g = newGame({ n: 2, settings: { maxRuns: 3 } });
    shoveAndCall(g, HOLES, DECK);
    act(g, 'p0', { type: 'vote', runs: 3 });
    act(g, 'p1', { type: 'vote', runs: 3 });
    runOut(g);
    const r = hand(g).results;
    assert.deepEqual(
      r.runs.map((x) => [x.winners, x.amount]),
      [
        [['p1'], 134],
        [['p0'], 133],
        [['p0'], 133],
      ],
    );
    assert.deepEqual(r.awards, { p1: 134, p0: 266 });
    assert.equal(g.state.deadline, hand(g).completedAt + 8000 + 3000);
  });

  test('a split vote, a missing vote or an away voter means running it once', () => {
    let g = newGame({ n: 2 });
    shoveAndCall(g, HOLES, DECK);
    act(g, 'p0', { type: 'vote', runs: 2 });
    act(g, 'p1', { type: 'vote', runs: 1 });
    assert.deepEqual([hand(g).phase, hand(g).runs], ['runout', 1]);
    assert.equal(lastLog(g).text, 'Running it once');

    g = newGame({ n: 2 });
    shoveAndCall(g, HOLES, DECK);
    act(g, 'p1', { type: 'vote', runs: 2 });
    act(g, 'p1', { type: 'vote', runs: 1 }); // may change their mind while the vote is open
    wait(g, 11999);
    assert.equal(hand(g).phase, 'ritVote');
    wait(g, 1);
    assert.deepEqual([hand(g).phase, hand(g).runs], ['runout', 1]);
    runOut(g);
    assert.deepEqual(hand(g).board, ['2s', '7d', '9c', 'Th', 'Ks'], 'a single run is the board');
    assert.deepEqual(hand(g).results.awards, { p1: 400 });

    g = newGame({ n: 2 });
    deal(g);
    act(g, 'p0', { type: 'act', move: 'raise', to: 200 });
    act(g, 'p1', { type: 'away', on: true }); // facing the shove: folds instantly
    assert.equal(hand(g).phase, 'complete');

    g = newGame({ n: 2 });
    shoveAndCall(g, HOLES, DECK);
    act(g, 'p1', { type: 'away', on: true });
    assert.equal(hand(g).ritVotes.p1, 1, 'away voters vote once');
    act(g, 'p0', { type: 'vote', runs: 2 });
    assert.deepEqual([hand(g).phase, hand(g).runs], ['runout', 1]);
    fails(g, 'p0', { type: 'vote', runs: 2 }, 'conflict');
  });

  test('maxRuns = 1 skips the vote', () => {
    const g = newGame({ n: 2, settings: { maxRuns: 1 } });
    shoveAndCall(g, HOLES, DECK);
    assert.deepEqual([hand(g).phase, hand(g).runs, g.state.deadlineKind], ['runout', 1, 'runout']);
    assert.ok(hand(g).equity && hand(g).equity.run === 0);
  });

  test('an all-in on the flop runs the turn and river; a call with chips behind still runs out', () => {
    const g = newGame({ n: 3, stacks: [200, 200, 60], settings: { maxRuns: 2 } });
    deal(g);
    rig(g, { p0: ['Ah', 'Ac'], p1: ['Kh', 'Kc'], p2: ['Qh', 'Qc'] }, ['2s', '7d', '9c', 'Th', 'Ks', 'Qd', '8d']);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'check' });
    act(g, 'p1', { type: 'act', move: 'check' });
    act(g, 'p2', { type: 'act', move: 'raise', to: 58 }); // all-in
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'fold' });
    const h = hand(g);
    assert.equal(h.phase, 'ritVote', 'p0 still has chips but nobody is left to bet against');
    assert.deepEqual(h.ritVoters, ['p2', 'p0']);
    assert.deepEqual(ps(g, 'p1').shown, [false, false], 'folded hands stay hidden');
    act(g, 'p2', { type: 'vote', runs: 2 });
    act(g, 'p0', { type: 'vote', runs: 2 });
    fire(g);
    assert.deepEqual(h.runBoards, [['2s', '7d', '9c', 'Th']]);
    fire(g);
    assert.deepEqual(h.runResults[0].winners, ['p0']);
    fire(g);
    assert.deepEqual(h.runBoards[1], ['2s', '7d', '9c', 'Qd'], 'run 2 starts from the shared flop');
    assert.ok(h.equity.run === 1);
    fire(g);
    assert.equal(h.phase, 'complete');
    assert.deepEqual(h.runBoards, [
      ['2s', '7d', '9c', 'Th', 'Ks'],
      ['2s', '7d', '9c', 'Qd', '8d'],
    ]);
    // pot: 2 (folded p1) + 60 + 60 = 122 → 61 per run; aces win run 1, a set of queens run 2
    assert.deepEqual(h.results.runs.map((r) => r.winners), [['p0'], ['p2']]);
    assert.deepEqual(h.results.awards, { p0: 61, p2: 61 });
  });

  test('tick() processes every elapsed deadline in order (a client that was away catches up)', () => {
    const g = newGame({ n: 2 });
    shoveAndCall(g, HOLES, DECK);
    act(g, 'p0', { type: 'vote', runs: 2 });
    act(g, 'p1', { type: 'vote', runs: 2 });
    const t = g.ctx.now;
    g.ctx.now = t + 12000;
    assert.equal(E.tick(g.state, g.ctx), true);
    check(g.state);
    const h = hand(g);
    assert.equal(h.phase, 'complete', 'all six runout steps happened in one tick');
    assert.equal(h.completedAt, t + 6 * 1800, 'each step happened when it was due');
    assert.equal(g.state.deadline, t + 6 * 1800 + 9500);
    assert.equal(E.tick(g.state, g.ctx), false, 'nothing more is due');
    // much later: the next hand is dealt at the real time, not in the past
    g.ctx.now = t + 600000;
    E.tick(g.state, g.ctx);
    check(g.state);
    assert.equal(g.state.hand.no, 2);
    assert.equal(g.state.hand.startedAt, g.ctx.now);
    assert.equal(g.state.deadline, g.ctx.now + 25000);
  });
});

// ─── equity rounding sanity across a showdown (independent of the deck) ──────

test('equity during the vote covers every live player and is rounded', () => {
  const g = newGame({ n: 3, stacks: [100, 100, 100] });
  deal(g);
  act(g, 'p0', { type: 'act', move: 'raise', to: 100 });
  act(g, 'p1', { type: 'act', move: 'call' });
  act(g, 'p2', { type: 'act', move: 'call' });
  const eq = hand(g).equity;
  assert.equal(eq.run, 0);
  assert.deepEqual(Object.keys(eq.by).sort(), ['p0', 'p1', 'p2']);
  for (const v of Object.values(eq.by)) assert.ok(Number.isInteger(v) && v >= 0 && v <= 100);
});

// ─── timeouts and away ───────────────────────────────────────────────────────

describe('timeouts and away', () => {
  test('a timeout checks when free, else folds; consecutive timeouts send the player away', () => {
    const g = newGame({ n: 3, settings: { autoAwayTimeouts: 2, actionTime: 20 } });
    deal(g);
    const t = g.ctx.now;
    assert.equal(g.state.deadline, t + 20000);
    assert.equal(wait(g, 19999), false);
    assert.equal(toAct(g), 'p0');
    wait(g, 1);
    assert.deepEqual([ps(g, 'p0').folded, player(g, 'p0').timeouts, player(g, 'p0').away], [true, 1, false]);
    assert.equal(hand(g).log.find((e) => e.pid === 'p0').text, 'folds (timed out)');
    assert.deepEqual([toAct(g), g.state.deadline], ['p1', t + 40000], 'the next clock starts when the timeout was due');
    act(g, 'p1', { type: 'act', move: 'call' });
    fire(g); // BB times out with nothing to call → check
    assert.deepEqual([ps(g, 'p2').lastAction, player(g, 'p2').timeouts], [null, 1]);
    assert.equal(hand(g).street, 'flop');
    assert.ok(hand(g).log.some((e) => e.pid === 'p2' && e.text === 'checks (timed out)'));
    act(g, 'p1', { type: 'act', move: 'check' });
    fire(g); // second timeout in a row
    assert.deepEqual([player(g, 'p2').away, player(g, 'p2').awayBy, player(g, 'p2').timeouts], [true, 'timeout', 2]);
    assert.equal(hand(g).street, 'turn');
    const before = g.state.deadline;
    act(g, 'p1', { type: 'act', move: 'raise', to: 10 });
    // p2 is away: folded instantly, no clock
    assert.equal(hand(g).phase, 'complete');
    assert.ok(g.ctx.now < before);
    assert.equal(lastLog(g).text, 'wins');
    assert.ok(hand(g).log.some((e) => e.pid === 'p2' && e.text === 'folds (away)'));
    const h2 = nextHand(g);
    assert.ok(!h2.ps.p2, 'away players sit out');
    assert.deepEqual([h2.button, h2.toAct], [1, 'p1']);
    assert.equal(player(g, 'p0').timeouts, 1);
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p0', { type: 'act', move: 'check' });
    assert.equal(player(g, 'p0').timeouts, 0, 'a voluntary action resets the counter');
  });

  test('autoAwayTimeouts = 0 never sends anyone away', () => {
    const g = newGame({ n: 2, settings: { autoAwayTimeouts: 0 } });
    for (let i = 0; i < 4; i++) {
      if (!g.state.hand || g.state.hand.phase === 'complete') fire(g);
      while (g.state.hand.phase === 'betting') fire(g);
    }
    assert.ok(player(g, 'p0').timeouts >= 2 && player(g, 'p1').timeouts >= 2);
    assert.equal(player(g, 'p0').away || player(g, 'p1').away, false);
  });

  test('away / back / away after this hand', () => {
    const g = newGame({ n: 3 });
    deal(g);
    act(g, 'p1', { type: 'away', on: true, afterHand: true });
    assert.deepEqual([player(g, 'p1').away, player(g, 'p1').awayAfterHand], [false, true]);
    foldOut(g);
    let h = nextHand(g);
    assert.deepEqual([player(g, 'p1').away, player(g, 'p1').awayBy, player(g, 'p1').awayAfterHand], [true, 'self', false]);
    assert.ok(!h.ps.p1);
    act(g, 'p1', { type: 'away', on: false });
    assert.deepEqual([player(g, 'p1').away, player(g, 'p1').awayBy, player(g, 'p1').waitForBB], [false, null, false]);
    act(g, 'p2', { type: 'away', on: true, afterHand: true });
    act(g, 'p2', { type: 'away', on: false }); // changed their mind
    assert.equal(player(g, 'p2').awayAfterHand, false);
    foldOut(g);
    h = nextHand(g);
    assert.ok(h.ps.p1 && h.ps.p2);
    // not in a hand: "after this hand" just means now
    E.addPlayer(g.state, { id: 'p3', name: 'P3', tokenHash: 't' }, g.ctx);
    act(g, 'p3', { type: 'sit', seat: 5, amount: 100 });
    act(g, 'p3', { type: 'away', on: true, afterHand: true });
    assert.equal(player(g, 'p3').away, true);
    fails(g, 'p0', { type: 'setAway', pid: 'nobody', on: true }, 'not_found');
  });

  test('host setAway / bring back', () => {
    const g = newGame({ n: 3 });
    deal(g);
    act(g, 'p0', { type: 'setAway', pid: 'p0', on: true }); // host's own turn → acted for at once
    assert.equal(ps(g, 'p0').folded, true);
    assert.equal(player(g, 'p0').awayBy, 'host');
    act(g, 'p0', { type: 'setAway', pid: 'p1', on: true });
    assert.deepEqual([player(g, 'p1').away, player(g, 'p1').awayBy], [true, 'host']);
    assert.equal(hand(g).phase, 'complete', 'p1 folded instantly, p2 wins');
    player(g, 'p1').timeouts = 3;
    act(g, 'p0', { type: 'setAway', pid: 'p1', on: false });
    assert.deepEqual([player(g, 'p1').away, player(g, 'p1').awayBy, player(g, 'p1').timeouts], [false, null, 0]);
  });
});

// ─── leaving ─────────────────────────────────────────────────────────────────

describe('leaving', () => {
  test('leave now outside a hand cashes out at once', () => {
    const g = newGame({ n: 2 });
    act(g, 'p1', { type: 'leave' });
    assert.deepEqual([player(g, 'p1').seat, stack(g, 'p1')], [null, 0]);
    const e = g.state.ledger[g.state.ledger.length - 1];
    assert.deepEqual([e.type, e.pid, e.amount, e.by], ['cashout', 'p1', 200, 'p1']);
    assert.equal(g.state.deadline, null, 'the pending deal is cancelled');
    fails(g, 'p1', { type: 'leave' }, 'conflict');
  });

  test('leave now during the betting folds out of turn; the player to act keeps the turn and clock', () => {
    const g = newGame({ n: 3 });
    deal(g);
    act(g, 'p0', { type: 'act', move: 'raise', to: 10 });
    const clock = g.state.deadline;
    assert.equal(toAct(g), 'p1');
    act(g, 'p2', { type: 'leave' }); // big blind leaves while p1 is thinking
    assert.deepEqual([ps(g, 'p2').folded, player(g, 'p2').seat], [true, null]);
    assert.equal(lastLog(g).text, 'folds (left the table)');
    const e = g.state.ledger[g.state.ledger.length - 1];
    assert.deepEqual([e.type, e.amount], ['cashout', 198]);
    assert.deepEqual([toAct(g), g.state.deadline], ['p1', clock]);
    act(g, 'p1', { type: 'act', move: 'fold' });
    assert.deepEqual(hand(g).results.awards, { p0: 13 });
  });

  test('leave on your turn folds and passes the action; leaving the last opponent ends the hand', () => {
    const g = newGame({ n: 2 });
    deal(g);
    act(g, 'p0', { type: 'leave' });
    assert.equal(hand(g).phase, 'complete');
    assert.deepEqual(hand(g).results.awards, { p1: 3 });
    assert.equal(stack(g, 'p1'), 201);
  });

  test('leave after the hand, cancelLeave, and all-in players are always deferred', () => {
    const g = newGame({ n: 3 });
    deal(g);
    act(g, 'p1', { type: 'leave', afterHand: true });
    assert.deepEqual([player(g, 'p1').leaveAfterHand, player(g, 'p1').seat, ps(g, 'p1').folded], [true, 1, false]);
    act(g, 'p1', { type: 'cancelLeave' });
    assert.equal(player(g, 'p1').leaveAfterHand, false);
    act(g, 'p1', { type: 'leave', afterHand: true });
    act(g, 'p0', { type: 'act', move: 'raise', to: 200 });
    act(g, 'p1', { type: 'act', move: 'fold' });
    act(g, 'p2', { type: 'act', move: 'call' }); // both all-in
    act(g, 'p2', { type: 'leave' }); // all-in: can't leave now
    assert.deepEqual([player(g, 'p2').leaveAfterHand, player(g, 'p2').seat], [true, 2]);
    runOut(g);
    const h = hand(g);
    fire(g); // hand ends → both leave
    assert.deepEqual([player(g, 'p1').seat, player(g, 'p2').seat], [null, null]);
    const cashouts = g.state.ledger.filter((e) => e.type === 'cashout').map((e) => [e.pid, e.amount]);
    assert.deepEqual(cashouts, [
      ['p1', 199],
      ['p2', h.ps.p2.won],
    ]);
    assert.equal(g.state.hand, null, 'one player left: no hand');
  });

  test('host remove: like leaving now, deferred to the end of the hand when all-in', () => {
    const g = newGame({ n: 3 });
    deal(g);
    act(g, 'p0', { type: 'remove', pid: 'p2' });
    assert.deepEqual([player(g, 'p2').seat, ps(g, 'p2').folded], [null, true]);
    assert.equal(lastLog(g).text, 'folds (removed by host)');
    const e = g.state.ledger[g.state.ledger.length - 1];
    assert.deepEqual([e.type, e.pid, e.amount, e.by, e.reason], ['cashout', 'p2', 198, 'p0', 'Removed by host']);
    fails(g, 'p0', { type: 'setAway', pid: 'p2', on: true }, 'conflict', /isn’t seated/);

    act(g, 'p0', { type: 'act', move: 'raise', to: 200 });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p0', { type: 'remove', pid: 'p1' }); // all-in → deferred
    assert.deepEqual([player(g, 'p1').leaveAfterHand, player(g, 'p1').seat], [true, 1]);
    fails(g, 'p1', { type: 'cancelLeave' }, 'forbidden', /host/);
    runOut(g);
    fire(g);
    assert.equal(player(g, 'p1').seat, null);
    const last = g.state.ledger.filter((x) => x.pid === 'p1').pop();
    assert.deepEqual([last.type, last.by], ['cashout', 'p0']);
  });
});

// ─── buy-ins ─────────────────────────────────────────────────────────────────

describe('buy-in requests', () => {
  function lobby() {
    const g = newGame({ n: 4, sit: false, settings: { approveBuyIns: true, minBuyIn: 100, maxBuyIn: 400 } });
    return g;
  }

  test('sit requests: validation, seat reservation, one per player, approve (with override) / deny / cancel', () => {
    const g = lobby();
    act(g, 'p0', { type: 'sit', seat: 0, amount: 300 }); // the host is auto-approved
    assert.deepEqual([player(g, 'p0').seat, stack(g, 'p0'), g.state.requests.length], [0, 300, 0]);
    fails(g, 'p1', { type: 'sit', seat: 2, amount: 50 }, 'bad_request', /between 100 and 400/);
    fails(g, 'p1', { type: 'sit', seat: 2, amount: 401 }, 'bad_request');
    fails(g, 'p1', { type: 'sit', seat: 8, amount: 200 }, 'bad_request');
    fails(g, 'p1', { type: 'sit', seat: 0, amount: 200 }, 'conflict', /taken/);
    act(g, 'p1', { type: 'sit', seat: 2, amount: 200 });
    assert.equal(g.state.requests.length, 1);
    const r1 = g.state.requests[0];
    assert.deepEqual([r1.pid, r1.kind, r1.amount, r1.seat, r1.createdAt], ['p1', 'sit', 200, 2, g.ctx.now]);
    assert.equal(player(g, 'p1').seat, null, 'pending until approved');
    fails(g, 'p1', { type: 'sit', seat: 3, amount: 200 }, 'conflict', /pending request/);
    fails(g, 'p2', { type: 'sit', seat: 2, amount: 200 }, 'conflict', /already asked/);
    act(g, 'p2', { type: 'sit', seat: 3, amount: 150 });
    act(g, 'p3', { type: 'sit', amount: 100 }); // any seat
    assert.equal(g.state.requests.length, 3);
    fails(g, 'p1', { type: 'approve', id: r1.id }, 'forbidden');
    fails(g, 'p0', { type: 'approve', id: 999 }, 'not_found');
    fails(g, 'p0', { type: 'approve', id: r1.id, amount: 0 }, 'bad_request');
    act(g, 'p0', { type: 'approve', id: r1.id, amount: 250 });
    assert.deepEqual([player(g, 'p1').seat, stack(g, 'p1')], [2, 250]);
    const buy = g.state.ledger[g.state.ledger.length - 1];
    assert.deepEqual([buy.type, buy.pid, buy.amount, buy.by, buy.countAsBuyIn], ['buyin', 'p1', 250, 'p0', true]);
    assert.equal(g.state.deadlineKind, 'nextHand', 'two seated players: a hand is coming');
    const r2 = g.state.requests.find((r) => r.pid === 'p2');
    act(g, 'p0', { type: 'deny', id: r2.id });
    assert.equal(player(g, 'p2').seat, null);
    const r3 = g.state.requests.find((r) => r.pid === 'p3');
    fails(g, 'p2', { type: 'cancelRequest', id: r3.id }, 'forbidden');
    act(g, 'p3', { type: 'cancelRequest', id: String(r3.id) });
    assert.equal(g.state.requests.length, 0);
  });

  test('approving takes the lowest free seat when the requested one is gone; a full table is a conflict', () => {
    const g = lobby();
    act(g, 'p0', { type: 'sit', seat: 0, amount: 300 });
    act(g, 'p1', { type: 'sit', seat: 7, amount: 200 });
    act(g, 'p0', { type: 'settings', patch: { seats: 6 } });
    act(g, 'p0', { type: 'approve', id: g.state.requests[0].id });
    assert.equal(player(g, 'p1').seat, 1);
    act(g, 'p0', { type: 'settings', patch: { seats: 2 } });
    fails(g, 'p2', { type: 'sit', amount: 200 }, 'conflict', /full/);
  });

  test('auto-approve: approveBuyIns off approves instantly; switching it off approves what is pending', () => {
    const g = lobby();
    act(g, 'p1', { type: 'sit', seat: 1, amount: 200 });
    act(g, 'p2', { type: 'sit', seat: 2, amount: 200 });
    act(g, 'p0', { type: 'settings', patch: { approveBuyIns: false } });
    assert.deepEqual([player(g, 'p1').seat, player(g, 'p2').seat, g.state.requests.length], [1, 2, 0]);
    const autos = g.state.ledger.filter((e) => e.type === 'buyin');
    assert.ok(autos.every((e) => e.by === null), 'auto-approved buy-ins have no approver');
    act(g, 'p3', { type: 'sit', seat: 3, amount: 100 });
    assert.equal(player(g, 'p3').seat, 3);
  });

  test('rebuys: capped at the max stack unless busted; deferred to the end of the hand when dealt in', () => {
    const g = lobby();
    act(g, 'p0', { type: 'sit', seat: 0, amount: 300 });
    act(g, 'p0', { type: 'settings', patch: { approveBuyIns: false } });
    act(g, 'p1', { type: 'sit', seat: 1, amount: 250 });
    act(g, 'p0', { type: 'settings', patch: { approveBuyIns: true } });
    fails(g, 'p2', { type: 'buyin', amount: 100 }, 'conflict', /seat/);
    fails(g, 'p1', { type: 'buyin', amount: 200 }, 'bad_request', /at most 150/);
    fails(g, 'p1', { type: 'buyin', amount: 0 }, 'bad_request');
    fails(g, 'p1', { type: 'buyin', amount: 2.5 }, 'bad_request');
    act(g, 'p1', { type: 'buyin', amount: 150 });
    act(g, 'p0', { type: 'approve', id: g.state.requests[0].id });
    assert.equal(stack(g, 'p1'), 400, 'no hand running: chips go straight to the stack');
    fails(g, 'p1', { type: 'buyin', amount: 1 }, 'bad_request', /maximum stack/);
    // busted
    act(g, 'p0', { type: 'adjust', pid: 'p1', mode: 'set', amount: 0, reason: '', countAsBuyIn: false });
    fails(g, 'p1', { type: 'buyin', amount: 50 }, 'bad_request', /between 100 and 400/);
    act(g, 'p1', { type: 'buyin', amount: 100 });
    act(g, 'p0', { type: 'approve', id: g.state.requests[0].id });
    assert.equal(stack(g, 'p1'), 100);
    // in a hand: pendingChips until it ends
    deal(g);
    act(g, 'p0', { type: 'buyin', amount: 50 }); // host: auto-approved
    assert.deepEqual([player(g, 'p0').pendingChips, g.state.requests.length], [50, 0]);
    const before = stack(g, 'p0');
    foldOut(g);
    const won = ps(g, 'p0').won;
    fire(g);
    assert.equal(holding(g, 'p0'), before + won + 50);
    assert.equal(player(g, 'p0').pendingChips, 0);
  });
});

// ─── host tools ──────────────────────────────────────────────────────────────

describe('host tools', () => {
  test('adjust: immediate outside a hand, queued in order while dealt in; ledger entries', () => {
    const g = newGame({ n: 3 });
    E.addPlayer(g.state, { id: 'sp', name: 'Spec', tokenHash: 't' }, g.ctx);
    act(g, 'p0', { type: 'adjust', pid: 'p1', mode: 'add', amount: 50, reason: ' Cash rebuy ', countAsBuyIn: true });
    assert.equal(stack(g, 'p1'), 250);
    let e = g.state.ledger[g.state.ledger.length - 1];
    assert.deepEqual(
      [e.type, e.pid, e.amount, e.countAsBuyIn, e.reason, e.by, e.name],
      ['adjust', 'p1', 50, true, 'Cash rebuy', 'p0', 'P1'],
    );
    act(g, 'p0', { type: 'adjust', pid: 'p2', mode: 'remove', amount: 1000, reason: 'Miscount fix', countAsBuyIn: false });
    assert.equal(stack(g, 'p2'), 0);
    assert.equal(g.state.ledger[g.state.ledger.length - 1].amount, -200, 'never below zero');
    act(g, 'p0', { type: 'adjust', pid: 'p2', mode: 'set', amount: 120, reason: 'Bounty', countAsBuyIn: false });
    assert.equal(stack(g, 'p2'), 120);
    assert.equal(g.state.ledger[g.state.ledger.length - 1].amount, 120);
    fails(g, 'p0', { type: 'adjust', pid: 'p2', mode: 'add', amount: 0, reason: '', countAsBuyIn: false }, 'bad_request');
    fails(g, 'p0', { type: 'adjust', pid: 'p2', mode: 'set', amount: -1, reason: '', countAsBuyIn: false }, 'bad_request');
    fails(g, 'p0', { type: 'adjust', pid: 'p2', mode: 'double', amount: 5, reason: '', countAsBuyIn: false }, 'bad_request');
    fails(g, 'p0', { type: 'adjust', pid: 'p2', mode: 'add', amount: 5, reason: 'x'.repeat(41), countAsBuyIn: false }, 'bad_request');
    fails(g, 'p0', { type: 'adjust', pid: 'sp', mode: 'add', amount: 5, reason: '', countAsBuyIn: false }, 'conflict');
    fails(g, 'p0', { type: 'adjust', pid: 'ghost', mode: 'add', amount: 5, reason: '', countAsBuyIn: false }, 'not_found');
    fails(g, 'p1', { type: 'adjust', pid: 'p2', mode: 'add', amount: 5, reason: '', countAsBuyIn: false }, 'forbidden');

    deal(g);
    const n = g.state.ledger.length;
    act(g, 'p0', { type: 'adjust', pid: 'p1', mode: 'set', amount: 300, reason: '', countAsBuyIn: false });
    act(g, 'p0', { type: 'adjust', pid: 'p1', mode: 'add', amount: 20, reason: '', countAsBuyIn: true });
    assert.equal(g.state.pendingAdjust.length, 2);
    assert.equal(g.state.ledger.length, n, 'nothing hits the ledger until the hand ends');
    foldOut(g);
    fire(g);
    assert.equal(holding(g, 'p1'), 320, '"set" uses the stack when the hand ends (249 → 300), then +20');
    assert.deepEqual(g.state.pendingAdjust, []);
    assert.deepEqual(
      g.state.ledger.slice(n).map((x) => [x.type, x.pid, x.amount, x.countAsBuyIn]),
      [
        ['adjust', 'p1', 51, false],
        ['adjust', 'p1', 20, true],
      ],
    );
  });

  test('pause: immediately with no hand, after the hand otherwise; unpausing deals again', () => {
    const g = newGame({ n: 2 });
    deal(g);
    act(g, 'p0', { type: 'pause', on: true });
    assert.deepEqual([g.state.paused, g.state.pauseAfterHand], [false, true]);
    foldOut(g);
    fire(g);
    assert.deepEqual([g.state.paused, g.state.pauseAfterHand, g.state.hand, g.state.deadline], [true, false, null, null]);
    act(g, 'p0', { type: 'pause', on: false });
    assert.deepEqual([g.state.paused, g.state.deadlineKind], [false, 'nextHand']);
    deal(g);
  });

  test('endGame: finishes the running hand, then cashes everyone out; ended rooms only allow chat / markPaid', () => {
    const g = newGame({ n: 3 });
    deal(g);
    act(g, 'p0', { type: 'endGame' });
    assert.deepEqual([g.state.endAfterHand, g.state.pauseAfterHand, g.state.ended], [true, true, false]);
    act(g, toAct(g), { type: 'act', move: 'fold' }); // the hand still plays out
    foldOut(g);
    fire(g);
    assert.deepEqual([g.state.ended, g.state.paused, g.state.endAfterHand, g.state.hand, g.state.deadline], [true, true, false, null, null]);
    for (const p of Object.values(g.state.players)) assert.deepEqual([p.seat, p.stack], [null, 0]);
    assert.equal(g.state.ledger.filter((e) => e.type === 'cashout').length, 3);
    const sum = summarize(g.state);
    assert.deepEqual([sum.totals.chipsOnTable, sum.totals.balanced], [0, true]);
    fails(g, 'p1', { type: 'sit', seat: 1, amount: 100 }, 'conflict', /ended/);
    fails(g, 'p0', { type: 'pause', on: false }, 'conflict', /ended/);
    act(g, 'p1', { type: 'chat', text: 'gg' });
    const row = sum.settlement[0];
    act(g, 'p0', { type: 'markPaid', key: row.key, paid: true });
    assert.equal(g.state.payments.length, 1);
    const ticked = summarize(g.state).settlement[0];
    assert.ok(ticked.paid && ticked.key.startsWith(row.key + '#'));
    act(g, 'p0', { type: 'markPaid', key: ticked.key, paid: false });
    assert.deepEqual(g.state.payments, []);
    fails(g, 'p0', { type: 'markPaid', key: 'p1>p0:12345', paid: true }, 'conflict', /settle-up list/);
  });

  test('endGame with no hand running (or a finished one) ends at once', () => {
    let g = newGame({ n: 2 });
    act(g, 'p0', { type: 'endGame' });
    assert.equal(g.state.ended, true);
    g = newGame({ n: 2 });
    deal(g);
    foldOut(g);
    act(g, 'p0', { type: 'endGame' });
    assert.deepEqual([g.state.ended, g.state.hand], [true, null]);
    assert.equal(g.state.lastHand.no, 1);
  });

  test('transferHost hands the host tools to another joined player', () => {
    const g = newGame({ n: 2 });
    fails(g, 'p0', { type: 'transferHost', pid: 'ghost' }, 'not_found');
    fails(g, 'p0', { type: 'transferHost', pid: 'p0' }, 'bad_request');
    act(g, 'p0', { type: 'transferHost', pid: 'p1' });
    assert.equal(g.state.hostId, 'p1');
    fails(g, 'p0', { type: 'pause', on: true }, 'forbidden');
    act(g, 'p1', { type: 'pause', on: true });
  });

  test('settings: sanitized, seats cannot shrink below an occupied seat, variant applies next hand', () => {
    const g = newGame({ n: 2, seats: [0, 5] });
    fails(g, 'p0', { type: 'settings', patch: { seats: 5 } }, 'bad_request', /Seat 6/);
    fails(g, 'p0', { type: 'settings', patch: { sb: 10, bb: 5 } }, 'bad_request');
    act(g, 'p0', { type: 'settings', patch: { seats: 6 } });
    assert.equal(g.state.settings.seats, 6);
    deal(g);
    act(g, 'p0', { type: 'settings', patch: { variant: 'PLO', sb: 5, bb: 10 } });
    assert.deepEqual([hand(g).variant, hand(g).bb, ps(g, 'p0').hole.length], ['NLH', 2, 2]);
    foldOut(g);
    const h = nextHand(g);
    assert.deepEqual([h.variant, h.sb, h.bb, h.ps.p0.hole.length], ['PLO', 5, 10, 4]);
  });

  test('chat: trimmed, 1..280 characters, last 60 kept, spectators welcome', () => {
    const g = newGame({ n: 2 });
    E.addPlayer(g.state, { id: 'sp', name: 'Spec', tokenHash: 't' }, g.ctx);
    act(g, 'sp', { type: 'chat', text: '  nice   hand  ' });
    assert.deepEqual(g.state.chat[0], { id: g.state.seq, t: g.ctx.now, pid: 'sp', name: 'Spec', text: 'nice hand' });
    fails(g, 'p1', { type: 'chat', text: '   ' }, 'bad_request');
    fails(g, 'p1', { type: 'chat', text: 'x'.repeat(281) }, 'bad_request');
    act(g, 'p1', { type: 'chat', text: 'x'.repeat(280) });
    for (let i = 0; i < 70; i++) act(g, 'p1', { type: 'chat', text: `m${i}` });
    assert.equal(g.state.chat.length, 60);
    assert.equal(g.state.chat[59].text, 'm69');
  });
});

// ─── the big one: random play keeps every invariant ──────────────────────────

describe('randomized play', () => {
  const pick = (r, arr) => arr[Math.floor(r() * arr.length)];

  function tryAct(g, pid, action) {
    const before = JSON.stringify(g.state);
    try {
      E.apply(g.state, pid, action, g.ctx);
    } catch (err) {
      if (!(err instanceof E.EngineError)) throw err;
      assert.equal(JSON.stringify(g.state), before, `rejected ${JSON.stringify(action)} must not mutate`);
      return false;
    }
    check(g.state);
    return true;
  }

  function sideAction(g, r) {
    const s = g.state;
    const pids = Object.keys(s.players);
    const pid = pick(r, pids);
    const p = s.players[pid];
    const x = r();
    if (x < 0.15) return tryAct(g, pid, { type: 'away', on: !p.away, afterHand: r() < 0.3, waitForBB: r() < 0.5 });
    if (x < 0.25) return tryAct(g, pid, { type: 'leave', afterHand: r() < 0.5 });
    if (x < 0.4) return tryAct(g, pid, { type: 'sit', seat: Math.floor(r() * s.settings.seats), amount: 20 + Math.floor(r() * 300) });
    if (x < 0.5) return tryAct(g, pid, { type: 'buyin', amount: 1 + Math.floor(r() * 300) });
    if (x < 0.6) {
      return tryAct(g, s.hostId, {
        type: 'adjust',
        pid,
        mode: pick(r, ['add', 'remove', 'set']),
        amount: Math.floor(r() * 200),
        reason: 'fuzz',
        countAsBuyIn: r() < 0.5,
      });
    }
    if (x < 0.66) return tryAct(g, pid, { type: 'show', cards: [0] });
    if (x < 0.7) return tryAct(g, pid, { type: 'revealRunout' });
    if (x < 0.74) return tryAct(g, s.hostId, { type: 'setAway', pid, on: r() < 0.5 });
    if (x < 0.77) return tryAct(g, s.hostId, { type: 'remove', pid });
    if (x < 0.8) return tryAct(g, pid, { type: 'cancelLeave' });
    if (x < 0.85 && s.requests.length) {
      const req = pick(r, s.requests);
      return tryAct(g, s.hostId, r() < 0.7 ? { type: 'approve', id: req.id } : { type: 'deny', id: req.id });
    }
    if (x < 0.88) return tryAct(g, s.hostId, { type: 'pause', on: r() < 0.3 });
    return tryAct(g, pid, { type: 'chat', text: 'gl' });
  }

  function revive(g, r) {
    // nothing scheduled and no hand: bring players back / give chips so play continues
    const s = g.state;
    if (s.paused) return tryAct(g, s.hostId, { type: 'pause', on: false });
    for (const p of Object.values(s.players)) {
      if (p.seat == null) tryAct(g, p.id, { type: 'sit', seat: Math.floor(r() * s.settings.seats), amount: 50 + Math.floor(r() * 200) });
      else if (p.away) tryAct(g, p.id, { type: 'away', on: false });
      else if (p.stack === 0) tryAct(g, p.id, { type: 'buyin', amount: 100 });
    }
    for (const req of s.requests.slice()) tryAct(g, s.hostId, { type: 'approve', id: req.id });
  }

  for (let seed = 1; seed <= 24; seed++) {
    test(`seed ${seed}`, () => {
      const r = mulberry32(seed * 7919);
      const n = 2 + (seed % 5);
      const g = newGame({
        n,
        seed,
        stacks: Array.from({ length: n }, () => 30 + Math.floor(r() * 300)),
        settings: {
          variant: seed % 3 === 0 ? 'PLO' : 'NLH',
          maxRuns: 1 + (seed % 3),
          approveBuyIns: seed % 2 === 0,
          showdownLosers: seed % 4 === 0 ? 'show' : 'choose',
          autoAwayTimeouts: seed % 5,
          seats: Math.max(n, 2 + (seed % 8)),
        },
      });
      let hands = 0;
      let lastNo = 0;
      for (let step = 0; step < 900; step++) {
        const s = g.state;
        if (r() < 0.05) {
          sideAction(g, r);
          continue;
        }
        const h = s.hand;
        if (h && h.no !== lastNo) {
          hands++;
          lastNo = h.no;
        }
        if (h && h.phase === 'betting') {
          const pid = h.toAct;
          const L = E.legalActions(s, pid);
          assert.ok(L, 'the player to act has legal moves');
          const x = r();
          if (x < 0.04) {
            fire(g); // let the clock run out
          } else if (x < 0.16) {
            act(g, pid, { type: 'act', move: 'fold' });
          } else if (x < 0.62 || !L.raise) {
            act(g, pid, { type: 'act', move: L.check ? 'check' : 'call' });
          } else {
            const to = r() < 0.2 ? L.maxTo : L.minTo + Math.floor(r() * (L.maxTo - L.minTo + 1));
            act(g, pid, { type: 'act', move: 'raise', to });
          }
        } else if (h && h.phase === 'ritVote') {
          const v = h.ritVoters.find((q) => h.ritVotes[q] == null);
          if (v && r() < 0.85) act(g, v, { type: 'vote', runs: 1 + Math.floor(r() * h.ritMaxRuns) });
          else fire(g);
        } else if (s.deadline != null) {
          fire(g);
        } else {
          revive(g, r);
        }
      }
      assert.ok(hands >= 10, `played a reasonable number of hands (${hands})`);
      // wrap up: end the game and check the books
      if (g.state.ended) return;
      act(g, g.state.hostId, { type: 'endGame' });
      for (let i = 0; i < 400 && !g.state.ended; i++) {
        const h = g.state.hand;
        if (h && h.phase === 'betting') act(g, h.toAct, { type: 'act', move: 'fold' });
        else fire(g);
      }
      assert.equal(g.state.ended, true);
      const sum = summarize(g.state);
      assert.equal(sum.totals.chipsOnTable, 0);
      assert.equal(sum.totals.diff, sum.totals.uncountedAdjust, 'books off only by uncounted adjustments');
      assert.equal(
        sum.players.reduce((a, p) => a + p.net, 0),
        sum.totals.uncountedAdjust,
      );
    });
  }
});

// ─── review regressions ──────────────────────────────────────────────────────

describe('review regressions', () => {
  test('a side pot fed by a folded player’s chips is WON (winner marked), only the unmatched part is an uncalled bet', () => {
    // p0 button 500, p1 SB 50, p2 BB 500. p0 raises to 50, p1 calls all-in, p2 raises to 200,
    // p0 calls. Flop: p2 bets 100, p0 folds → pots [150: p1/p2] and [400: p2 only].
    const g = newGame({ n: 3, stacks: [500, 50, 500], settings: { sb: 1, bb: 2, maxRuns: 1 } });
    const h = deal(g);
    assert.deepEqual([h.button, h.sbSeat, h.bbSeat, toAct(g)], [0, 1, 2, 'p0']);
    rig(g, { p0: ['7c', '2d'], p1: ['As', 'Ad'], p2: ['Kc', 'Qd'] }, ['3h', '8s', '9d', '4c', 'Jh']);
    act(g, 'p0', { type: 'act', move: 'raise', to: 50 });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'raise', to: 200 });
    act(g, 'p0', { type: 'act', move: 'call' });
    assert.equal(hand(g).street, 'flop');
    act(g, 'p2', { type: 'act', move: 'raise', to: 100 });
    act(g, 'p0', { type: 'act', move: 'fold' });
    runOut(g);
    const r = hand(g).results;
    assert.equal(r.endedBy, 'showdown');
    assert.deepEqual(r.pots.map((p) => [p.amount, p.eligible, !!p.returned, p.uncalled ?? null]), [
      [150, ['p1', 'p2'], false, null],
      [400, ['p2'], false, 100],
    ]);
    assert.deepEqual(r.awards, { p1: 150, p2: 400 });
    assert.deepEqual(r.winners, ['p1', 'p2'], 'p2 won 300 of that pot (150 of it p0’s) — a winner');
    const texts = hand(g).log.filter((e) => e.pid === 'p2' && e.amount).map((e) => [e.text, e.amount]);
    assert.deepEqual(texts.slice(-2), [
      ['gets back an uncalled bet', 100],
      ['wins the side pot', 300],
    ]);
  });

  test('a pot nobody else reached at all is still just an uncalled bet (not a win)', () => {
    const g = newGame({ n: 2, stacks: [3, 500], settings: { sb: 5, bb: 10, maxRuns: 1 } });
    deal(g);
    rig(g, { p0: ['2c', '7d'], p1: ['As', 'Ad'] }, ['Kh', 'Qh', '9s', '5c', '3d']);
    runOut(g);
    const r = hand(g).results;
    assert.deepEqual(r.pots.map((p) => [p.amount, !!p.returned, p.uncalled ?? null]), [
      [6, false, null],
      [7, true, 7],
    ]);
    assert.deepEqual(r.winners, ['p1']);
    assert.ok(!hand(g).log.some((e) => e.text === 'wins the side pot'));
  });

  test('host remove on a joined player without a seat removes them from the game (frees the cap and the name)', () => {
    const g = newGame({ n: 2 });
    E.addPlayer(g.state, { id: 'troll', name: 'Troll', tokenHash: 'th-troll' }, g.ctx);
    fails(g, 'p1', { type: 'remove', pid: 'troll' }, 'forbidden', /host/);
    fails(g, 'p0', { type: 'setAway', pid: 'troll', on: true }, 'conflict', /isn’t seated/);
    act(g, 'troll', { type: 'chat', text: 'spam' });
    act(g, 'troll', { type: 'sit', seat: 5, amount: 100 }); // approveBuyIns off in newGame → seated at once
    act(g, 'troll', { type: 'leave' }); // a ledger trail: buy-in + cash-out
    act(g, 'p0', { type: 'remove', pid: 'troll' });
    // referenced by the ledger → a tombstone that can't act and isn't listed
    assert.equal(player(g, 'troll').kicked, true);
    assert.equal(player(g, 'troll').tokenHash, null);
    fails(g, 'troll', { type: 'chat', text: 'still here?' }, 'forbidden', /Join/);
    fails(g, 'p0', { type: 'remove', pid: 'troll' }, 'not_found');
    fails(g, 'p0', { type: 'transferHost', pid: 'troll' }, 'not_found');
    assert.deepEqual(E.activePlayers(g.state).map((p) => p.id).sort(), ['p0', 'p1']);
    // a player nothing refers to is deleted outright
    E.addPlayer(g.state, { id: 'ghost', name: 'Ghost', tokenHash: 'th-ghost' }, g.ctx);
    act(g, 'ghost', { type: 'sit', seat: 6, amount: 100 });
    act(g, 'p0', { type: 'remove', pid: 'ghost' }); // seated → stood up (cash-out on the ledger)
    assert.equal(player(g, 'ghost').seat, null);
    E.addPlayer(g.state, { id: 'lurker', name: 'Lurker', tokenHash: 'th-lurk' }, g.ctx);
    act(g, 'p0', { type: 'remove', pid: 'lurker' });
    assert.equal(g.state.players.lurker, undefined);
    // the host can't remove themselves this way
    act(g, 'p0', { type: 'leave' });
    fails(g, 'p0', { type: 'remove', pid: 'p0' }, 'bad_request', /yourself/);
  });

  test('a pending seat request is dropped when its owner is removed; removed players free the 30-player cap', () => {
    const g = newGame({ n: 2, settings: { approveBuyIns: true } });
    for (let i = 0; i < 28; i++) E.addPlayer(g.state, { id: 'x' + i, name: 'X' + i, tokenHash: 'th' + i }, g.ctx);
    assert.throws(() => E.addPlayer(g.state, { id: 'late', name: 'Late', tokenHash: 'th-late' }, g.ctx), /full/);
    act(g, 'x0', { type: 'sit', seat: 4, amount: 100 });
    assert.equal(g.state.requests.filter((r) => r.pid === 'x0').length, 1);
    act(g, 'p0', { type: 'remove', pid: 'x0' });
    assert.equal(g.state.requests.filter((r) => r.pid === 'x0').length, 0);
    assert.equal(g.state.players.x0, undefined, 'nothing refers to x0, so they are gone');
    E.addPlayer(g.state, { id: 'late', name: 'Late', tokenHash: 'th-late' }, g.ctx); // a slot is free again
  });

  test('names: invisible characters are stripped, invisible-only names and "You" are refused, lookalikes share a key', () => {
    const ctx = { now: T0, rng: mulberry32(1) };
    const s = E.createRoom({ code: 'NAM-0001', hostName: 'Alice', hostId: 'h', hostTokenHash: 'x' }, ctx);
    assert.equal(E.addPlayer(s, { id: 'a', name: 'Ali‍ce⁠', tokenHash: 'y' }, ctx).name, 'Alice');
    for (const bad of ['ㅤ', '‌', 'ᅟᅠ', '⠀', '  ­ ']) {
      assert.throws(() => E.addPlayer(s, { id: 'b', name: bad, tokenHash: 'z' }, ctx), /required/, JSON.stringify(bad));
    }
    for (const bad of ['You', 'you', ' YOU ', 'Ｙｏｕ']) {
      assert.throws(() => E.addPlayer(s, { id: 'b', name: bad, tokenHash: 'z' }, ctx), /reserved/, bad);
    }
    assert.throws(() => E.createRoom({ code: 'NAM-0002', hostName: 'you', hostId: 'h', hostTokenHash: 'x' }, ctx), /reserved/);
    assert.equal(E.nameKey('ＡＬＩＣＥ'), E.nameKey('alice'));
    assert.equal(E.nameKey('Ali‍ce'), 'alice');
    assert.equal(E.addPlayer(s, { id: 'c', name: 'Young', tokenHash: 'w' }, ctx).name, 'Young');
  });

  test('markPaid records the payment: it survives later hands and is subtracted from what is still owed', () => {
    // Ana, Bo, Cy buy in for 200; Bo loses 100 to Ana and leaves; Bo pays Ana (ticked); then Cy wins 150 from Ana.
    const g = newGame({ n: 4, settings: { approveBuyIns: false } }); // p0 = host (Ana), p1 Bo, p2 Cy, p3 Dee
    act(g, 'p3', { type: 'leave' }); // just three
    const adjust = (pid, mode, amount) => act(g, 'p0', { type: 'adjust', pid, mode, amount, reason: 'test', countAsBuyIn: false });
    // move chips between players with uncounted adjustments that net to zero (stand-ins for hands)
    const move = (from, to, n) => {
      adjust(from, 'remove', n);
      adjust(to, 'add', n);
    };
    move('p1', 'p0', 100);
    act(g, 'p1', { type: 'leave' }); // Bo cashes out 100
    let L = summarize(g.state);
    const boToAna = L.settlement.find((s) => s.from === 'p1');
    assert.deepEqual([boToAna.to, boToAna.amount, boToAna.paid], ['p0', 100, false]);
    act(g, 'p0', { type: 'markPaid', key: boToAna.key, paid: true });
    move('p0', 'p2', 150);
    L = summarize(g.state);
    const rows = L.settlement.map((s) => [s.from, s.to, s.amount, s.paid]);
    assert.deepEqual(rows, [
      ['p1', 'p0', 100, true], // the payment Bo made stays recorded
      ['p0', 'p2', 150, false], // Ana received Bo's 100, so she now owes Cy 150
    ]);
    // unticking brings the debt back
    act(g, 'p0', { type: 'markPaid', key: L.settlement[0].key, paid: false });
    assert.deepEqual(summarize(g.state).settlement.map((s) => [s.from, s.to, s.amount, s.paid]), [
      ['p1', 'p2', 100, false],
      ['p0', 'p2', 50, false],
    ]);
  });
});
