// Tests for lib/equity.js. Run: node --test test/

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { equity, DEFAULT_ITERATIONS } from '../lib/equity.js';
import { fullDeck, shuffle, cryptoRng } from '../lib/cards.js';
import { scoreCodes, cardCodes } from '../lib/evaluator.js';

// ---------------------------------------------------------------------------------------------
// helpers: seeded rng + slow reference evaluator + brute-force reference equity
// ---------------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RV = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

// Reference 5-card value as a lexicographically comparable array (independent of lib code).
function ref5(cards) {
  const rs = cards.map((c) => RV[c[0]]).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const uniq = [...new Set(rs)];
  let st = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) st = uniq[0];
    else if (uniq.join(',') === '14,5,4,3,2') st = 5;
  }
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r) || 0) + 1);
  const g = [...counts.entries()].map(([r, c]) => [c, r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const shape = g.map((x) => x[0]).join('');
  const order = g.map((x) => x[1]);
  if (st && flush) return [8, st];
  if (shape === '41') return [7, ...order];
  if (shape === '32') return [6, ...order];
  if (flush) return [5, ...rs];
  if (st) return [4, st];
  if (shape === '311') return [3, ...order];
  if (shape === '221') return [2, ...order];
  if (shape === '2111') return [1, ...order];
  return [0, ...rs];
}
const cmp = (a, b) => {
  for (let i = 0; i < 6; i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; }
  return 0;
};
function combinations(arr, k) {
  const out = [];
  const rec = (s, acc) => {
    if (acc.length === k) return void out.push(acc.slice());
    for (let i = s; i < arr.length; i++) { acc.push(arr[i]); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}
const maxBy = (list) => list.reduce((b, v) => (!b || cmp(v, b) > 0 ? v : b), null);
const refHoldem = (hole, board) => maxBy(combinations([...hole, ...board], 5).map(ref5));
const refOmaha = (hole, board) => {
  const vals = [];
  for (const two of combinations(hole, 2)) for (const three of combinations(board, 3)) vals.push(ref5([...two, ...three]));
  return maxBy(vals);
};

/** Brute-force exact equity over every completion of the board (slow; use with ≤ 2 to come). */
function refEquity({ variant, hands, board, dead = [] }) {
  const pids = Object.keys(hands);
  const used = new Set([...Object.values(hands).flat(), ...board, ...dead]);
  const stub = fullDeck().filter((c) => !used.has(c));
  const toCome = 5 - board.length;
  const wins = Object.fromEntries(pids.map((p) => [p, 0]));
  const runs = combinations(stub, toCome);
  for (const extra of runs) {
    const b = [...board, ...extra];
    const vals = pids.map((p) => (variant === 'PLO' ? refOmaha(hands[p], b) : refHoldem(hands[p], b)));
    const best = maxBy(vals);
    const winners = pids.filter((p, i) => cmp(vals[i], best) === 0);
    for (const w of winners) wins[w] += 1 / winners.length;
  }
  return Object.fromEntries(pids.map((p) => [p, (wins[p] / runs.length) * 100]));
}

const H = (s) => s.trim().split(/\s+/);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

function assertClose(actual, expected, tol, msg) {
  for (const k of Object.keys(expected)) {
    assert.ok(Math.abs(actual[k] - expected[k]) <= tol, `${msg || ''} ${k}: ${actual[k]} vs ${expected[k]} (±${tol})`);
  }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
}

/** Exact preflop heads-up Hold'em equity via full enumeration (1.7M boards, fast path). */
function exactPreflopHU(a, b) {
  const A = cardCodes(a), B = cardCodes(b);
  const used = new Set([...A, ...B]);
  const stub = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) stub.push(c);
  const x = [A[0], A[1], 0, 0, 0, 0, 0];
  const y = [B[0], B[1], 0, 0, 0, 0, 0];
  let wa = 0, wb = 0, tot = 0;
  const m = stub.length;
  for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) for (let k = j + 1; k < m; k++)
    for (let l = k + 1; l < m; l++) for (let n = l + 1; n < m; n++) {
      x[2] = y[2] = stub[i]; x[3] = y[3] = stub[j]; x[4] = y[4] = stub[k]; x[5] = y[5] = stub[l]; x[6] = y[6] = stub[n];
      const s1 = scoreCodes(x, 7), s2 = scoreCodes(y, 7);
      if (s1 > s2) wa += 1; else if (s2 > s1) wb += 1; else { wa += 0.5; wb += 0.5; }
      tot++;
    }
  return { a: (wa / tot) * 100, b: (wb / tot) * 100 };
}

// ---------------------------------------------------------------------------------------------
// known values
// ---------------------------------------------------------------------------------------------

describe('equity: known values', () => {
  test('AA vs KK preflop ≈ 82/18 (Monte Carlo vs exact enumeration)', () => {
    const exact = exactPreflopHU(H('Ah As'), H('Kc Kd'));
    // exact for these suits: 81.26 / 18.74 (AA wins 81.06%, ties 0.38%)
    assert.ok(Math.abs(exact.a - 81.2555) < 0.01, String(exact.a));
    const mc = equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: [], dead: [], rng: mulberry32(1) });
    assertClose(mc, exact, 2.5, 'default 4000 iterations');
    const mcBig = equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: [], dead: [], rng: mulberry32(2), iterations: 100000 });
    assertClose(mcBig, exact, 0.6, '100k iterations');
    assert.ok(Math.abs(mcBig.a - 82) < 1.5 && Math.abs(mcBig.b - 18) < 1.5);
    assert.ok(Math.abs(sum(mc) - 100) < 1e-9);
  });

  test('suited AA vs KK shares suits → higher for AA', () => {
    const exact = exactPreflopHU(H('Ah As'), H('Kh Ks'));
    const mc = equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kh Ks') }, board: [], rng: mulberry32(3), iterations: 60000 });
    assertClose(mc, exact, 0.8);
    assert.ok(exact.a > 81.26);
  });

  test('A♥5♥ vs Q♣T♣ on Q♠8♥3♥ ≈ 44/56 (exact, equals brute force)', () => {
    const args = { variant: 'NLH', hands: { a: H('Ah 5h'), b: H('Qc Tc') }, board: H('Qs 8h 3h'), dead: [] };
    const e = equity({ ...args, rng: mulberry32(1) });
    const ref = refEquity(args);
    assertClose(e, ref, 1e-9);
    assert.ok(Math.abs(e.a - 44) < 2.5 && Math.abs(e.b - 56) < 2.5, JSON.stringify(e));
    // exact enumeration ignores the rng entirely
    assert.deepEqual(equity({ ...args, rng: () => 0.5 }), e);
    assert.deepEqual(equity({ ...args }), e);
  });

  test('classic coin flip AKs vs QQ ≈ 46/54 preflop', () => {
    const exact = exactPreflopHU(H('As Ks'), H('Qh Qd'));
    const mc = equity({ variant: 'NLH', hands: { ak: H('As Ks'), qq: H('Qh Qd') }, board: [], rng: mulberry32(9), iterations: 40000 });
    assertClose(mc, { ak: exact.a, qq: exact.b }, 1);
    assert.ok(exact.a > 44 && exact.a < 48, String(exact.a));
  });

  test('dominated: AK vs AQ on flop (exact)', () => {
    const args = { variant: 'NLH', hands: { ak: H('Ac Kd'), aq: H('Ah Qs') }, board: H('7c 2d 9h'), dead: [] };
    const e = equity({ ...args, rng: mulberry32(1) });
    assertClose(e, refEquity(args), 1e-9);
    assert.ok(e.ak > 85);
  });
});

