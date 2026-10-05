// Tests for lib/cards.js and lib/evaluator.js.
// Run: node --test test/
// The exhaustive 133M-hand 7-card census is opt-in: FELT_SLOW=1 node --test test/evaluator.test.js

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RANKS, SUITS, fullDeck, shuffle, rankOf, suitOf, cryptoRng, isCard } from '../lib/cards.js';
import {
  evaluate, evaluateHoldem, evaluateOmaha, evaluateFor,
  scoreCodes, scoreOmahaCodes, cardCode, cardCodes, scoreName, CATEGORY_NAMES, CARD_OF_CODE,
} from '../lib/evaluator.js';

// ---------------------------------------------------------------------------------------------
// helpers: seeded rng + slow, obviously-correct reference evaluator
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

/** Reference: 5 cards → [category, ...tiebreak ranks] (lexicographically comparable). */
function ref5(cards) {
  assert.equal(cards.length, 5);
  const rs = cards.map((c) => RV[c[0]]).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);
  const uniq = [...new Set(rs)];
  let straightTop = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightTop = uniq[0];
    else if (uniq.join(',') === '14,5,4,3,2') straightTop = 5;
  }
  const counts = new Map();
  for (const r of rs) counts.set(r, (counts.get(r) || 0) + 1);
  const groups = [...counts.entries()].map(([r, c]) => [c, r]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  const shape = groups.map((g) => g[0]).join('');
  const order = groups.map((g) => g[1]);
  if (straightTop && flush) return [8, straightTop];
  if (shape === '41') return [7, ...order];
  if (shape === '32') return [6, ...order];
  if (flush) return [5, ...rs];
  if (straightTop) return [4, straightTop];
  if (shape === '311') return [3, ...order];
  if (shape === '221') return [2, ...order];
  if (shape === '2111') return [1, ...order];
  return [0, ...rs];
}

function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function combinations(arr, k) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === k) return void out.push(acc.slice());
    for (let i = start; i < arr.length; i++) { acc.push(arr[i]); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

function refBest(cards) {
  let best = null;
  for (const five of combinations(cards, 5)) {
    const v = ref5(five);
    if (!best || cmp(v, best) > 0) best = v;
  }
  return best;
}

function refOmaha(hole, board) {
  let best = null;
  for (const two of combinations(hole, 2)) {
    for (const three of combinations(board, 3)) {
      const v = ref5([...two, ...three]);
      if (!best || cmp(v, best) > 0) best = v;
    }
  }
  return best;
}

/** The documented score layout: category << 20 | r1 << 16 | ... | r5. */
function pack(tuple) {
  let s = tuple[0] << 20;
  for (let i = 1; i < tuple.length; i++) s |= tuple[i] << (20 - 4 * i);
  return s;
}

function deal(rng, n) {
  return shuffle(fullDeck(), rng).slice(0, n);
}

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

// ---------------------------------------------------------------------------------------------
// cards.js
// ---------------------------------------------------------------------------------------------

describe('cards', () => {
  test('ranks, suits and full deck', () => {
    assert.deepEqual([...RANKS], ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
    assert.deepEqual([...SUITS], ['s', 'h', 'd', 'c']);
    const d = fullDeck();
    assert.equal(d.length, 52);
    assert.equal(new Set(d).size, 52);
    for (const c of d) assert.ok(isCard(c), c);
    assert.notEqual(fullDeck(), d, 'fresh array each call');
    for (const c of ['As', 'Td', '9h', '2c']) assert.ok(d.includes(c));
  });

  test('rankOf / suitOf', () => {
    assert.equal(rankOf('As'), 14);
    assert.equal(rankOf('Kd'), 13);
    assert.equal(rankOf('Qh'), 12);
    assert.equal(rankOf('Jc'), 11);
    assert.equal(rankOf('Td'), 10);
    assert.equal(rankOf('9h'), 9);
    assert.equal(rankOf('2c'), 2);
    assert.equal(suitOf('As'), 's');
    assert.equal(suitOf('Td'), 'd');
    assert.equal(suitOf('9h'), 'h');
    assert.equal(suitOf('2c'), 'c');
    for (const c of fullDeck()) {
      assert.equal(rankOf(c), RANKS.indexOf(c[0]) + 2);
      assert.ok(SUITS.includes(suitOf(c)));
    }
    for (const bad of ['', 'A', '1s', 'Ax', 'as', '10s', null, undefined, 14]) {
      assert.equal(isCard(bad), false);
      assert.throws(() => rankOf(bad), TypeError);
      assert.throws(() => suitOf(bad), TypeError);
    }
  });

  test('shuffle returns a new permutation and leaves input intact', () => {
    const d = fullDeck();
    const copy = d.slice();
    const s = shuffle(d, mulberry32(1));
    assert.deepEqual(d, copy);
    assert.notEqual(s, d);
    assert.equal(s.length, 52);
    assert.deepEqual([...s].sort(), [...d].sort());
    assert.notDeepEqual(s, d);
    // deterministic for the same rng stream
    assert.deepEqual(shuffle(d, mulberry32(7)), shuffle(d, mulberry32(7)));
    // degenerate rngs still produce permutations (rng() === 1 is clamped)
    assert.deepEqual([...shuffle(d, () => 0.999999999999)].sort(), [...d].sort());
    assert.deepEqual([...shuffle(d, () => 1)].sort(), [...d].sort());
    assert.deepEqual([...shuffle(d, () => 0)].sort(), [...d].sort());
    assert.deepEqual(shuffle([], Math.random), []);
    assert.throws(() => shuffle(d), TypeError);
  });

  test('shuffle is (statistically) uniform: position of each card', () => {
    const rng = mulberry32(42);
    const N = 30000;
    const pos = new Array(5).fill(0).map(() => new Array(5).fill(0));
    for (let i = 0; i < N; i++) {
      const s = shuffle([0, 1, 2, 3, 4], rng);
      s.forEach((v, p) => pos[v][p]++);
    }
    for (const row of pos) for (const c of row) assert.ok(Math.abs(c / N - 0.2) < 0.015, String(c));
  });

  test('cryptoRng: uses globalThis.crypto, values in [0,1), roughly uniform', () => {
    const rng = cryptoRng();
    assert.equal(typeof rng, 'function');
    const buckets = new Array(10).fill(0);
    const N = 50000;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const x = rng();
      assert.ok(x >= 0 && x < 1);
      buckets[Math.floor(x * 10)]++;
      sum += x;
    }
    assert.ok(Math.abs(sum / N - 0.5) < 0.01);
    for (const b of buckets) assert.ok(Math.abs(b / N - 0.1) < 0.01);
    // it really is backed by getRandomValues
    const real = globalThis.crypto;
    let called = 0;
    const spy = { getRandomValues: (a) => { called++; return real.getRandomValues(a); } };
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: spy, configurable: true, writable: true });
    try {
      const r2 = cryptoRng();
      r2();
      assert.ok(called >= 1);
    } finally {
      if (desc) Object.defineProperty(globalThis, 'crypto', desc);
    }
    const s = shuffle(fullDeck(), cryptoRng());
    assert.equal(new Set(s).size, 52);
  });
});

