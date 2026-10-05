// Tests for lib/view.js — the per-viewer redacted view (SPEC §10).
//
// The view is the only thing clients ever see, so these tests look at it from every seat: what each
// viewer may and may not see in every phase of a hand, the legal-move object, requests privacy,
// results, the archived last hand, and that the view is a detached copy of the state.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../lib/engine.js';
import { viewFor } from '../lib/view.js';
import { fullDeck } from '../lib/cards.js';

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
const CARD_RE = /^[2-9TJQKA][shdc]$/;

/** n seated players p0..p(n-1) at seats 0.., plus `spectators` joined-but-unseated players. */
function game({ n = 4, spectators = 1, stacks = null, settings = {}, seed = 3 } = {}) {
  const ctx = { now: T0, rng: mulberry32(seed) };
  const state = E.createRoom(
    {
      code: 'VEW-0001',
      name: 'View game',
      hostName: 'Host',
      hostId: 'p0',
      hostTokenHash: 'secret-hash-p0',
      settings: { approveBuyIns: false, minBuyIn: 1, maxBuyIn: 10000, maxRuns: 1, ...settings },
    },
    ctx,
  );
  for (let i = 1; i < n + spectators; i++) E.addPlayer(state, { id: `p${i}`, name: `Player ${i}`, tokenHash: `secret-hash-p${i}` }, ctx);
  const g = { state, ctx };
  for (let i = 0; i < n; i++) act(g, `p${i}`, { type: 'sit', seat: i, amount: stacks ? stacks[i] : 200 });
  return g;
}

const act = (g, pid, a) => E.apply(g.state, pid, a, g.ctx);
const view = (g, pid) => viewFor(g.state, pid, 42, g.ctx.now);
const viewers = (g) => [null, ...Object.keys(g.state.players)];

function fire(g) {
  g.ctx.now = Math.max(g.ctx.now, g.state.deadline);
  E.tick(g.state, g.ctx);
}

function deal(g) {
  fire(g);
  assert.ok(g.state.hand);
  return g.state.hand;
}

/** Fix hole cards and put `board` on top of the deck. */
function rig(g, holes, board = []) {
  const h = g.state.hand;
  const taken = new Set([...Object.values(holes).flat(), ...board, ...h.board]);
  const pool = fullDeck().filter((c) => !taken.has(c));
  for (const pid of h.order) h.ps[pid].hole = holes[pid] ? holes[pid].slice() : pool.splice(0, h.ps[pid].hole.length);
  h.deck = [...board, ...pool];
}

function playToShowdownChecking(g) {
  while (g.state.hand.phase === 'betting') {
    const pid = g.state.hand.toAct;
    const L = E.legalActions(g.state, pid);
    act(g, pid, { type: 'act', move: L.check ? 'check' : 'call' });
  }
}

/** Every card-looking string in `obj` with its path. */
function cardsIn(obj, path = 'view', out = []) {
  if (typeof obj === 'string') {
    if (CARD_RE.test(obj)) out.push([obj, path]);
  } else if (Array.isArray(obj)) obj.forEach((x, i) => cardsIn(x, `${path}[${i}]`, out));
  else if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) cardsIn(obj[k], `${path}.${k}`, out);
  return out;
}

/** The cards `viewer` must not see in the running hand. */
function hiddenFor(state, viewer) {
  const h = state.hand;
  const runout = new Set(h.runout ? h.runout.cards : []);
  const hidden = new Set(h.deck.filter((c) => !runout.has(c)));
  for (const pid of h.order) if (pid !== viewer) h.ps[pid].hole.forEach((c, i) => !h.ps[pid].shown[i] && hidden.add(c));
  return hidden;
}

