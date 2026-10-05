// lib/cards.js — deck, card helpers, rng shuffle.
//
// PURE module (SPEC §0): no platform imports, no Date.now / Math.random.
// A card is a 2-char string: rank from RANKS + suit from SUITS, e.g. 'As', 'Td', '9h', '2c'.

export const RANKS = Object.freeze(['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']);
export const SUITS = Object.freeze(['s', 'h', 'd', 'c']);

const RANK_VALUE = Object.freeze({ 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 });
const SUIT_SET = Object.freeze({ s: true, h: true, d: true, c: true });

/** All 52 cards, ordered by suit (s, h, d, c) then rank (2..A). Always a fresh array. */
export function fullDeck() {
  const deck = new Array(52);
  let i = 0;
  for (const s of SUITS) for (const r of RANKS) deck[i++] = r + s;
  return deck;
}

/** True iff `card` is a valid 2-char card string. */
export function isCard(card) {
  return typeof card === 'string' && card.length === 2 && RANK_VALUE[card[0]] !== undefined && SUIT_SET[card[1]] === true;
}

/** Rank value 2..14 (T=10, J=11, Q=12, K=13, A=14). Throws on an invalid card. */
export function rankOf(card) {
  if (!isCard(card)) throw new TypeError('Invalid card: ' + String(card));
  return RANK_VALUE[card[0]];
}

/** Suit letter 's' | 'h' | 'd' | 'c'. Throws on an invalid card. */
export function suitOf(card) {
  if (!isCard(card)) throw new TypeError('Invalid card: ' + String(card));
  return card[1];
}

/**
 * Fisher–Yates shuffle driven by `rng()` ∈ [0, 1). Returns a NEW array; `arr` is not modified.
 * Out-of-range rng outputs (e.g. exactly 1) are clamped so the result is always a permutation.
 */
export function shuffle(arr, rng) {
  if (typeof rng !== 'function') throw new TypeError('shuffle: rng must be a function');
  const a = Array.from(arr);
  for (let i = a.length - 1; i > 0; i--) {
    let j = Math.floor(rng() * (i + 1));
    if (!(j >= 0)) j = 0; // NaN / negative guard
    else if (j > i) j = i;
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

/**
 * Cryptographically secure rng: returns a function producing uniform doubles in [0, 1)
 * with 53 bits of randomness, backed by the global WebCrypto `crypto.getRandomValues`
 * (available in V8 isolates and Node >= 19; no node imports). Values are buffered.
 */
export function cryptoRng() {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('cryptoRng: globalThis.crypto.getRandomValues is not available');
  }
  const BUF = 512; // 32-bit words per refill (two words per output)
  const buf = new Uint32Array(BUF);
  let pos = BUF;
  return function rng() {
    if (pos >= BUF) {
      c.getRandomValues(buf);
      pos = 0;
    }
    const hi = buf[pos++] >>> 5; // 27 bits
    const lo = buf[pos++] >>> 6; // 26 bits
    return (hi * 67108864 + lo) / 9007199254740992; // / 2^53
  };
}