// ---------------------------------------------------------------------------------------------
// evaluator: hand-picked cases
// ---------------------------------------------------------------------------------------------

const H = (s) => s.trim().split(/\s+/);

const NAMED = [
  // [cards, category, name, best (as set)]
  ['As Ks Qs Js Ts 2c 3d', 8, 'Royal flush', 'As Ks Qs Js Ts'],
  ['9h 8h 7h 6h 5h Kc Kd', 8, 'Straight flush, Nine high', '9h 8h 7h 6h 5h'],
  ['Ah 2h 3h 4h 5h 9c Kd', 8, 'Straight flush, Five high', 'Ah 2h 3h 4h 5h'], // steel wheel
  ['Ah 2h 3h 4h 5h 6h Kd', 8, 'Straight flush, Six high', '2h 3h 4h 5h 6h'],
  ['7c 7d 7h 7s Ah Kc 2d', 7, 'Four Sevens', '7c 7d 7h 7s Ah'],
  ['2c 2d 2h 2s 3h 3c 3d', 7, 'Four Twos', '2c 2d 2h 2s 3h'],
  ['Kh Kc Kd 4h 4s 2c 9d', 6, 'Full house, Kings full of Fours', 'Kh Kc Kd 4h 4s'],
  ['Kh Kc Kd 4h 4s 4c 2d', 6, 'Full house, Kings full of Fours', 'Kh Kc Kd 4h 4s'], // two trips
  ['4h 4s 4c Kh Kc Kd 2d', 6, 'Full house, Kings full of Fours', 'Kh Kc Kd 4h 4s'],
  ['3h 3s 3c Qh Qc 9d 9s', 6, 'Full house, Threes full of Queens', '3h 3s 3c Qh Qc'],
  ['Ah Jh 9h 5h 2h 3c Td', 5, 'Flush, Ace high', 'Ah Jh 9h 5h 2h'],
  ['Ah Jh 9h 5h 2h 3h Td', 5, 'Flush, Ace high', 'Ah Jh 9h 5h 3h'], // 6 flush cards, top 5
  ['9d 8d 7d 6d 2d Tc 5s', 5, 'Flush, Nine high', '9d 8d 7d 6d 2d'], // flush beats straight
  ['6h 7c 8d 9s Th 3c Td', 4, 'Straight, Ten high', '6h 7c 8d 9s Th'],
  ['Ah 2c 3h 4d 5s 9c Kd', 4, 'Straight, Five high', 'Ah 2c 3h 4d 5s'], // wheel
  ['Ah 2c 3h 4d 5s 6c Kd', 4, 'Straight, Six high', '2c 3h 4d 5s 6c'],
  ['Ah Kc Qh Jd Ts 9c 2d', 4, 'Straight, Ace high', 'Ah Kc Qh Jd Ts'],
  ['Qh Qc Qd 9s 2h 3c Kd', 3, 'Three Queens', 'Qh Qc Qd Kd 9s'],
  ['Ah Ac 9d 9s 2h 2c Kd', 2, 'Two pair, Aces and Nines', 'Ah Ac 9d 9s Kd'],
  ['Ah Ac 9d 9s 2h 2c 3d', 2, 'Two pair, Aces and Nines', 'Ah Ac 9d 9s 3d'],
  ['5h 5c 4d 4s 3h 3c 2d', 2, 'Two pair, Fives and Fours', '5h 5c 4d 4s 3h'],
  ['Kh Kc 5d 9s 2h 3c Td', 1, 'Pair of Kings', 'Kh Kc Td 9s 5d'],
  ['Ah Jc 5d 9s 2h 3c Td', 0, 'Ace high', 'Ah Jc Td 9s 5d'],
  ['7h 5c 4d 3s 2h', 0, 'Seven high', '7h 5c 4d 3s 2h'],
  ['Kh Qc Jd Ts 8h', 0, 'King high', 'Kh Qc Jd Ts 8h'],
  ['Ts Th 2c 3d 4h 8s', 1, 'Pair of Tens', 'Ts Th 8s 4h 3d'],
];