// ---------------------------------------------------------------------------------------------
// exact enumeration vs brute force
// ---------------------------------------------------------------------------------------------

describe('equity: exact enumeration matches brute force', () => {
  test('random Hold\'em flops (2–4 players) and turns', () => {
    const rng = mulberry32(4242);
    for (let t = 0; t < 12; t++) {
      const d = shuffle(fullDeck(), rng);
      const nP = 2 + (t % 3);
      const hands = {};
      for (let i = 0; i < nP; i++) hands['p' + i] = d.slice(i * 2, i * 2 + 2);
      const bLen = t % 2 ? 4 : 3;
      const board = d.slice(20, 20 + bLen);
      const args = { variant: 'NLH', hands, board, dead: [] };
      const e = equity({ ...args, rng });
      assertClose(e, refEquity(args), 1e-9, `case ${t}`);
      assert.ok(Math.abs(sum(e) - 100) < 1e-9);
    }
  });

  test('random Omaha turns and a flop', () => {
    const rng = mulberry32(777);
    for (let t = 0; t < 6; t++) {
      const d = shuffle(fullDeck(), rng);
      const nP = 2 + (t % 3);
      const hands = {};
      for (let i = 0; i < nP; i++) hands['p' + i] = d.slice(i * 4, i * 4 + 4);
      const board = d.slice(30, t === 0 ? 33 : 34);
      const args = { variant: 'PLO', hands, board, dead: [] };
      const e = equity({ ...args, rng });
      assertClose(e, refEquity(args), 1e-9, `PLO case ${t}`);
    }
  });

  test('river (nothing to come): one exact showdown, ties split', () => {
    const board = H('Ah Kc Qd Js Th');
    assert.deepEqual(equity({ variant: 'NLH', hands: { a: H('2c 3d'), b: H('4c 5d') }, board, rng: Math.random }), { a: 50, b: 50 });
    const three = equity({ variant: 'NLH', hands: { a: H('2c 3d'), b: H('4c 5d'), c: H('6c 7d') }, board });
    for (const v of Object.values(three)) assert.ok(Math.abs(v - 100 / 3) < 1e-9);
    assert.deepEqual(equity({ variant: 'NLH', hands: { a: H('2c 3d'), b: H('Kd Kh') }, board: H('Ks 7c 7d 2h 9s') }), { a: 0, b: 100 });
    // two of three chop, third loses
    const chop = equity({ variant: 'NLH', hands: { a: H('Ac 3d'), b: H('Ad 4c'), c: H('Kh 5s') }, board: H('As 9c 9d 7h 8s') });
    assert.deepEqual(chop, { a: 50, b: 50, c: 0 });
    // Omaha river where a 4-flush in hand does not play
    const om = equity({ variant: 'PLO', hands: { flushy: H('Ah Kh Qh Jh'), pair: H('2c 2d 7s 8s') }, board: H('3h 9c Td 4s 6c') });
    assert.deepEqual(om, { flushy: 0, pair: 100 });
  });

  test('one card to come: counted outs', () => {
    // 33 vs AA on 2c 7d 9h Jc: 33 has exactly two outs (3c, 3d) among 44 rivers
    const args = { variant: 'NLH', hands: { aa: H('As Ah'), tt: H('3s 3h') }, board: H('2c 7d 9h Jc') };
    const e = equity(args);
    assert.ok(Math.abs(e.tt - (2 / 44) * 100) < 1e-9, String(e.tt));
    assert.ok(Math.abs(e.aa - (42 / 44) * 100) < 1e-9);
    assertClose(e, refEquity(args), 1e-9);
  });

  test('ties split on every completion (same hand in different suits)', () => {
    const e = equity({ variant: 'NLH', hands: { a: H('Ac Kd'), b: H('Ad Kc') }, board: H('2s 7h 9h') });
    assertClose(e, refEquity({ variant: 'NLH', hands: { a: H('Ac Kd'), b: H('Ad Kc') }, board: H('2s 7h 9h') }), 1e-9);
    assert.ok(Math.abs(e.a - 50) < 1e-9 && Math.abs(e.b - 50) < 1e-9);
  });
});

