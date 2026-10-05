// lib/evaluator.js — poker hand evaluation (SPEC §3).
//
// PURE module (SPEC §0). Relative imports only.
//
// Approach: cards are mapped to integer codes (rank index 0..12 * 4 + suit index 0..3). A hand of
// 1..7 cards is scored in one pass that builds rank-multiplicity bitmasks (m1 = ranks seen ≥1×,
// m2 ≥2×, m3 ≥3×, m4 = 4×) and per-suit rank masks. Three small 8192-entry tables (≈ 50 KB total)
// answer "popcount", "highest straight in this rank mask" and "top five ranks of this mask".
//
// Score layout (an int < 2^24; higher wins, equal = tie):
//   category << 20 | r1 << 16 | r2 << 12 | r3 << 8 | r4 << 4 | r5
// where r1..r5 are rank values 2..14 in significance order for the category (0 = absent):
//   0 High card        r1..r5 = the five highest ranks
//   1 Pair             pair, k1, k2, k3
//   2 Two pair         high pair, low pair, kicker
//   3 Three of a kind  trips, k1, k2
//   4 Straight         top rank (5 for the wheel A-2-3-4-5)
//   5 Flush            five highest ranks of the flush suit
//   6 Full house       trips, pair
//   7 Four of a kind   quads, kicker
//   8 Straight flush   top rank (5 for the steel wheel; 14 = royal flush)

import { RANKS, SUITS } from './cards.js';

export const CATEGORY_NAMES = Object.freeze([
  'High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush',
]);

