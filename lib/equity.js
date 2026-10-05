// lib/equity.js — win probability (SPEC §4).
//
// PURE module (SPEC §0): randomness comes from the caller's `rng`. Relative imports only.
//
// equity({ variant, hands: { [pid]: string[] }, board, dead, rng, iterations? }) → { [pid]: number }
//   Win share 0..100 per player (ties split equally: a two-way tie adds 0.5 to each). Unrounded;
//   the caller rounds for display. Exact enumeration of every possible completion when ≤ 2 board
//   cards are to come; Monte Carlo (default 4000 Hold'em / 1500 Omaha iterations) when 3–5 are.
//
// `dead` cards are removed from the stub (e.g. cards already used on other run-it-twice boards).
// Dead cards that also appear in a hand or on the board are tolerated (run boards share a prefix
// with the board); a card appearing twice among hands + board is an error.

import { cardCode, scoreCodes, scoreOmahaCodes } from './evaluator.js';

export const DEFAULT_ITERATIONS = Object.freeze({ NLH: 4000, PLO: 1500 });

// Deterministic fallback PRNG (mulberry32) used only if the caller passes no rng for a Monte Carlo
// run — keeps the module pure and reproducible. Callers should always pass ctx.rng.
function fallbackRng() {
  let a = 0x9e3779b9;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function equity({ variant = 'NLH', hands, board = [], dead = [], rng, iterations } = {}) {
  if (variant !== 'NLH' && variant !== 'PLO') throw new TypeError('equity: unknown variant ' + String(variant));
  if (!hands || typeof hands !== 'object') throw new TypeError('equity: hands must be an object');
  if (!Array.isArray(board) || board.length > 5) throw new RangeError('equity: board must be an array of 0..5 cards');
  if (!Array.isArray(dead)) throw new TypeError('equity: dead must be an array');
  const omaha = variant === 'PLO';

  const pids = Object.keys(hands);
  const n = pids.length;
  if (n === 0) return {};

  // ---- validate + collect used cards -------------------------------------------------------
  const used = new Uint8Array(52);
  const take = (card) => {
    const c = cardCode(card);
    if (used[c]) throw new Error('equity: duplicate card ' + card);
    used[c] = 1;
    return c;
  };
  const holes = new Array(n);
  for (let i = 0; i < n; i++) {
    const h = hands[pids[i]];
    if (!Array.isArray(h)) throw new TypeError('equity: hand for ' + pids[i] + ' must be an array');
    if (omaha ? h.length < 2 || h.length > 6 : h.length !== 2) {
      throw new RangeError('equity: bad hole card count for ' + pids[i] + ' (' + h.length + ')');
    }
    holes[i] = h.map(take);
  }
  const boardCodes = board.map(take);
  for (const card of dead) used[cardCode(card)] = 1;

  const out = {};
  if (n === 1) {
    out[pids[0]] = 100;
    return out;
  }

  const stub = [];
  for (let c = 0; c < 52; c++) if (!used[c]) stub.push(c);
  const bLen = boardCodes.length;
  const toCome = 5 - bLen;
  if (stub.length < toCome) throw new RangeError('equity: not enough live cards to complete the board');

  // ---- per-board showdown ------------------------------------------------------------------
  const wins = new Float64Array(n);
  const scores = new Int32Array(n);
  const full = new Array(5); // the 5-card board being evaluated
  for (let i = 0; i < bLen; i++) full[i] = boardCodes[i];
  // Hold'em: one 7-card scratch array per hand with the hole cards fixed in slots 0..1.
  const seven = omaha ? null : holes.map((h) => [h[0], h[1], 0, 0, 0, 0, 0]);

  const showdown = () => {
    let best = -1;
    let cnt = 0;
    for (let i = 0; i < n; i++) {
      let sc;
      if (omaha) {
        sc = scoreOmahaCodes(holes[i], holes[i].length, full, 5);
      } else {
        const a = seven[i];
        a[2] = full[0]; a[3] = full[1]; a[4] = full[2]; a[5] = full[3]; a[6] = full[4];
        sc = scoreCodes(a, 7);
      }
      scores[i] = sc;
      if (sc > best) { best = sc; cnt = 1; } else if (sc === best) cnt++;
    }
    if (cnt === 1) {
      for (let i = 0; i < n; i++) if (scores[i] === best) { wins[i] += 1; break; }
    } else {
      const share = 1 / cnt;
      for (let i = 0; i < n; i++) if (scores[i] === best) wins[i] += share;
    }
  };

  let total = 0;
  if (toCome === 0) {
    showdown();
    total = 1;
  } else if (toCome <= 2) {
    // exact enumeration of every completion
    const m = stub.length;
    if (toCome === 1) {
      for (let a = 0; a < m; a++) { full[bLen] = stub[a]; showdown(); total++; }
    } else {
      for (let a = 0; a < m - 1; a++) {
        full[bLen] = stub[a];
        for (let b = a + 1; b < m; b++) { full[bLen + 1] = stub[b]; showdown(); total++; }
      }
    }
  } else {
    // Monte Carlo: partial Fisher–Yates draw of `toCome` cards per iteration
    const r = typeof rng === 'function' ? rng : fallbackRng();
    let iters = iterations === undefined || iterations === null ? DEFAULT_ITERATIONS[variant] : Math.floor(Number(iterations));
    if (!(iters >= 1)) iters = DEFAULT_ITERATIONS[variant];
    const m = stub.length;
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < toCome; k++) {
        let j = k + Math.floor(r() * (m - k));
        if (j >= m) j = m - 1;
        const tmp = stub[k]; stub[k] = stub[j]; stub[j] = tmp;
        full[bLen + k] = stub[k];
      }
      showdown();
    }
    total = iters;
  }

  for (let i = 0; i < n; i++) out[pids[i]] = (wins[i] / total) * 100;
  return out;
}