function assertNoLeaks(g, label) {
  for (const viewer of viewers(g)) {
    const v = view(g, viewer);
    const json = JSON.stringify(v);
    assert.ok(!json.includes('secret-hash'), `${label}: token hash visible to ${viewer}`);
    assert.ok(!json.includes('tokenHash'), `${label}: tokenHash key visible to ${viewer}`);
    assert.ok(!json.includes('"deck"'), `${label}: deck visible to ${viewer}`);
    if (g.state.hand) {
      const hidden = hiddenFor(g.state, viewer);
      const { lastHand, ...rest } = v;
      for (const [c, path] of cardsIn(rest)) assert.ok(!hidden.has(c), `${label}: ${viewer} sees hidden ${c} at ${path}`);
    }
  }
}

describe('hole cards', () => {
  test('during the betting each player sees only their own cards; spectators and outsiders see none', () => {
    const g = game();
    const h = deal(g);
    for (const viewer of viewers(g)) {
      const v = view(g, viewer);
      assert.equal(v.hand.players.length, 4);
      for (const vp of v.hand.players) {
        const own = vp.pid === viewer;
        assert.equal(vp.cards.length, 2);
        assert.deepEqual(vp.cards, own ? h.ps[vp.pid].hole : [null, null]);
        assert.deepEqual(vp.shown, [false, false]);
        assert.equal(vp.handName, null, 'no hand names preflop');
      }
      if (viewer && h.ps[viewer]) assert.deepEqual(v.me.hole, h.ps[viewer].hole);
      else if (viewer) assert.equal(v.me.hole, null, 'a spectator has no hole cards');
    }
    assertNoLeaks(g, 'preflop');
  });

  test('PLO: four cards per player, still only your own', () => {
    const g = game({ settings: { variant: 'PLO' } });
    const h = deal(g);
    const v = view(g, 'p2');
    for (const vp of v.hand.players) assert.deepEqual(vp.cards, vp.pid === 'p2' ? h.ps.p2.hole : [null, null, null, null]);
    assertNoLeaks(g, 'PLO');
  });

  test('a folded player still sees their own cards; nobody else does', () => {
    const g = game();
    const h = deal(g);
    const folder = h.toAct;
    act(g, folder, { type: 'act', move: 'fold' });
    assert.deepEqual(view(g, folder).me.hole, h.ps[folder].hole);
    const other = h.order.find((p) => p !== folder);
    assert.deepEqual(view(g, other).hand.players.find((p) => p.pid === folder).cards, [null, null]);
    assertNoLeaks(g, 'after a fold');
  });

  test('a showdown shows only the mandatory hands; the mucked loser stays hidden', () => {
    const g = game({ n: 3, spectators: 0, settings: { showdownLosers: 'choose' } });
    deal(g); // button p0, SB p1, BB p2, p0 acts first
    rig(g, { p0: ['As', 'Ad'], p1: ['2c', '7d'], p2: ['Kc', 'Kd'] }, ['3h', '8s', '9c', 'Jd', '4s']);
    act(g, 'p0', { type: 'act', move: 'raise', to: 6 });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'call' });
    playToShowdownChecking(g);
    const h = g.state.hand;
    assert.equal(h.phase, 'complete');
    // p0 bet last (aggressor) and won; p1 and p2 lost and may muck
    const v = view(g, null);
    const byPid = Object.fromEntries(v.hand.players.map((p) => [p.pid, p]));
    assert.deepEqual(byPid.p0.cards, ['As', 'Ad']);
    assert.equal(byPid.p0.handName, 'Pair of Aces');
    assert.equal(byPid.p0.isWinner, true);
    assert.equal(byPid.p0.won, 18);
    assert.deepEqual(byPid.p1.cards, [null, null]);
    assert.deepEqual(byPid.p2.cards, [null, null]);
    assert.equal(byPid.p1.handName, null);
    assert.equal(byPid.p1.isWinner, false);
    // a loser sees their own hand name, everyone else does not
    assert.equal(view(g, 'p2').hand.players.find((p) => p.pid === 'p2').handName, 'Pair of Kings');
    assertNoLeaks(g, 'showdown');
    assert.equal(view(g, 'p2').hand.canShow, true);
    assert.equal(view(g, 'p0').hand.canShow, false, 'the winner already showed everything');
    assert.equal(view(g, null).hand.canShow, false);
    // p2 shows one card: that card (only) becomes public
    act(g, 'p2', { type: 'show', cards: [1] });
    const v2 = view(g, 'p1');
    assert.deepEqual(v2.hand.players.find((p) => p.pid === 'p2').cards, [null, 'Kd']);
    assert.equal(v2.hand.players.find((p) => p.pid === 'p2').handName, null, 'no hand name until every card is visible');
    assertNoLeaks(g, 'after showing one card');
  });
});