// Rank-value (2..14) → words.
const RANK_WORD = [null, 'Ace', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];
const RANK_PLURAL = [null, 'Aces', 'Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];

// ---------------------------------------------------------------------------------------------
// Card codes
// ---------------------------------------------------------------------------------------------

const CODE = Object.create(null); // 'As' → code
export const CARD_OF_CODE = Object.freeze(
  (() => {
    const out = new Array(52);
    for (let r = 0; r < 13; r++) {
      for (let s = 0; s < 4; s++) {
        const card = RANKS[r] + SUITS[s];
        const code = r * 4 + s;
        CODE[card] = code;
        out[code] = card;
      }
    }
    return out;
  })(),
);

/** Integer code 0..51 for a card string (rank index * 4 + suit index). Throws on an invalid card. */
export function cardCode(card) {
  const c = typeof card === 'string' ? CODE[card] : undefined;
  if (c === undefined) throw new TypeError('Invalid card: ' + String(card));
  return c;
}

/** Map card strings to codes; throws TypeError on invalid and Error on duplicate cards. */
export function cardCodes(cards) {
  if (!Array.isArray(cards)) throw new TypeError('cards must be an array');
  const out = new Array(cards.length);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < cards.length; i++) {
    const c = cardCode(cards[i]);
    if (c < 32) {
      const b = 1 << c;
      if (lo & b) throw new Error('Duplicate card: ' + cards[i]);
      lo |= b;
    } else {
      const b = 1 << (c - 32);
      if (hi & b) throw new Error('Duplicate card: ' + cards[i]);
      hi |= b;
    }
    out[i] = c;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tables (8192 entries each, indexed by a 13-bit rank mask; bit i = rank value i + 2)
// ---------------------------------------------------------------------------------------------

const POP = new Uint8Array(8192);
const STRAIGHT = new Uint8Array(8192); // top rank value (5..14) of the best straight, 0 = none
const HIGH5 = new Int32Array(8192); // top ≤5 rank values packed as nibbles, left-aligned in 20 bits

(() => {
  const WHEEL = 0x100f; // A,5,4,3,2
  for (let m = 0; m < 8192; m++) {
    let pop = 0;
    let packed = 0;
    let taken = 0;
    for (let b = 12; b >= 0; b--) {
      if (m & (1 << b)) {
        pop++;
        if (taken < 5) {
          packed |= (b + 2) << (16 - 4 * taken);
          taken++;
        }
      }
    }
    POP[m] = pop;
    HIGH5[m] = packed;
    let st = 0;
    for (let top = 12; top >= 4; top--) {
      const run = 0x1f << (top - 4);
      if ((m & run) === run) {
        st = top + 2;
        break;
      }
    }
    if (!st && (m & WHEEL) === WHEEL) st = 5;
    STRAIGHT[m] = st;
  }
})();

const C_PAIR = 1 << 20;
const C_TWO_PAIR = 2 << 20;
const C_TRIPS = 3 << 20;
const C_STRAIGHT = 4 << 20;
const C_FLUSH = 5 << 20;
const C_FULL = 6 << 20;
const C_QUADS = 7 << 20;
const C_SF = 8 << 20;

/**
 * Score the first `n` (1..7) card codes in `codes` as the best 5-card poker hand.
 * Hot path used by equity(); does no validation (codes must be distinct ints 0..51).
 */
export function scoreCodes(codes, n) {
  let m1 = 0, m2 = 0, m3 = 0, m4 = 0;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let i = 0; i < n; i++) {
    const c = codes[i];
    const bit = 1 << (c >> 2);
    switch (c & 3) {
      case 0: s0 |= bit; break;
      case 1: s1 |= bit; break;
      case 2: s2 |= bit; break;
      default: s3 |= bit;
    }
    if (m1 & bit) {
      if (m2 & bit) {
        if (m3 & bit) m4 |= bit;
        else m3 |= bit;
      } else m2 |= bit;
    } else m1 |= bit;
  }

  let fm = 0;
  if (n >= 5) {
    if (POP[s0] >= 5) fm = s0;
    else if (POP[s1] >= 5) fm = s1;
    else if (POP[s2] >= 5) fm = s2;
    else if (POP[s3] >= 5) fm = s3;
    if (fm) {
      const sf = STRAIGHT[fm];
      if (sf) return C_SF | (sf << 16);
    }
  }

  if (m4) {
    const q = 31 - Math.clz32(m4);
    return C_QUADS | ((q + 2) << 16) | ((HIGH5[m1 & ~(1 << q)] >> 4) & 0xf000);
  }

  let t = -1;
  if (m3) {
    t = 31 - Math.clz32(m3);
    const rest = m2 & ~(1 << t); // another trips or any pair
    if (rest) return C_FULL | ((t + 2) << 16) | ((33 - Math.clz32(rest)) << 12);
  }

  if (fm) return C_FLUSH | HIGH5[fm];

  const st = STRAIGHT[m1];
  if (st) return C_STRAIGHT | (st << 16);

  if (t >= 0) return C_TRIPS | ((t + 2) << 16) | ((HIGH5[m1 & ~(1 << t)] >> 4) & 0xff00);

  if (m2) {
    const h = 31 - Math.clz32(m2);
    const rest = m2 & ~(1 << h);
    if (rest) {
      const l = 31 - Math.clz32(rest);
      return C_TWO_PAIR | ((h + 2) << 16) | ((l + 2) << 12) | ((HIGH5[m1 & ~((1 << h) | (1 << l))] >> 8) & 0xf00);
    }
    return C_PAIR | ((h + 2) << 16) | ((HIGH5[m1 & ~(1 << h)] >> 4) & 0xfff0);
  }

  return HIGH5[m1];
}

/** Category 0..8 of a score. */
export function categoryOf(score) {
  return score >> 20;
}

/** Human-readable name of a score, e.g. "Full house, Kings full of Fours". */
export function scoreName(score) {
  const cat = score >> 20;
  const a = (score >> 16) & 15;
  const b = (score >> 12) & 15;
  switch (cat) {
    case 0: return RANK_WORD[a] + ' high';
    case 1: return 'Pair of ' + RANK_PLURAL[a];
    case 2: return 'Two pair, ' + RANK_PLURAL[a] + ' and ' + RANK_PLURAL[b];
    case 3: return 'Three ' + RANK_PLURAL[a];
    case 4: return 'Straight, ' + RANK_WORD[a] + ' high';
    case 5: return 'Flush, ' + RANK_WORD[a] + ' high';
    case 6: return 'Full house, ' + RANK_PLURAL[a] + ' full of ' + RANK_PLURAL[b];
    case 7: return 'Four ' + RANK_PLURAL[a];
    case 8: return a === 14 ? 'Royal flush' : 'Straight flush, ' + RANK_WORD[a] + ' high';
    default: throw new RangeError('Invalid score: ' + score);
  }
}

// ---------------------------------------------------------------------------------------------
// Result construction (only for public calls — not in the equity hot path)
// ---------------------------------------------------------------------------------------------

function straightRanks(top) {
  return top === 5 ? [5, 4, 3, 2, 14] : [top, top - 1, top - 2, top - 3, top - 4];
}

function flushSuit(codes, n) {
  const cnt = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) cnt[codes[i] & 3]++;
  for (let s = 0; s < 4; s++) if (cnt[s] >= 5) return s;
  return -1;
}

// Pick the cards realizing `score` from cards/codes; returns them in significance order.
function bestCards(score, cards, codes, n) {
  const cat = score >> 20;
  const r = [(score >> 16) & 15, (score >> 12) & 15, (score >> 8) & 15, (score >> 4) & 15, score & 15];
  let need; // list of rank values, repeated by multiplicity
  let suit = -1;
  switch (cat) {
    case 8: need = straightRanks(r[0]); suit = flushSuit(codes, n); break;
    case 7: need = [r[0], r[0], r[0], r[0], r[1]]; break;
    case 6: need = [r[0], r[0], r[0], r[1], r[1]]; break;
    case 5: need = r; suit = flushSuit(codes, n); break;
    case 4: need = straightRanks(r[0]); break;
    case 3: need = [r[0], r[0], r[0], r[1], r[2]]; break;
    case 2: need = [r[0], r[0], r[1], r[1], r[2]]; break;
    case 1: need = [r[0], r[0], r[1], r[2], r[3]]; break;
    default: need = r;
  }
  const used = new Array(n).fill(false);
  const best = [];
  for (const rv of need) {
    if (!rv) continue; // absent kicker (fewer than 5 cards)
    const ri = rv - 2;
    for (let i = 0; i < n; i++) {
      if (!used[i] && codes[i] >> 2 === ri && (suit < 0 || (codes[i] & 3) === suit)) {
        used[i] = true;
        best.push(cards[i]);
        break;
      }
    }
  }
  return best;
}

