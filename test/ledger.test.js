// Tests for lib/ledger.js — ledger summary and settle-up (SPEC §7).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../lib/engine.js';
import { summarize, settle } from '../lib/ledger.js';

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

/** A bare state (only what summarize reads) with players { pid: [name, seat, stack, pendingChips] }. */
function bare(players, ledger = [], extra = {}) {
  const ps = {};
  for (const [id, [name, seat, stack, pendingChips = 0]] of Object.entries(players)) ps[id] = { id, name, seat, stack, pendingChips };
  let id = 0;
  return { players: ps, ledger: ledger.map((e) => ({ id: ++id, t: T0 + id, countAsBuyIn: false, reason: null, by: null, ...e })), paid: {}, hand: null, handNo: 0, ...extra };
}

const buyin = (pid, amount, name) => ({ type: 'buyin', pid, name: name || pid, amount, countAsBuyIn: true });
const cashout = (pid, amount, name) => ({ type: 'cashout', pid, name: name || pid, amount });
const adjust = (pid, amount, countAsBuyIn, by = 'h') => ({ type: 'adjust', pid, name: pid, amount, countAsBuyIn, by });

const row = (L, pid) => L.players.find((r) => r.pid === pid);

describe('summarize', () => {
  test('an empty room balances with no payments', () => {
    const L = summarize(bare({ h: ['Host', null, 0] }));
    assert.deepEqual(L.entries, []);
    assert.deepEqual(L.players, []);
    assert.equal(L.totals.buyIns, 0);
    assert.equal(L.totals.chipsOnTable, 0);
    assert.equal(L.totals.diff, 0);
    assert.equal(L.totals.balanced, true);
    assert.deepEqual(L.settlement, []);
  });

  test('buy-ins, rebuys and cash-outs → per-player rows, totals, net, sorted biggest winner first', () => {
    const st = bare(
      { a: ['Ann', 0, 50], b: ['Bob', 1, 0], c: ['Cat', null, 0] },
      [buyin('a', 200, 'Ann'), buyin('b', 200, 'Bob'), buyin('c', 100, 'Cat'), buyin('b', 100, 'Bob'), cashout('c', 250, 'Cat')],
      { handNo: 12 },
    );
    // Ann 200 → 50 (−150), Bob 300 → 0 (−300), Cat 100 → cashed 250 (+150): the books are 300 short
    const L = summarize(st);
    assert.deepEqual(
      L.players.map((r) => [r.pid, r.buyIns, r.buyInCount, r.cashOuts, r.stack, r.net]),
      [
        ['c', 100, 1, 250, 0, 150],
        ['a', 200, 1, 0, 50, -150],
        ['b', 300, 2, 0, 0, -300],
      ],
    );
    assert.equal(L.totals.buyIns, 600);
    assert.equal(L.totals.buyInCount, 4);
    assert.equal(L.totals.cashedOut, 250);
    assert.equal(L.totals.chipsOnTable, 50);
    assert.equal(L.totals.diff, -300);
    assert.equal(L.totals.balanced, false);
    assert.equal(L.totals.hands, 12);
    assert.deepEqual(L.totals.biggestWinner, { pid: 'c', name: 'Cat', net: 150 });
    assert.equal(row(L, 'c').seated, false);
    assert.equal(row(L, 'a').seat, 0);
  });

  test('adjustments: counted ones are buy-ins, uncounted ones show up as the books’ difference', () => {
    const st = bare({ a: ['Ann', 0, 260], b: ['Bob', 1, 90] }, [buyin('a', 200), buyin('b', 100), adjust('a', 50, true), adjust('a', 10, false), adjust('b', -10, true)]);
    const L = summarize(st);
    assert.equal(row(L, 'a').buyIns, 250);
    assert.equal(row(L, 'a').buyInCount, 2, 'a positive counted adjustment counts as a buy-in');
    assert.equal(row(L, 'a').adjustments, 60);
    assert.equal(row(L, 'b').buyIns, 90);
    assert.equal(row(L, 'b').buyInCount, 1, 'a negative counted adjustment is not a buy-in');
    assert.equal(L.totals.buyIns, 340);
    assert.equal(L.totals.uncountedAdjust, 10);
    assert.equal(L.totals.chipsOnTable, 350);
    assert.equal(L.totals.diff, 10, 'diff = chips on table + cashed out − buy-ins');
    assert.equal(L.totals.balanced, false);
  });

  test('a running hand: committed chips and pending chips are on the table; a finished hand is not double-counted', () => {
    const st = bare({ a: ['Ann', 0, 170, 50], b: ['Bob', 1, 180] }, [buyin('a', 200), buyin('a', 50), buyin('b', 200)]);
    st.hand = { phase: 'betting', order: ['a', 'b'], ps: { a: { seat: 0, committed: 30 }, b: { seat: 1, committed: 20 } } };
    let L = summarize(st);
    assert.equal(row(L, 'a').stack, 250);
    assert.equal(row(L, 'b').stack, 200);
    assert.equal(L.totals.chipsOnTable, 450);
    assert.equal(L.totals.balanced, true);
    // the hand settles: the 50-chip pot goes to Ann and is in her stack now
    st.hand.phase = 'complete';
    st.players.a.stack = 220;
    L = summarize(st);
    assert.equal(row(L, 'a').stack, 270);
    assert.equal(row(L, 'b').stack, 180);
    assert.equal(L.totals.balanced, true);
  });

  test('pot chips of a player who already left stay on the table (books balance mid-hand)', () => {
    const st = bare({ a: ['Ann', 0, 180], b: ['Bob', null, 0] }, [buyin('a', 200), buyin('b', 200), cashout('b', 160)]);
    st.hand = { phase: 'turn', order: ['a', 'b'], ps: { a: { seat: 0, committed: 20 }, b: { seat: 1, committed: 40 } } };
    const L = summarize(st);
    assert.equal(row(L, 'b').stack, 0);
    assert.equal(row(L, 'b').net, -40);
    assert.equal(L.totals.chipsOnTable, 240);
    assert.equal(L.totals.balanced, true);
  });

  test('entries: newest first, capped at 200, with byName', () => {
    const ledger = [];
    for (let i = 0; i < 230; i++) ledger.push(i % 2 ? buyin('a', 1) : adjust('a', 1, false, 'h'));
    const st = bare({ a: ['Ann', 0, 230], h: ['Host', null, 0] }, ledger);
    const L = summarize(st);
    assert.equal(L.entries.length, 200);
    assert.equal(L.entries[0].id, 230);
    assert.equal(L.entries[199].id, 31);
    assert.equal(L.entries.find((e) => e.type === 'adjust').byName, 'Host');
    assert.equal(L.totals.buyIns, 115, 'totals still cover every entry');
  });

  test('players who left keep their row; renamed or vanished players fall back to the ledger name', () => {
    const st = bare({ a: ['Ann', 0, 100] }, [buyin('a', 100), buyin('ghost', 50, 'Gus'), cashout('ghost', 80, 'Gus')]);
    const L = summarize(st);
    assert.equal(row(L, 'ghost').name, 'Gus');
    assert.equal(row(L, 'ghost').net, 30);
  });
});