describe('legal moves', () => {
  test('only the player to act gets a legal-move object, with the spec’s numbers (NLH)', () => {
    const g = game({ n: 3, spectators: 1, stacks: [200, 200, 50] });
    deal(g); // button p0 (seat 0), SB p1, BB p2; p0 first to act
    for (const viewer of viewers(g)) {
      const L = view(g, viewer).hand.legal;
      if (viewer === 'p0') assert.deepEqual(L, { fold: true, check: false, call: 2, raise: true, minTo: 4, maxTo: 200, potTo: 7 });
      else assert.equal(L, null, `${viewer} gets no legal moves`);
    }
    act(g, 'p0', { type: 'act', move: 'raise', to: 10 });
    // SB: to call 9, min raise to 18, pot = 10 + 1 + 2 = 13 → pot-size raise to 10 + 13 + 9 = 32
    assert.deepEqual(view(g, 'p1').hand.legal, { fold: true, check: false, call: 9, raise: true, minTo: 18, maxTo: 200, potTo: 32 });
    act(g, 'p1', { type: 'act', move: 'call' });
    // BB with 48 behind: min raise 18 ≤ all-in 50; pot 10 + 10 + 2 → pot-size raise to 10 + 22 + 8 = 40
    assert.deepEqual(view(g, 'p2').hand.legal, { fold: true, check: false, call: 8, raise: true, minTo: 18, maxTo: 50, potTo: 40 });
  });

  test('PLO caps raises at the pot', () => {
    const g = game({ n: 3, spectators: 0, settings: { variant: 'PLO' } });
    deal(g);
    // p0 faces the BB of 2: pot after calling = 1 + 2 + 2 = 5 → max raise to 2 + 5 = 7
    assert.deepEqual(view(g, 'p0').hand.legal, { fold: true, check: false, call: 2, raise: true, minTo: 4, maxTo: 7, potTo: 7 });
  });

  test('an all-in for less than a full raise is the only raise; nobody left to act means no raise', () => {
    const g = game({ n: 2, spectators: 0, stacks: [3, 100] });
    deal(g); // heads-up: button p0 posts SB 1 (2 behind), p1 BB 2
    assert.deepEqual(view(g, 'p0').hand.legal, { fold: true, check: false, call: 1, raise: true, minTo: 3, maxTo: 3, potTo: 3 });
    act(g, 'p0', { type: 'act', move: 'raise', to: 3 });
    assert.deepEqual(view(g, 'p1').hand.legal, { fold: true, check: false, call: 1, raise: false, minTo: 0, maxTo: 0, potTo: 0 });
  });
});

describe('pot, board and hand names', () => {
  test('potTotal counts every chip committed; potCenter excludes the current street’s bets', () => {
    const g = game({ n: 3, spectators: 0 });
    deal(g);
    let v = view(g, null);
    assert.equal(v.hand.potTotal, 3);
    assert.equal(v.hand.potCenter, 0);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'check' });
    v = view(g, null);
    assert.equal(v.hand.street, 'flop');
    assert.equal(v.hand.board.length, 3);
    assert.equal(v.hand.potTotal, 6);
    assert.equal(v.hand.potCenter, 6);
    act(g, v.hand.toAct, { type: 'act', move: 'raise', to: 4 });
    v = view(g, null);
    assert.equal(v.hand.potTotal, 10);
    assert.equal(v.hand.potCenter, 6);
    assert.equal(v.hand.currentBet, 4);
  });

  test('me.handName appears from the flop, for my own cards (also after folding)', () => {
    const g = game({ n: 3, spectators: 0 });
    deal(g);
    rig(g, { p0: ['Qs', 'Qd'], p1: ['7c', '2d'], p2: ['9h', '9d'] }, ['Qc', '7s', '3d', 'Kh', 'Ac']);
    assert.equal(view(g, 'p0').me.handName, null);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'fold' });
    act(g, 'p2', { type: 'act', move: 'check' });
    assert.equal(view(g, 'p0').me.handName, 'Three Queens');
    assert.equal(view(g, 'p1').me.handName, 'Pair of Sevens', 'a folded player still sees their hand');
    assert.equal(view(g, null).me, null);
    assert.equal(view(g, 'p0').hand.players.find((p) => p.pid === 'p2').handName, null);
  });
});