function result(score, cards, codes, n) {
  return { score, category: score >> 20, name: scoreName(score), best: bestCards(score, cards, codes, n) };
}

// ---------------------------------------------------------------------------------------------
// Public API (SPEC §3)
// ---------------------------------------------------------------------------------------------

/**
 * Best 5-card hand from 5..7 cards → { score, category, name, best }.
 * Leniency: 1..4 cards are also accepted (a partial hand — no straights/flushes; `best` holds
 * the cards that count, fewer than 5). Throws on invalid/duplicate cards or more than 7 cards.
 */
export function evaluate(cards) {
  const codes = cardCodes(cards);
  const n = codes.length;
  if (n < 1 || n > 7) throw new RangeError('evaluate: expected 5 to 7 cards, got ' + n);
  return result(scoreCodes(codes, n), cards, codes, n);
}

/** Hold'em: best 5 of hole (2) + board (3..5). */
export function evaluateHoldem(hole, board) {
  if (!Array.isArray(hole) || !Array.isArray(board)) throw new TypeError('evaluateHoldem: hole and board must be arrays');
  return evaluate(hole.concat(board));
}

// All index pairs / triples, precomputed per size.
const COMBOS = Object.create(null);
function combos(n, k) {
  const key = n * 10 + k;
  let list = COMBOS[key];
  if (list) return list;
  list = [];
  const rec = (start, acc) => {
    if (acc.length === k) { list.push(acc.slice()); return; }
    for (let i = start; i < n; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  COMBOS[key] = list;
  return list;
}

const OMAHA_SCRATCH = [0, 0, 0, 0, 0];

/**
 * Omaha hot path: best score using exactly 2 of the first `hn` hole codes and exactly 3 of the
 * first `bn` board codes. Returns -1 if impossible (hn < 2 or bn < 3).
 */
export function scoreOmahaCodes(holeCodes, hn, boardCodes, bn) {
  if (hn < 2 || bn < 3) return -1;
  const hp = combos(hn, 2);
  const bt = combos(bn, 3);
  const s = OMAHA_SCRATCH;
  let best = -1;
  for (let j = 0; j < bt.length; j++) {
    const t = bt[j];
    s[2] = boardCodes[t[0]];
    s[3] = boardCodes[t[1]];
    s[4] = boardCodes[t[2]];
    for (let i = 0; i < hp.length; i++) {
      const p = hp[i];
      s[0] = holeCodes[p[0]];
      s[1] = holeCodes[p[1]];
      const sc = scoreCodes(s, 5);
      if (sc > best) best = sc;
    }
  }
  return best;
}

/**
 * Omaha: best hand using EXACTLY 2 hole cards + EXACTLY 3 board cards.
 * hole: 4 cards (any count ≥ 2 accepted), board: 3..5 cards.
 */
export function evaluateOmaha(hole, board) {
  if (!Array.isArray(hole) || !Array.isArray(board)) throw new TypeError('evaluateOmaha: hole and board must be arrays');
  if (hole.length < 2) throw new RangeError('evaluateOmaha: need at least 2 hole cards');
  if (board.length < 3 || board.length > 5) throw new RangeError('evaluateOmaha: board must have 3 to 5 cards');
  const all = cardCodes(hole.concat(board)); // validates + rejects duplicates across hole/board
  const hc = all.slice(0, hole.length);
  const bc = all.slice(hole.length);
  const hp = combos(hc.length, 2);
  const bt = combos(bc.length, 3);
  let bestScore = -1;
  let bestPick = null;
  const s = [0, 0, 0, 0, 0];
  for (const t of bt) {
    for (const p of hp) {
      s[0] = hc[p[0]]; s[1] = hc[p[1]]; s[2] = bc[t[0]]; s[3] = bc[t[1]]; s[4] = bc[t[2]];
      const sc = scoreCodes(s, 5);
      if (sc > bestScore) { bestScore = sc; bestPick = [p, t]; }
    }
  }
  const [p, t] = bestPick;
  const cards5 = [hole[p[0]], hole[p[1]], board[t[0]], board[t[1]], board[t[2]]];
  const codes5 = [hc[p[0]], hc[p[1]], bc[t[0]], bc[t[1]], bc[t[2]]];
  return result(bestScore, cards5, codes5, 5);
}

/** Dispatch on variant: 'NLH' → evaluateHoldem, 'PLO' → evaluateOmaha. */
export function evaluateFor(variant, hole, board) {
  if (variant === 'PLO') return evaluateOmaha(hole, board);
  if (variant === 'NLH') return evaluateHoldem(hole, board);
  throw new TypeError('Unknown variant: ' + String(variant));
}