describe('settle', () => {
  test('largest debtor pays largest creditor until everyone is square', () => {
    const rows = [
      { pid: 'a', name: 'Ann', net: 120 },
      { pid: 'b', name: 'Bob', net: 30 },
      { pid: 'c', name: 'Cat', net: -100 },
      { pid: 'd', name: 'Dan', net: -50 },
      { pid: 'e', name: 'Eve', net: 0 },
    ];
    assert.deepEqual(
      settle(rows).map((s) => [s.from, s.to, s.amount, s.key]),
      [
        ['c', 'a', 100, 'c>a:100'],
        ['d', 'b', 30, 'd>b:30'],
        ['d', 'a', 20, 'd>a:20'],
      ],
    );
  });

  test('paid flags come from state.paid by key; names are attached', () => {
    const out = settle(
      [
        { pid: 'a', name: 'Ann', net: 10 },
        { pid: 'b', name: 'Bob', net: -10 },
      ],
      { 'b>a:10': true },
    );
    assert.deepEqual(out, [{ key: 'b>a:10', from: 'b', fromName: 'Bob', to: 'a', toName: 'Ann', amount: 10, paid: true }]);
  });

  test('ties are broken by name then pid, so the plan is stable', () => {
    const rows = [
      { pid: 'z', name: 'Zed', net: 10 },
      { pid: 'y', name: 'Amy', net: 10 },
      { pid: 'x', name: 'Bea', net: -10 },
      { pid: 'w', name: 'Abe', net: -10 },
    ];
    assert.deepEqual(
      settle(rows).map((s) => s.key),
      ['w>y:10', 'x>z:10'],
    );
    assert.deepEqual(settle(rows.slice().reverse()), settle(rows));
  });

  test('unbalanced books: settle what can be settled and stop', () => {
    const out = settle([
      { pid: 'a', name: 'A', net: 100 },
      { pid: 'b', name: 'B', net: -60 },
    ]);
    assert.deepEqual(out.map((s) => s.key), ['b>a:60']);
    assert.deepEqual(
      settle([
        { pid: 'a', name: 'A', net: 40 },
        { pid: 'b', name: 'B', net: -70 },
      ]).map((s) => s.key),
      ['b>a:40'],
    );
  });

  test('property: any zero-sum set of nets is squared exactly, in at most n − 1 positive payments', () => {
    const R = mulberry32(99);
    for (let k = 0; k < 500; k++) {
      const n = 1 + Math.floor(R() * 12);
      const rows = [];
      let sum = 0;
      for (let i = 0; i < n - 1; i++) {
        const net = Math.floor(R() * 2001) - 1000;
        sum += net;
        rows.push({ pid: 'p' + i, name: 'N' + Math.floor(R() * 4), net });
      }
      rows.push({ pid: 'p' + (n - 1), name: 'Last', net: -sum });
      const out = settle(rows);
      const bal = Object.fromEntries(rows.map((r) => [r.pid, r.net]));
      for (const s of out) {
        assert.ok(s.amount > 0 && Number.isInteger(s.amount));
        assert.ok(bal[s.from] < 0 && bal[s.to] > 0, 'debtors pay creditors');
        bal[s.from] += s.amount;
        bal[s.to] -= s.amount;
      }
      assert.ok(Object.values(bal).every((v) => v === 0), 'everyone ends square');
      assert.ok(out.length <= Math.max(0, rows.filter((r) => r.net !== 0).length - 1));
    }
  });
});