describe('all-in runout', () => {
  test('the vote: voters, others’ votes, max runs, deadline; hands face down and no equity until it closes', () => {
    const g = game({ n: 3, spectators: 1, stacks: [100, 100, 100], settings: { maxRuns: 3 } });
    deal(g);
    rig(g, { p0: ['As', 'Ah'], p1: ['Kd', 'Kc'], p2: ['7h', '2c'] });
    act(g, 'p0', { type: 'act', move: 'raise', to: 100 });
    act(g, 'p1', { type: 'act', move: 'call' });
    act(g, 'p2', { type: 'act', move: 'fold' });
    const h = g.state.hand;
    assert.equal(h.phase, 'ritVote');
    act(g, 'p0', { type: 'vote', runs: 2 });
    const HOLE = { p0: ['As', 'Ah'], p1: ['Kd', 'Kc'], p2: ['7h', '2c'] };
    for (const viewer of viewers(g)) {
      const v = view(g, viewer);
      assert.deepEqual(v.hand.ritVote.voters, ['p1', 'p0'], 'voters in hand order (left of the button first)');
      assert.deepEqual(v.hand.ritVote.votes, { p0: 2, p1: null });
      assert.equal(v.hand.ritVote.maxRuns, 3);
      assert.equal(v.hand.ritVote.deadline, g.state.deadline);
      // while the players vote every hand is still face down: each viewer sees only their own
      for (const p of v.hand.players) {
        assert.deepEqual(p.cards, p.pid === viewer ? HOLE[p.pid] : [null, null], `${viewer} looking at ${p.pid}`);
        assert.deepEqual(p.shown, [false, false]);
        assert.equal(p.equity, null, 'no win chances during the vote — they would give the hands away');
      }
      assert.ok(!v.hand.log.some((e) => e.text === 'shows'), 'nobody "shows" yet');
      const json = JSON.stringify(v);
      for (const [pid, cards] of Object.entries(HOLE)) {
        if (pid !== viewer) for (const c of cards) assert.ok(!json.includes(`"${c}"`), `${viewer} can see ${pid}’s ${c} during the vote`);
      }
      assert.equal(v.hand.legal, null);
    }
    assertNoLeaks(g, 'vote');
    act(g, 'p1', { type: 'vote', runs: 2 });
    assert.equal(g.state.hand.phase, 'runout');
    // the vote is closed: the all-in hands flip for everyone (the folded one stays down) and win chances appear
    for (const viewer of viewers(g)) {
      const v = view(g, viewer);
      const byPid = Object.fromEntries(v.hand.players.map((p) => [p.pid, p]));
      assert.deepEqual(byPid.p0.cards, ['As', 'Ah']);
      assert.deepEqual(byPid.p1.cards, ['Kd', 'Kc']);
      assert.deepEqual([byPid.p0.shown, byPid.p1.shown], [[true, true], [true, true]]);
      assert.deepEqual(byPid.p2.cards, viewer === 'p2' ? ['7h', '2c'] : [null, null]);
      assert.ok(Number.isInteger(byPid.p0.equity) && byPid.p0.equity > 70, 'aces are a big favourite');
      assert.equal(byPid.p0.equity + byPid.p1.equity >= 98, true);
      assert.equal(byPid.p2.equity, null, 'no equity for a folded player');
      const tail = v.hand.log.slice(-3).map((e) => [e.text, e.name, e.cards]);
      assert.deepEqual(tail, [
        ['Running it twice', null, undefined],
        ['shows', byPid.p1.name, ['Kd', 'Kc']],
        ['shows', byPid.p0.name, ['As', 'Ah']],
      ]);
    }
    while (g.state.hand.phase === 'runout') {
      assertNoLeaks(g, 'runout');
      const v = view(g, null);
      assert.equal(v.hand.runs, 2);
      assert.equal(v.hand.runBoards.length, v.hand.currentRun + 1);
      fire(g);
    }
    const v = view(g, 'p3');
    assert.equal(v.hand.phase, 'complete');
    assert.equal(v.hand.results.runs.length, 2);
    assert.equal(v.hand.results.endedBy, 'showdown');
    assert.equal(Object.values(v.hand.results.awards).reduce((a, b) => a + b, 0), 202);
    for (const p of v.hand.players) assert.equal(p.equity, null, 'equity only during the runout');
  });
});