// ---------------------------------------------------------------------------------------------
// dead cards, run-it-twice style inputs
// ---------------------------------------------------------------------------------------------

describe('equity: dead cards', () => {
  test('dead cards are removed from the stub', () => {
    const base = { variant: 'NLH', hands: { aa: H('As Ah'), tt: H('3s 3h') }, board: H('2c 7d 9h Jc') };
    const e = equity({ ...base, dead: H('3c 3d') });
    assert.deepEqual(e, { aa: 100, tt: 0 });
    const half = equity({ ...base, dead: H('3c 5s') });
    assert.ok(Math.abs(half.tt - (1 / 42) * 100) < 1e-9);
    assertClose(half, refEquity({ ...base, dead: H('3c 5s') }), 1e-9);
  });

  test('dead may overlap the board / hands (other runs share the board prefix)', () => {
    const board = H('2c 7d 9h');
    const other = [...board, 'Kd', '4s'];
    const args = { variant: 'NLH', hands: { a: H('As Ah'), b: H('Kc Qc') }, board, dead: other };
    const e = equity(args);
    assertClose(e, refEquity(args), 1e-9);
  });

  test('flop with dead cards (Omaha) matches brute force', () => {
    const args = { variant: 'PLO', hands: { a: H('Ah Kh Qd Jd'), b: H('9c 9s 8c 7s') }, board: H('Th 9h 2d'), dead: H('Kc 3s 5h') };
    assertClose(equity(args), refEquity(args), 1e-9);
  });
});