describe('with the engine', () => {
  function game() {
    const ctx = { now: T0, rng: mulberry32(5) };
    const state = E.createRoom(
      { code: 'LDG-0001', name: 'Ledger', hostName: 'Host', hostId: 'h', settings: { approveBuyIns: false, minBuyIn: 10, maxBuyIn: 500 } },
      ctx,
    );
    E.addPlayer(state, { id: 'a', name: 'Ann' }, ctx);
    E.addPlayer(state, { id: 'b', name: 'Bob' }, ctx);
    const g = { state, ctx, act: (pid, a) => E.apply(state, pid, a, ctx) };
    g.act('h', { type: 'sit', seat: 0, amount: 200 });
    g.act('a', { type: 'sit', seat: 1, amount: 100 });
    g.act('b', { type: 'sit', seat: 2, amount: 300 });
    return g;
  }

  test('a full session: hands, an uncounted bonus, then endGame cashes everyone out', () => {
    const g = game();
    const R = mulberry32(17);
    for (let i = 0; i < 40; i++) {
      if (!g.state.hand) {
        if (g.state.deadline == null) break;
        g.ctx.now = g.state.deadline;
        E.tick(g.state, g.ctx);
        continue;
      }
      const h = g.state.hand;
      if (h.phase === 'betting') {
        const L = E.legalActions(g.state, h.toAct);
        g.act(h.toAct, { type: 'act', move: R() < 0.3 && L.raise ? 'raise' : L.check ? 'check' : 'call', to: L.minTo });
      } else {
        g.ctx.now = g.state.deadline;
        E.tick(g.state, g.ctx);
      }
      assert.equal(summarize(g.state).totals.balanced, true, 'balanced throughout');
    }
    const dealtIn = !!(g.state.hand && g.state.hand.ps.a);
    g.act('h', { type: 'adjust', pid: 'a', mode: 'add', amount: 25, reason: 'bounty', countAsBuyIn: false });
    let L = summarize(g.state);
    if (dealtIn) {
      // Ann is in the running hand: the adjustment waits for the hand to end (§6.6)
      assert.equal(g.state.pendingAdjust.length, 1);
      assert.equal(L.totals.uncountedAdjust, 0);
      assert.equal(L.totals.balanced, true);
    } else {
      assert.equal(L.totals.uncountedAdjust, 25);
      assert.equal(L.totals.diff, 25);
      assert.equal(L.totals.balanced, false);
    }
    g.act('h', { type: 'endGame' });
    while (!g.state.ended) {
      g.ctx.now = g.state.deadline;
      E.tick(g.state, g.ctx);
      if (g.state.hand && g.state.hand.phase === 'betting') g.act(g.state.hand.toAct, { type: 'act', move: 'fold' });
    }
    L = summarize(g.state);
    assert.equal(L.totals.uncountedAdjust, 25);
    assert.equal(L.totals.balanced, false, 'an uncounted bonus leaves the books off by its amount');
    assert.equal(L.totals.chipsOnTable, 0);
    assert.equal(L.totals.cashedOut, 600 + 25);
    assert.equal(L.players.reduce((a, r) => a + r.net, 0), 25);
    for (const r of L.players) assert.equal(r.stack, 0);
    // the host ticks one payment as paid; the flag shows up on that payment only
    const first = L.settlement[0];
    g.act('h', { type: 'markPaid', key: first.key, paid: true });
    L = summarize(g.state);
    assert.equal(L.settlement[0].paid, true);
    assert.ok(L.settlement.slice(1).every((s) => !s.paid));
  });
});

describe('settle with recorded payments (review regression)', () => {
  test('a ticked payment stays listed and is subtracted from what is still owed, whatever happens later', () => {
    const payments = [{ id: 9, key: 'bo>ana:100#9', from: 'bo', fromName: 'Bo', to: 'ana', toName: 'Ana', amount: 100 }];
    // later hands: Ana is now −50, Bo −100, Cy +150
    const out = settle(
      [
        { pid: 'cy', name: 'Cy', net: 150 },
        { pid: 'ana', name: 'Ana', net: -50 },
        { pid: 'bo', name: 'Bo', net: -100 },
      ],
      {},
      payments,
    );
    assert.deepEqual(out.map((s) => [s.key, s.from, s.to, s.amount, s.paid]), [
      ['bo>ana:100#9', 'bo', 'ana', 100, true],
      ['ana>cy:150', 'ana', 'cy', 150, false],
    ]);
  });
});