describe('fold endings and revealing the runout', () => {
  test('nobody’s cards are shown; the runout reveal is public and named; permissions per viewer', () => {
    const g = game({ n: 3, spectators: 1, settings: { revealRunout: 'winner' } });
    deal(g);
    act(g, 'p0', { type: 'act', move: 'raise', to: 6 });
    act(g, 'p1', { type: 'act', move: 'fold' });
    act(g, 'p2', { type: 'act', move: 'fold' });
    const h = g.state.hand;
    assert.equal(h.phase, 'complete');
    for (const viewer of viewers(g)) {
      const v = view(g, viewer);
      assert.equal(v.hand.results.endedBy, 'fold');
      assert.deepEqual(v.hand.results.awards, { p0: 9 });
      assert.equal(v.hand.canRevealRunout, viewer === 'p0', 'only the winner may reveal');
      for (const p of v.hand.players) if (p.pid !== viewer) assert.deepEqual(p.cards, [null, null]);
    }
    assertNoLeaks(g, 'fold ending');
    const next5 = h.deck.slice(0, 5);
    act(g, 'p0', { type: 'revealRunout' });
    for (const viewer of viewers(g)) {
      const v = view(g, viewer);
      assert.deepEqual(v.hand.runout, { cards: next5, by: 'p0', name: 'Host' });
      assert.equal(v.hand.canRevealRunout, false);
    }
    assertNoLeaks(g, 'after the runout reveal');
  });
});

describe('the archived last hand', () => {
  test('lastHand keeps only cards that were shown, plus boards and results', () => {
    const g = game({ n: 3, spectators: 0 });
    deal(g);
    rig(g, { p0: ['As', 'Ad'], p1: ['2c', '7d'], p2: ['Kc', 'Kd'] }, ['3h', '8s', '9c', 'Jd', '4s']);
    act(g, 'p0', { type: 'act', move: 'call' });
    act(g, 'p1', { type: 'act', move: 'fold' });
    act(g, 'p2', { type: 'act', move: 'check' });
    playToShowdownChecking(g);
    // no bets after the flop: the first live player left of the button (p2) must show; p0 wins and shows
    fire(g); // next hand
    const lh = view(g, 'p1').lastHand;
    assert.equal(lh.no, 1);
    assert.deepEqual(lh.boards, [['3h', '8s', '9c', 'Jd', '4s']]);
    const byPid = Object.fromEntries(lh.players.map((p) => [p.pid, p]));
    assert.deepEqual(byPid.p0.cards, ['As', 'Ad']);
    assert.deepEqual(byPid.p2.cards, ['Kc', 'Kd']);
    assert.deepEqual(byPid.p1.cards, [null, null], 'the folded hand is not archived');
    assert.equal(byPid.p1.folded, true);
    assert.equal(lh.results.endedBy, 'showdown');
    for (const viewer of viewers(g)) {
      const v = view(g, viewer);
      for (const [c] of cardsIn(v.lastHand)) assert.ok(!['2c', '7d'].includes(c), 'mucked cards never reach the archive');
    }
  });
});