// ---------------------------------------------------------------------------------------------
// Monte Carlo mechanics
// ---------------------------------------------------------------------------------------------

describe('equity: Monte Carlo', () => {
  function counting(seed) {
    const r = mulberry32(seed);
    const f = () => { f.calls++; return r(); };
    f.calls = 0;
    return f;
  }

  test('default iterations: 4000 Hold\'em, 1500 Omaha; override honoured', () => {
    assert.deepEqual({ ...DEFAULT_ITERATIONS }, { NLH: 4000, PLO: 1500 });
    const r1 = counting(1);
    equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: [], rng: r1 });
    assert.equal(r1.calls, 4000 * 5);
    const r2 = counting(2);
    equity({ variant: 'PLO', hands: { a: H('Ah As Kd Qd'), b: H('Kc Kh 7s 8s') }, board: [], rng: r2 });
    assert.equal(r2.calls, 1500 * 5);
    const r3 = counting(3);
    equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: [], rng: r3, iterations: 123 });
    assert.equal(r3.calls, 123 * 5);
    // board of 2 (3 to come) is Monte Carlo too
    const r4 = counting(4);
    equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: H('2c 3d'), rng: r4, iterations: 50 });
    assert.equal(r4.calls, 50 * 3);
    // exact (≤ 2 to come) never touches the rng
    const r5 = counting(5);
    equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: H('2c 3d 4h'), rng: r5 });
    assert.equal(r5.calls, 0);
  });

  test('deterministic for a given rng stream; sums to 100', () => {
    const args = { variant: 'NLH', hands: { a: H('Ah Kh'), b: H('2c 2d'), c: H('Js Ts') }, board: [], dead: [] };
    const x = equity({ ...args, rng: mulberry32(10) });
    const y = equity({ ...args, rng: mulberry32(10) });
    assert.deepEqual(x, y);
    assert.ok(Math.abs(sum(x) - 100) < 1e-9);
    for (const v of Object.values(x)) assert.ok(v >= 0 && v <= 100);
  });

  test('Monte Carlo on 2-card board converges to brute force', () => {
    // 3 to come: brute force with the fast scorer over all C(46,3) completions
    const hands = { a: H('Ah Kd'), b: H('9c 9s') };
    const board = H('2c 7d');
    const mc = equity({ variant: 'NLH', hands, board, rng: mulberry32(8), iterations: 60000 });
    const used = new Set([...hands.a, ...hands.b, ...board]);
    const stub = fullDeck().filter((c) => !used.has(c));
    let wa = 0, tot = 0;
    const A = cardCodes([...hands.a, ...board]), B = cardCodes([...hands.b, ...board]);
    const S = cardCodes(stub);
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) for (let k = j + 1; k < S.length; k++) {
      const sa = scoreCodes([...A, S[i], S[j], S[k]], 7), sb = scoreCodes([...B, S[i], S[j], S[k]], 7);
      wa += sa > sb ? 1 : sa === sb ? 0.5 : 0; tot++;
    }
    const exactA = (wa / tot) * 100;
    assert.ok(Math.abs(mc.a - exactA) < 0.8, `${mc.a} vs ${exactA}`);
  });

  test('PLO preflop Monte Carlo agrees with an independent reference-evaluator simulation', () => {
    const hands = { aa: H('Ah As Kh Ks'), r: H('7c 6d 2s 3h') };
    const e = equity({ variant: 'PLO', hands, board: [], rng: mulberry32(12), iterations: 30000 });
    // independent simulation: slow reference Omaha evaluator, separate rng stream
    const rng = mulberry32(99);
    const used = new Set([...hands.aa, ...hands.r]);
    const stub = fullDeck().filter((c) => !used.has(c));
    const N = 1500;
    let w = 0;
    for (let i = 0; i < N; i++) {
      const board = shuffle(stub, rng).slice(0, 5);
      const c = cmp(refOmaha(hands.aa, board), refOmaha(hands.r, board));
      w += c > 0 ? 1 : c === 0 ? 0.5 : 0;
    }
    const refPct = (w / N) * 100;
    assert.ok(Math.abs(e.aa - refPct) < 4.5, `${e.aa} vs ref ${refPct}`);
    assert.ok(e.aa > 60 && e.aa < 80, String(e.aa)); // PLO equities run close
    assert.ok(Math.abs(sum(e) - 100) < 1e-9);
  });

  test('works without an rng (deterministic internal fallback)', () => {
    const args = { variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: [] };
    const x = equity(args);
    assert.deepEqual(x, equity(args));
    assert.ok(x.a > 77 && x.a < 86);
  });

  test('cryptoRng works as the rng', () => {
    const e = equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: [], rng: cryptoRng(), iterations: 20000 });
    assert.ok(Math.abs(e.a - 81.26) < 1.5);
  });
});