describe('evaluator: named hands', () => {
  for (const [cs, cat, name, best] of NAMED) {
    test(`${cs} → ${name}`, () => {
      const cards = H(cs);
      const r = evaluate(cards);
      assert.equal(r.category, cat);
      assert.equal(r.name, name);
      assert.deepEqual([...r.best].sort(), H(best).sort());
      assert.deepEqual(Object.keys(r).sort(), ['best', 'category', 'name', 'score']);
      assert.equal(r.score, pack(refBest(cards)));
      // order-independence
      assert.equal(evaluate([...cards].reverse()).score, r.score);
    });
  }

  test('every rank word / plural', () => {
    const words = { 2: 'Two', 3: 'Three', 4: 'Four', 5: 'Five', 6: 'Six', 7: 'Seven', 8: 'Eight', 9: 'Nine', T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
    const plurals = { 2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens', 8: 'Eights', 9: 'Nines', T: 'Tens', J: 'Jacks', Q: 'Queens', K: 'Kings', A: 'Aces' };
    for (const r of RANKS) {
      const fillers = RANKS.filter((x) => x !== r);
      // pair: use non-connected fillers far from r
      const pairCards = [r + 's', r + 'h'];
      const pick = fillers.filter((x) => Math.abs(RV[x] - RV[r]) > 1).slice(0, 3);
      const pair = evaluate([...pairCards, pick[0] + 'c', pick[1] + 'd', pick[2] + 'c']);
      if (pair.category === 1) assert.equal(pair.name, 'Pair of ' + plurals[r]);
      const trips = evaluate([r + 's', r + 'h', r + 'd', pick[0] + 'c', pick[1] + 'd']);
      assert.equal(trips.name, 'Three ' + plurals[r]);
      const quads = evaluate([r + 's', r + 'h', r + 'd', r + 'c', pick[0] + 'd']);
      assert.equal(quads.name, 'Four ' + plurals[r]);
      const k = fillers[0];
      const fh = evaluate([r + 's', r + 'h', r + 'd', k + 'c', k + 'd']);
      assert.equal(fh.name, `Full house, ${plurals[r]} full of ${plurals[k]}`);
      if (RV[r] >= 6) {
        // straight with top r (not a flush)
        const st = [0, 1, 2, 3, 4].map((i) => RANKS[RV[r] - 2 - i] + (i === 0 ? 's' : 'h'));
        const sr = evaluate(st);
        assert.equal(sr.name, `Straight, ${words[r]} high`);
        const sf = evaluate(st.map((c) => c[0] + 'd'));
        assert.equal(sf.name, RV[r] === 14 ? 'Royal flush' : `Straight flush, ${words[r]} high`);
      }
    }
  });

  test('CATEGORY_NAMES and scoreName', () => {
    assert.equal(CATEGORY_NAMES.length, 9);
    assert.equal(CATEGORY_NAMES[0], 'High card');
    assert.equal(CATEGORY_NAMES[8], 'Straight flush');
    assert.equal(scoreName(evaluate(H('As Ad Kc Kh 2s')).score), 'Two pair, Aces and Kings');
    assert.throws(() => scoreName(9 << 20), RangeError);
  });
});

// ---------------------------------------------------------------------------------------------
// evaluator: ordering rules and ties
// ---------------------------------------------------------------------------------------------

describe('evaluator: ordering, kickers and ties', () => {
  const score = (s) => evaluate(H(s)).score;

  test('category order is monotone', () => {
    const ladder = [
      'Ah Jc 5d 9s 2h', // high
      '2h 2c 3d 4s 6h', // pair
      '2h 2c 3d 3s 4h', // two pair
      '2h 2c 2d 3s 4h', // trips
      'Ah 2c 3d 4s 5h', // wheel
      '2h 3h 4h 5h 7h', // flush
      '2h 2c 2d 3s 3h', // full house
      '2h 2c 2d 2s 3h', // quads
      'Ah 2h 3h 4h 5h', // steel wheel
    ];
    for (let i = 1; i < ladder.length; i++) assert.ok(score(ladder[i]) > score(ladder[i - 1]), ladder[i]);
    // top of each category still loses to the bottom of the next
    assert.ok(score('2h 2c 3d 4s 5h') > score('Ah Kc Qd Js 9h'));
    assert.ok(score('3h 3c 2d 2s 4h') > score('Ah Ac Kd Qs Jh'));
    assert.ok(score('2h 2c 2d 3s 4h') > score('Ah Ac Kd Ks Qh'));
    assert.ok(score('Ah 2c 3d 4s 5h') > score('Ah Ac Ad Ks Qh'));
    assert.ok(score('2h 3h 4h 5h 7h') > score('Ah Kc Qd Js Th'));
    assert.ok(score('2h 2c 2d 3s 3h') > score('Ah Kh Qh Jh 9h'));
    assert.ok(score('2h 2c 2d 2s 3h') > score('Ah Ac Ad Ks Kh'));
    assert.ok(score('Ah 2h 3h 4h 5h') > score('Ah Ac Ad As Kh'));
  });

  test('wheel is the lowest straight; steel wheel the lowest straight flush', () => {
    assert.ok(score('Ah 2c 3d 4s 5h') < score('2h 3c 4d 5s 6h'));
    assert.ok(score('Ah 2h 3h 4h 5h') < score('2c 3c 4c 5c 6c'));
    // A-K-Q-J-T beats K-Q-J-T-9
    assert.ok(score('Ah Kc Qd Js Th') > score('Kh Qc Jd Ts 9h'));
    // no wrap-around straight
    assert.equal(evaluate(H('Qh Kc Ad 2s 3h')).category, 0);
    assert.equal(evaluate(H('Kh Ac 2d 3s 4h')).category, 0);
  });

  test('kickers', () => {
    assert.ok(score('Ah Ac Kd 9s 2h') > score('Ad As Qd Js Th'));
    assert.ok(score('Ah Ac Kd 9s 3h') > score('Ad As Kc 9h 2h'));
    assert.ok(score('Ah Ac Kd Ks 3h') > score('Ad As Kc Kh 2h'));
    assert.ok(score('Ah Ac Ad Ks 3h') > score('As Ac Ad Qs Jh'));
    assert.ok(score('Ah Ac Ad As 3h') > score('Ah Ac Ad As 2h'));
    assert.ok(score('Ah Kh 9h 5h 3h') > score('Ac Kc 9c 5c 2c'));
    assert.ok(score('Kh Kc Kd 2s 2h') > score('Qh Qc Qd As Ah'));
    assert.ok(score('Kh Kc Kd 3s 3h') > score('Ks Kc Kd 2s 2h'));
    assert.ok(score('Ah Kc Qd Js 9h') > score('Ah Kc Qd Js 8h'));
    // two pair: higher pair first, then lower pair, then kicker
    assert.ok(score('Ah Ac 3d 3s 2h') > score('Kh Kc Qd Qs Jh'));
    assert.ok(score('Ah Ac 4d 4s 2h') > score('Ah Ac 3d 3s Kh'));
  });

  test('sixth and seventh cards never matter', () => {
    // AK vs AQ on A A 7 7 2 → K kicker plays
    assert.ok(evaluateHoldem(H('Ks 3c'), H('Ah Ad 7c 7s 2h')).score > evaluateHoldem(H('Qs 3d'), H('Ah Ad 7c 7s 2h')).score);
    // three pairs: third pair can only be a kicker
    const a = evaluate(H('Ah Ac Kd Ks Qh Qc 2d'));
    assert.equal(a.name, 'Two pair, Aces and Kings');
    assert.deepEqual([...a.best].sort(), H('Ah Ac Kd Ks Qh').sort());
    assert.equal(a.score, evaluate(H('Ah Ac Kd Ks Qd 3c 2d')).score);
    // a lower kicker beyond five cards is irrelevant
    assert.equal(score('Ah Kc Qd Js 9h 3c 2d'), score('Ah Kc Qd Js 9h 4c 3d'));
  });

  test('board plays → exact ties', () => {
    const board = H('Ah Kc Qd Js Th');
    assert.equal(evaluateHoldem(H('2c 3d'), board).score, evaluateHoldem(H('4c 5d'), board).score);
    assert.equal(evaluateHoldem(H('2c 3d'), board).name, 'Straight, Ace high');
    const quads = H('9c 9d 9h 9s Ac');
    assert.equal(evaluateHoldem(H('Kd Qd'), quads).score, evaluateHoldem(H('2c 3c'), quads).score);
    // counterfeited pocket pair
    const b2 = H('Ah Ac Kd Ks Qh');
    assert.equal(evaluateHoldem(H('3c 3d'), b2).score, evaluateHoldem(H('4c 4d'), b2).score);
    // board flush both play
    const b3 = H('Ah Jh 8h 6h 3h');
    assert.equal(evaluateHoldem(H('2c 2d'), b3).score, evaluateHoldem(H('Kc Kd'), b3).score);
    assert.ok(evaluateHoldem(H('Kh 2d'), b3).score > evaluateHoldem(H('2h Kd'), b3).score);
  });

  test('flush vs straight with 7 cards picks the flush', () => {
    const r = evaluate(H('5h 6c 7h 8h 9d Th 2h'));
    assert.equal(r.category, 5);
    assert.equal(r.name, 'Flush, Ten high');
    assert.deepEqual([...r.best].sort(), H('5h 7h 8h Th 2h').sort());
    // both a straight flush and a higher plain straight → straight flush
    const sf = evaluate(H('5h 6h 7h 8h 9h Tc Jd'));
    assert.equal(sf.name, 'Straight flush, Nine high');
    // flush + trips → flush
    assert.equal(evaluate(H('Ah Ac Ad 8h 6h 4h 2h')).category, 5);
    // full house beats a flush present at the same time is impossible in 7 cards; quads vs straight
    assert.equal(evaluate(H('8c 8d 8h 8s 9h Th Jh')).name, 'Four Eights');
  });

  test('best is always 5 distinct input cards that realize the score', () => {
    const r = evaluate(H('2c 2d 2h 3s 3c 3d Ah'));
    assert.equal(r.name, 'Full house, Threes full of Twos');
    assert.equal(r.best.length, 5);
    assert.equal(scoreCodes(cardCodes(r.best), 5), r.score);
    // significant cards first
    assert.deepEqual(evaluate(H('2c Kd 9s Kh 5d')).best, H('Kd Kh 9s 5d 2c'));
    assert.deepEqual(evaluate(H('5s 4d 3h 2c Ah')).best, H('5s 4d 3h 2c Ah'));
  });
});

// ---------------------------------------------------------------------------------------------
// evaluator: Omaha
// ---------------------------------------------------------------------------------------------

describe('evaluator: Omaha (exactly 2 hole + 3 board)', () => {
  test('four hearts in hand + one on board is NOT a flush', () => {
    const r = evaluateOmaha(H('Ah Kh Qh Jh'), H('2h 3c 4d 9s Tc'));
    assert.notEqual(r.category, 5);
    assert.equal(r.name, 'Ace high');
    // ...and two on board still isn't
    assert.notEqual(evaluateOmaha(H('Ah Kh Qh Jh'), H('2h 3h 4d 9s Tc')).category, 5);
    // three on board is
    const f = evaluateOmaha(H('Ah Kh Qc Jd'), H('2h 3h 4h 9s Tc'));
    assert.equal(f.name, 'Flush, Ace high');
    assert.deepEqual([...f.best].sort(), H('Ah Kh 2h 3h 4h').sort());
  });

  test('board flush cannot be used with a single suited hole card', () => {
    const r = evaluateOmaha(H('Ah Kc Qc Jd'), H('2h 5h 7h 9h Jh'));
    assert.notEqual(r.category, 5);
    assert.equal(evaluateHoldem(H('Ah Kc'), H('2h 5h 7h 9h Jh')).category, 5);
  });

  test('board quads: must use two hole cards', () => {
    const r = evaluateOmaha(H('Ac Ad Qc Qd'), H('7c 7d 7h 7s Kh'));
    assert.equal(r.name, 'Full house, Sevens full of Aces');
    const r2 = evaluateOmaha(H('7c 2d 3c 4d'), H('7d 7h 7s Kh Qs'));
    assert.equal(r2.name, 'Four Sevens');
  });

  test('board straight is not usable', () => {
    const r = evaluateOmaha(H('Ac Ad Kc Kd'), H('5h 6c 7d 8s 9h'));
    assert.equal(r.name, 'Pair of Aces');
    assert.deepEqual([...r.best].sort(), H('Ac Ad 9h 8s 7d').sort());
    // one connecting hole card is not enough either
    assert.equal(evaluateOmaha(H('Tc 2d 2c Kd'), H('5h 6c 7d 8s 9h')).category, 1);
    // two are
    assert.equal(evaluateOmaha(H('Tc Jd 2c Kd'), H('5h 6c 7d 8s 9h')).name, 'Straight, Jack high');
  });

  test('board trips and board two pair', () => {
    assert.equal(evaluateOmaha(H('Ac Qd Jc Td'), H('Kh Kc Kd 7s 2h')).name, 'Three Kings');
    assert.equal(evaluateOmaha(H('Ac Ad Jc Td'), H('Kh Kc Kd 7s 2h')).name, 'Full house, Kings full of Aces');
    // board two pair: a single matching hole card makes trips only; a full house needs two hole cards
    assert.equal(evaluateOmaha(H('9c 4d 3c 2s'), H('9h 9d Kc Ks 5h')).name, 'Three Nines');
    assert.equal(evaluateOmaha(H('9c Kd 3c 2s'), H('9h 9d Kc Ks 5h')).name, 'Full house, Kings full of Nines');
    // three board cards can hold only one of the board pairs
    assert.equal(evaluateOmaha(H('Ac 4d 3c 2s'), H('9h 9d Kc Ks 5h')).name, 'Pair of Kings');
    assert.equal(evaluateHoldem(H('Ac 4d'), H('9h 9d Kc Ks 5h')).name, 'Two pair, Kings and Nines');
    // Hold'em would use the A-kicker... Omaha must use two hole cards
    const om = evaluateOmaha(H('Ac 4d 8c 7s'), H('9h 9d Kc Ks 5h'));
    assert.equal(om.category, 1);
    assert.equal(om.name, 'Pair of Kings');
  });

  test('wraps and steel wheel in Omaha', () => {
    assert.equal(evaluateOmaha(H('Ad 2d Kc Kh'), H('3d 4d 5d Qs Jc')).name, 'Straight flush, Five high');
    assert.equal(evaluateOmaha(H('9c 8d Tc Jh'), H('7s 6d 5c Ks 2c')).name, 'Straight, Nine high');
    assert.equal(evaluateOmaha(H('9c 8d Tc Jh'), H('7s 6d 2c Ks Qc')).name, 'King high'); // K-Q-J-T-9 needs three hole cards
  });

  test('flop (3-card) and turn boards', () => {
    const r = evaluateOmaha(H('Ah Kh Qc Jd'), H('Th 9h 2h'));
    assert.equal(r.name, 'Flush, Ace high');
    assert.equal(evaluateOmaha(H('Ah Kd Qc 2d'), H('Jh Th 9s 3c')).name, 'Straight, King high');
    assert.equal(evaluateOmaha(H('Ah Kd Qc Jd'), H('Th 9h 2h 3c')).category, 0); // K-Q-J + T-9 would need 3 hole cards
  });

  test('scoreOmahaCodes matches evaluateOmaha; bad sizes', () => {
    const r = evaluateOmaha(H('Ah Kh Qc Jd'), H('Th 9h 2h 3c 4s'));
    assert.equal(scoreOmahaCodes(cardCodes(H('Ah Kh Qc Jd')), 4, cardCodes(H('Th 9h 2h 3c 4s')), 5), r.score);
    assert.equal(scoreOmahaCodes([1], 1, [2, 3, 4], 3), -1);
    assert.throws(() => evaluateOmaha(H('Ah Kh Qc Jd'), H('Th 9h')), RangeError);
    assert.throws(() => evaluateOmaha(H('Ah Kh Qc Jd'), H('Th 9h 2c 3c 4c 5c')), RangeError);
    assert.throws(() => evaluateOmaha(H('Ah'), H('Th 9h 2c')), RangeError);
    assert.throws(() => evaluateOmaha(H('Ah Kh Qc Jd'), H('Ah 9h 2c')), /Duplicate/);
  });
});

// ---------------------------------------------------------------------------------------------
// evaluator: API surface and validation
// ---------------------------------------------------------------------------------------------

describe('evaluator: API and validation', () => {
  test('evaluateFor dispatches', () => {
    const hole4 = H('Ah Kh Qh Jh');
    const board = H('2h 3c 4d 9s Tc');
    assert.deepEqual(evaluateFor('PLO', hole4, board), evaluateOmaha(hole4, board));
    assert.deepEqual(evaluateFor('NLH', H('Ah Kh'), board), evaluateHoldem(H('Ah Kh'), board));
    assert.deepEqual(evaluateFor('NLH', H('Ah Kh'), H('2h 3h 4h')), evaluate(H('Ah Kh 2h 3h 4h')));
    assert.throws(() => evaluateFor('Stud', H('Ah Kh'), board), TypeError);
  });

  test('evaluateHoldem with 3, 4 and 5 board cards', () => {
    assert.equal(evaluateHoldem(H('Ah Ad'), H('Ac 7s 2d')).name, 'Three Aces');
    assert.equal(evaluateHoldem(H('Ah Ad'), H('Ac 7s 2d 7h')).name, 'Full house, Aces full of Sevens');
    assert.equal(evaluateHoldem(H('Ah Ad'), H('Ac 7s 2d 7h As')).name, 'Four Aces');
  });

  test('rejects invalid input', () => {
    assert.throws(() => evaluate(H('Ah Ah Kc Qd Js')), /Duplicate/);
    assert.throws(() => evaluate(H('Ah Kh Qh Jh Th 9h 8h 7h')), RangeError);
    assert.throws(() => evaluate([]), RangeError);
    assert.throws(() => evaluate(['Ah', 'Kh', 'Qh', 'Jh', '10h']), TypeError);
    assert.throws(() => evaluate(['Ah', 'Kh', 'Qh', 'Jh', 'ah']), TypeError);
    assert.throws(() => evaluate('AhKhQhJhTh'), TypeError);
    assert.throws(() => evaluateHoldem('AhKh', []), TypeError);
    assert.throws(() => cardCode('Xx'), TypeError);
  });

  test('partial hands (<5 cards) are tolerated', () => {
    assert.equal(evaluate(H('Ah Ad')).name, 'Pair of Aces');
    assert.equal(evaluate(H('Ah Kd')).name, 'Ace high');
    assert.equal(evaluate(H('Ah Ad Ac 2c')).name, 'Three Aces');
    assert.equal(evaluate(H('Ah Ad Kc Kd')).name, 'Two pair, Aces and Kings');
    assert.deepEqual(evaluate(H('2h 3h 4h 5h')).best.length, 4);
  });

  test('card codes round-trip', () => {
    for (const c of fullDeck()) assert.equal(CARD_OF_CODE[cardCode(c)], c);
    assert.equal(new Set(fullDeck().map(cardCode)).size, 52);
  });
});

// ---------------------------------------------------------------------------------------------
// evaluator: exhaustive + randomized cross-checks against the reference
// ---------------------------------------------------------------------------------------------

describe('evaluator: cross-checks', () => {
  test('all 2,598,960 five-card hands: category census and 7,462 distinct ranks', () => {
    const counts = new Array(9).fill(0);
    const distinct = new Set();
    const a = [0, 0, 0, 0, 0];
    let royals = 0;
    for (let i = 0; i < 52; i++) for (let j = i + 1; j < 52; j++) for (let k = j + 1; k < 52; k++)
      for (let l = k + 1; l < 52; l++) for (let m = l + 1; m < 52; m++) {
        a[0] = i; a[1] = j; a[2] = k; a[3] = l; a[4] = m;
        const s = scoreCodes(a, 5);
        counts[s >> 20]++;
        distinct.add(s);
        if (s >> 20 === 8 && ((s >> 16) & 15) === 14) royals++;
      }
    assert.deepEqual(counts, [1302540, 1098240, 123552, 54912, 10200, 5108, 3744, 624, 40]);
    assert.equal(royals, 4);
    assert.equal(distinct.size, 7462);
  });

  test('random 5/6/7-card hands: exact score equals the reference (packed) value', () => {
    const rng = mulberry32(12345);
    let checks = 0;
    for (const n of [5, 6, 7]) {
      for (let t = 0; t < 4000; t++) {
        const cards = deal(rng, n);
        const r = evaluate(cards);
        const ref = refBest(cards);
        assert.equal(r.score, pack(ref), cards.join(' '));
        assert.equal(r.category, ref[0]);
        assert.equal(r.best.length, 5);
        assert.equal(new Set(r.best).size, 5);
        for (const c of r.best) assert.ok(cards.includes(c));
        assert.equal(pack(ref5(r.best)), r.score, 'best realizes the score');
        assert.equal(r.name, scoreName(r.score));
        checks++;
      }
    }
    assert.equal(checks, 12000);
  });

  test('random pairwise comparisons agree with the reference', () => {
    const rng = mulberry32(999);
    for (let t = 0; t < 5000; t++) {
      const d = shuffle(fullDeck(), rng);
      const board = d.slice(0, 5);
      const a = [d[5], d[6]];
      const b = [d[7], d[8]];
      const fa = evaluateHoldem(a, board).score;
      const fb = evaluateHoldem(b, board).score;
      assert.equal(sign(fa - fb), sign(cmp(refBest([...a, ...board]), refBest([...b, ...board]))));
    }
  });

  test('biased deals (many pairs/flushes/straights) agree with the reference', () => {
    // draw from a reduced deck to over-sample the rare categories
    const rng = mulberry32(2024);
    const small = fullDeck().filter((c) => '9TJQKA'.includes(c[0]) || c[1] === 'h');
    const seen = new Array(9).fill(0);
    for (let t = 0; t < 6000; t++) {
      const cards = shuffle(small, rng).slice(0, 7);
      const r = evaluate(cards);
      assert.equal(r.score, pack(refBest(cards)), cards.join(' '));
      seen[r.category]++;
    }
    for (let c = 1; c < 9; c++) assert.ok(seen[c] > 0, 'category ' + c + ' sampled');
  });

  test('random Omaha hands agree with the reference (3/4/5-card boards)', () => {
    const rng = mulberry32(77);
    for (const bn of [3, 4, 5]) {
      for (let t = 0; t < 1500; t++) {
        const d = shuffle(fullDeck(), rng);
        const hole = d.slice(0, 4);
        const board = d.slice(4, 4 + bn);
        const r = evaluateOmaha(hole, board);
        assert.equal(r.score, pack(refOmaha(hole, board)), hole.join(' ') + ' | ' + board.join(' '));
        // best = exactly 2 hole + 3 board
        assert.equal(r.best.filter((c) => hole.includes(c)).length, 2);
        assert.equal(r.best.filter((c) => board.includes(c)).length, 3);
        assert.equal(pack(ref5(r.best)), r.score);
      }
    }
  });

  test('Omaha flush-heavy deals agree with the reference', () => {
    const rng = mulberry32(31337);
    const small = fullDeck().filter((c) => c[1] === 'h' || c[1] === 's' || 'AK'.includes(c[0]));
    for (let t = 0; t < 2000; t++) {
      const d = shuffle(small, rng);
      const hole = d.slice(0, 4);
      const board = d.slice(4, 9);
      assert.equal(evaluateOmaha(hole, board).score, pack(refOmaha(hole, board)));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// performance (SPEC §3: ≥ 300k 7-card evaluations / sec)
// ---------------------------------------------------------------------------------------------

describe('evaluator: performance', () => {
  test('≥ 300k public 7-card evaluate() calls per second', (t) => {
    const rng = mulberry32(5);
    const hands = Array.from({ length: 1000 }, () => deal(rng, 7));
    for (let i = 0; i < 50000; i++) evaluate(hands[i % 1000]); // warm-up
    const N = 300000;
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < N; i++) x += evaluate(hands[i % 1000]).score;
    const ms = performance.now() - t0;
    const perSec = Math.round((N / ms) * 1000);
    assert.ok(x > 0);
    assert.ok(perSec >= 300000, `only ${perSec}/s`);
    t.diagnostic(`evaluate(): ${perSec.toLocaleString('en-US')} 7-card evals/sec`);
  });

  test('hot path scoreCodes() is several million per second', (t) => {
    const rng = mulberry32(6);
    const hands = Array.from({ length: 1000 }, () => cardCodes(deal(rng, 7)));
    for (let i = 0; i < 200000; i++) scoreCodes(hands[i % 1000], 7);
    const N = 2000000;
    const t0 = performance.now();
    let x = 0;
    for (let i = 0; i < N; i++) x += scoreCodes(hands[i % 1000], 7);
    const perSec = Math.round((N / (performance.now() - t0)) * 1000);
    assert.ok(x > 0);
    assert.ok(perSec >= 1000000, `only ${perSec}/s`);
    t.diagnostic(`scoreCodes(): ${perSec.toLocaleString('en-US')} 7-card evals/sec`);
  });
});

// ---------------------------------------------------------------------------------------------
// opt-in: exhaustive 7-card census (133,784,560 hands, ~15 s)
// ---------------------------------------------------------------------------------------------

test('all 133,784,560 seven-card hands: category census', { skip: !process.env.FELT_SLOW && 'set FELT_SLOW=1' }, () => {
  const counts = new Array(9).fill(0);
  const a = new Array(7).fill(0);
  for (let c0 = 0; c0 < 52; c0++) { a[0] = c0;
    for (let c1 = c0 + 1; c1 < 52; c1++) { a[1] = c1;
      for (let c2 = c1 + 1; c2 < 52; c2++) { a[2] = c2;
        for (let c3 = c2 + 1; c3 < 52; c3++) { a[3] = c3;
          for (let c4 = c3 + 1; c4 < 52; c4++) { a[4] = c4;
            for (let c5 = c4 + 1; c5 < 52; c5++) { a[5] = c5;
              for (let c6 = c5 + 1; c6 < 52; c6++) { a[6] = c6; counts[scoreCodes(a, 7) >> 20]++; } } } } } } }
  assert.deepEqual(counts, [23294460, 58627800, 31433400, 6461620, 6180020, 4047644, 3473184, 224848, 41584]);
});