describe('players, seats, requests', () => {
  test('requests are private to their owner and the host; seats show reservations', () => {
    const g = game({ n: 2, spectators: 2 });
    act(g, 'p0', { type: 'settings', patch: { approveBuyIns: true } });
    act(g, 'p2', { type: 'sit', seat: 5, amount: 100 });
    act(g, 'p3', { type: 'sit', seat: 6, amount: 150 });
    const host = view(g, 'p0');
    assert.deepEqual(host.requests.map((r) => r.pid).sort(), ['p2', 'p3']);
    const p2 = view(g, 'p2');
    assert.deepEqual(p2.requests.map((r) => r.pid), ['p2']);
    assert.equal(p2.me.request.amount, 100);
    assert.equal(p2.me.request.seat, 5);
    assert.equal(p2.me.request.name, 'Player 2');
    assert.deepEqual(view(g, 'p1').requests, []);
    assert.deepEqual(view(g, null).requests, []);
    const seats = view(g, null).seats;
    assert.equal(seats.length, 8);
    assert.deepEqual(seats[5], { seat: 5, pid: null, reservedBy: 'p2' });
    assert.deepEqual(seats[0], { seat: 0, pid: 'p0', reservedBy: null });
  });

  test('public player fields, statuses, busted and in-hand flags', () => {
    const g = game({ n: 3, spectators: 1, stacks: [200, 200, 1] });
    deal(g);
    const v = view(g, null);
    const byId = Object.fromEntries(v.players.map((p) => [p.id, p]));
    assert.deepEqual(Object.keys(byId.p0).sort(), ['away', 'awayBy', 'busted', 'id', 'inHand', 'isHost', 'leaveAfterHand', 'name', 'pendingChips', 'seat', 'stack', 'status'].sort());
    assert.equal(byId.p0.isHost, true);
    assert.equal(byId.p3.status, 'spectator');
    assert.equal(byId.p3.inHand, false);
    assert.equal(byId.p1.inHand, true);
    // p2 posted 1 chip as the big blind and is all-in: not busted while still contesting the pot
    assert.equal(byId.p2.stack, 0);
    assert.equal(byId.p2.busted, false);
    assert.deepEqual(v.players.map((p) => p.seat), [0, 1, 2, null], 'sorted by seat, spectators last');
    const me = view(g, 'p1').me;
    assert.equal(me.status, 'seated');
    assert.equal(me.inHand, true);
    assert.equal(me.timeouts, 0);
  });

  test('the view is a detached copy: mutating it never touches the state', () => {
    const g = game({ n: 3, spectators: 0 });
    deal(g);
    const before = JSON.stringify(g.state);
    const v = view(g, 'p0');
    v.settings.sb = 999;
    v.hand.board.push('XX');
    v.hand.players[0].cards[0] = 'XX';
    v.me.hole.push('XX');
    v.players[0].stack = -1;
    v.ledger.players.length = 0;
    v.chat.push({});
    assert.equal(JSON.stringify(g.state), before);
  });

  test('version, serverNow, deadline and flags come straight through', () => {
    const g = game({ n: 2, spectators: 0 });
    const v = viewFor(g.state, 'p1', 17, 12345);
    assert.equal(v.version, 17);
    assert.equal(v.serverNow, 12345);
    assert.equal(v.deadline, g.state.deadline);
    assert.equal(v.deadlineKind, 'nextHand');
    assert.equal(v.isHost, false);
    assert.equal(v.hand, null);
    assert.equal(v.code, 'VEW-0001');
    assert.equal(v.paused, false);
    assert.equal(v.ended, false);
    assert.equal(v.endAfterHand, false);
  });

  test('an ended game: everyone cashed out, a read-only ledger remains', () => {
    const g = game({ n: 3, spectators: 0 });
    act(g, 'p0', { type: 'endGame' });
    const v = view(g, 'p1');
    assert.equal(v.ended, true);
    assert.equal(v.hand, null);
    assert.equal(v.deadline, null);
    assert.ok(v.players.every((p) => p.seat === null && p.stack === 0));
    assert.equal(v.ledger.totals.cashedOut, 600);
    assert.equal(v.ledger.totals.balanced, true);
  });
});