// ---------------------------------------------------------------------------------------------
// edge cases and validation
// ---------------------------------------------------------------------------------------------

describe('equity: edge cases', () => {
  test('no hands / single hand', () => {
    assert.deepEqual(equity({ variant: 'NLH', hands: {}, board: [] }), {});
    assert.deepEqual(equity({ variant: 'NLH', hands: { solo: H('2c 7d') }, board: [] }), { solo: 100 });
  });

  test('result keys preserve pids', () => {
    const e = equity({ variant: 'NLH', hands: { 'x-1': H('2c 7d'), Zed_9: H('Ah Kh') }, board: H('3c 4d 5h 6s') });
    assert.deepEqual(Object.keys(e), ['x-1', 'Zed_9']);
  });

  test('rejects invalid input', () => {
    const rng = mulberry32(1);
    assert.throws(() => equity({ variant: 'Stud', hands: { a: H('Ah As') }, board: [], rng }), TypeError);
    assert.throws(() => equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Ah Kd') }, board: [], rng }), /duplicate/);
    assert.throws(() => equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: H('Ah 2c 3d'), rng }), /duplicate/);
    assert.throws(() => equity({ variant: 'NLH', hands: { a: H('Ah As Kd'), b: H('Kc Kh') }, board: [], rng }), RangeError);
    assert.throws(() => equity({ variant: 'PLO', hands: { a: H('Ah'), b: H('Kc Kh Qs Qd') }, board: [], rng }), RangeError);
    assert.throws(() => equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: H('2c 3c 4c 5c 6c 7c'), rng }), RangeError);
    assert.throws(() => equity({ variant: 'NLH', hands: { a: ['Ah', 'Xx'], b: H('Kc Kd') }, board: [], rng }), TypeError);
    assert.throws(() => equity({ variant: 'NLH', hands: null, board: [] }), TypeError);
    assert.throws(() => equity({ variant: 'NLH', hands: { a: 'AhAs' }, board: [] }), TypeError);
    // more cards needed than live in the stub
    const dead = fullDeck().filter((c) => !['Ah', 'As', 'Kc', 'Kd', '2c'].includes(c));
    assert.throws(() => equity({ variant: 'NLH', hands: { a: H('Ah As'), b: H('Kc Kd') }, board: H('2c 3c 4c'), dead: dead.filter((c) => !['3c', '4c'].includes(c)), rng }), RangeError);
  });

  test('9 players Omaha (36 hole cards) still fits', () => {
    const d = shuffle(fullDeck(), mulberry32(5));
    const hands = {};
    for (let i = 0; i < 9; i++) hands['p' + i] = d.slice(i * 4, i * 4 + 4);
    const e = equity({ variant: 'PLO', hands, board: d.slice(36, 39), rng: mulberry32(1) });
    assert.ok(Math.abs(sum(e) - 100) < 1e-9);
  });
});