test('random play: no viewer ever sees a hidden card in any phase (property)', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const R = mulberry32(seed * 977);
    const n = 2 + Math.floor(R() * 8);
    const g = game({
      n,
      spectators: 1,
      seed,
      stacks: Array.from({ length: n }, () => 1 + Math.floor(R() * 150)),
      settings: { seats: 9, variant: R() < 0.5 ? 'NLH' : 'PLO', maxRuns: 1 + Math.floor(R() * 3) },
    });
    for (let k = 0; k < 400 && g.state.deadline != null && (g.state.handNo < 12 || g.state.hand); k++) {
      const h = g.state.hand;
      assertNoLeaks(g, `seed ${seed} hand ${g.state.handNo}`);
      if (h && h.phase === 'betting') {
        const L = E.legalActions(g.state, h.toAct);
        const x = R();
        const a = x < 0.2 ? { move: 'fold' } : x < 0.7 || !L.raise ? { move: L.check ? 'check' : 'call' } : { move: 'raise', to: L.maxTo };
        act(g, h.toAct, { type: 'act', ...a });
      } else if (h && h.phase === 'ritVote' && R() < 0.5) {
        act(g, h.ritVoters[Math.floor(R() * h.ritVoters.length)], { type: 'vote', runs: 2 });
      } else if (h && h.phase === 'complete' && R() < 0.3) {
        act(g, h.order[Math.floor(R() * h.order.length)], { type: 'show', cards: [0] });
      } else {
        fire(g);
      }
    }
    assert.ok(g.state.handNo >= 1);
  }
});

describe('review regressions', () => {
  test('me.removedByHost: true only when the host (not the player) deferred their leave', () => {
    const g = game({ n: 3, spectators: 0, stacks: [200, 30, 200] });
    deal(g);
    // play until p1 is all-in
    for (let i = 0; i < 10 && !g.state.hand.ps.p1.allIn; i++) {
      const pid = g.state.hand.toAct;
      const L = E.legalActions(g.state, pid);
      if (pid === 'p1') act(g, pid, { type: 'act', move: 'raise', to: L.maxTo });
      else act(g, pid, { type: 'act', move: L.check ? 'check' : 'call' });
    }
    assert.ok(g.state.hand.ps.p1.allIn);
    act(g, 'p2', { type: 'leave', afterHand: true });
    assert.equal(view(g, 'p2').me.removedByHost, false, 'a self-leave can be cancelled');
    act(g, 'p0', { type: 'remove', pid: 'p1' });
    const me = view(g, 'p1').me;
    assert.deepEqual([me.leaveAfterHand, me.removedByHost], [true, true]);
    assert.throws(() => act(g, 'p1', { type: 'cancelLeave' }), /host/);
  });

  test('players the host removed from the game are not in anyone’s view, and can’t view as themselves', () => {
    const g = game({ n: 2, spectators: 1 });
    act(g, 'p2', { type: 'chat', text: 'hello' });
    act(g, 'p2', { type: 'sit', seat: 5, amount: 50 });
    act(g, 'p2', { type: 'leave' });
    act(g, 'p0', { type: 'remove', pid: 'p2' });
    assert.equal(g.state.players.p2.kicked, true);
    for (const v of [view(g, 'p0'), view(g, null)]) assert.ok(!v.players.some((p) => p.id === 'p2'));
    assert.equal(view(g, 'p2').me, null);
    // their ledger rows keep their name
    assert.ok(view(g, 'p0').ledger.players.some((r) => r.pid === 'p2' && r.name === 'Player 2'));
  });
});