// ---------------------------------------------------------------------------------------------
// performance budgets (SPEC §4)
// ---------------------------------------------------------------------------------------------

describe('equity: performance budgets', () => {
  const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };

  test('9 Hold\'em hands preflop < 400 ms', (t) => {
    const rng = cryptoRng();
    const d = shuffle(fullDeck(), rng);
    const hands = {};
    for (let i = 0; i < 9; i++) hands['p' + i] = d.slice(i * 2, i * 2 + 2);
    const cold = time(() => equity({ variant: 'NLH', hands, board: [], dead: [], rng }));
    const warm = time(() => equity({ variant: 'NLH', hands, board: [], dead: [], rng }));
    t.diagnostic(`9-way NLH preflop: ${cold.toFixed(1)} ms cold, ${warm.toFixed(1)} ms warm`);
    assert.ok(cold < 400, `${cold} ms`);
  });

  test('4 Omaha hands preflop < 600 ms', (t) => {
    const rng = cryptoRng();
    const d = shuffle(fullDeck(), rng);
    const hands = {};
    for (let i = 0; i < 4; i++) hands['p' + i] = d.slice(i * 4, i * 4 + 4);
    const cold = time(() => equity({ variant: 'PLO', hands, board: [], dead: [], rng }));
    const warm = time(() => equity({ variant: 'PLO', hands, board: [], dead: [], rng }));
    t.diagnostic(`4-way PLO preflop: ${cold.toFixed(1)} ms cold, ${warm.toFixed(1)} ms warm`);
    assert.ok(cold < 600, `${cold} ms`);
  });

  test('worst exact cases are fast (9-way flop NLH / PLO)', (t) => {
    const rng = cryptoRng();
    const d = shuffle(fullDeck(), rng);
    const nlh = {};
    const plo = {};
    for (let i = 0; i < 9; i++) { nlh['p' + i] = d.slice(i * 2, i * 2 + 2); plo['p' + i] = d.slice(i * 4, i * 4 + 4); }
    const a = time(() => equity({ variant: 'NLH', hands: nlh, board: d.slice(40, 43), rng }));
    const b = time(() => equity({ variant: 'PLO', hands: plo, board: d.slice(40, 43), rng }));
    const c = time(() => equity({ variant: 'PLO', hands: { a: plo.p0, b: plo.p1 }, board: d.slice(40, 43), rng }));
    t.diagnostic(`exact flop: 9-way NLH ${a.toFixed(1)} ms, 9-way PLO ${b.toFixed(1)} ms, HU PLO ${c.toFixed(1)} ms`);
    assert.ok(a < 400 && b < 600 && c < 600);
  });
});
