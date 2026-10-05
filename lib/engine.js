// lib/engine.js — Felt's poker game state machine (SPEC §5–§8).
//
// PURE module (SPEC §0): no platform imports, no Date.now / Math.random. Time and randomness are
// passed in as ctx = { now: ms, rng: () => number in [0, 1) }. Every exported mutator changes
// `state` in place; invalid input throws EngineError(message, code) BEFORE anything is mutated
// (validate first, then mutate). Messages are shown to players as toasts, so they are written
// for humans.
//
// Time model: there is exactly one pending timer (state.deadline / state.deadlineKind). Nothing
// runs in the background: tick(state, ctx) is called lazily (by a client whose timer fired, by
// GET /api/state, and at the start of every apply()) and processes EVERY elapsed deadline in
// order. Follow-up deadlines inside a hand are chained from the moment the previous one was DUE
// (not from when the late tick arrived), so a late tick catches up exactly — e.g. several runout
// steps at once. A new hand is always dealt at the real `now`, so a room nobody was watching
// does not fast-forward through hands of timeouts.

import { fullDeck, shuffle } from './cards.js';
import { evaluateFor } from './evaluator.js';
import { equity as computeEquity } from './equity.js';

// ─── public constants ────────────────────────────────────────────────────────

export class EngineError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'EngineError';
    this.code = code; // 'bad_request' | 'forbidden' | 'not_your_turn' | 'conflict' | 'not_found'
  }
}

export const DEFAULT_SETTINGS = Object.freeze({
  variant: 'NLH',
  sb: 1,
  bb: 2,
  seats: 8,
  minBuyIn: 100,
  maxBuyIn: 400,
  approveBuyIns: true,
  maxRuns: 2,
  revealRunout: 'anyone',
  showdownLosers: 'choose',
  actionTime: 25,
  nextHandDelay: 8,
  autoAwayTimeouts: 2,
});

/** Timer lengths in ms (SPEC §6). */
export const TIMING = Object.freeze({
  startDelay: 3000, // no hand running and one becomes startable → deal after this
  ritVote: 12000, // run-it-N-times vote window
  runoutStep: 1800, // between all-in runout streets
  extraRun: 1500, // added to the next-hand delay per additional run
});

export const LIMITS = Object.freeze({
  maxPlayers: 30,
  nameMax: 20,
  gameNameMax: 40,
  chatMax: 280,
  chatKeep: 60,
  reasonMax: 40,
  maxChips: 1_000_000_000,
});

const MAX_TICK_STEPS = 1000; // hard stop for a single tick (each step is a real transition)
const SEAT_RING = 64; // > any seat index; makes clockwise-distance arithmetic trivial

const VARIANTS = ['NLH', 'PLO'];
const REVEAL_MODES = ['anyone', 'winner', 'host', 'off'];
const LOSER_MODES = ['choose', 'show'];
const STREET_AT = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' };
const STREET_LABEL = { flop: 'Flop', turn: 'Turn', river: 'River' };
const AUTO_SUFFIX = { timeout: ' (timed out)', away: ' (away)', left: ' (left the table)', removed: ' (removed by host)' };

const HOST_ONLY = new Set([
  'approve', 'deny', 'adjust', 'setAway', 'remove', 'settings', 'pause', 'markPaid', 'endGame', 'transferHost',
]);
const ALLOWED_WHEN_ENDED = new Set(['tick', 'chat', 'markPaid']);

// ─── small helpers ───────────────────────────────────────────────────────────

const badRequest = (m) => new EngineError(m, 'bad_request');
const forbidden = (m) => new EngineError(m, 'forbidden');
const conflict = (m) => new EngineError(m, 'conflict');
const notFound = (m) => new EngineError(m, 'not_found');

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** 1234567 → '1,234,567' (no Intl dependency). */
function fmt(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Integer from a number or a plain integer string; NaN otherwise (no silent rounding). */
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*-?\d{1,15}\s*$/.test(v)) return Number(v);
  return NaN;
}

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

/** Strip control / bidi characters, collapse whitespace, trim; enforce 1..max code points. */
function cleanText(raw, max, label) {
  if (typeof raw !== 'string') throw badRequest(`${label} is required.`);
  const s = raw
    .replace(/[\u0000-\u001f\u007f​‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const len = [...s].length;
  if (len < 1) throw badRequest(`${label} is required.`);
  if (len > max) throw badRequest(`${label} must be at most ${max} characters.`);
  return s;
}

function requireCtx(ctx) {
  if (!ctx || !Number.isFinite(ctx.now)) throw new TypeError('engine: ctx.now (ms) is required');
  return ctx.now;
}

function nextId(state) {
  state.seq = (state.seq || 0) + 1;
  return state.seq;
}

function setDeadline(state, at, kind) {
  state.deadline = at;
  state.deadlineKind = kind;
}

function clearDeadline(state) {
  state.deadline = null;
  state.deadlineKind = null;
}

/** Clockwise steps from seat `from` to seat `to` (0 when equal). */
const cw = (from, to) => (((to - from) % SEAT_RING) + SEAT_RING) % SEAT_RING;

/** First seat of ascending `seats` strictly clockwise after `from` (the lowest seat if from is null). */
function seatAfter(seats, from) {
  if (from == null) return seats[0];
  for (const s of seats) if (s > from) return s;
  return seats[0];
}

function playersBySeat(state) {
  return Object.values(state.players).sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99) || a.joinedAt - b.joinedAt);
}

function playerAtSeat(state, seat) {
  for (const p of Object.values(state.players)) if (p.seat === seat) return p;
  return null;
}

/** pid holding a pending 'sit' request for `seat` (other than `exceptPid`), or null. */
export function seatReservedBy(state, seat, exceptPid = null) {
  for (const r of state.requests) if (r.kind === 'sit' && r.seat === seat && r.pid !== exceptPid) return r.pid;
  return null;
}

/** Lowest free seat, preferring seats nobody else has asked for; null when the table is full. */
function freeSeatFor(state, pid) {
  let fallback = null;
  for (let s = 0; s < state.settings.seats; s++) {
    if (playerAtSeat(state, s)) continue;
    if (!seatReservedBy(state, s, pid)) return s;
    if (fallback === null) fallback = s;
  }
  return fallback;
}

function requestOf(state, pid) {
  return state.requests.find((r) => r.pid === pid) || null;
}

function findRequest(state, id) {
  const r = state.requests.find((x) => String(x.id) === String(id));
  if (!r) throw notFound('That request is no longer pending.');
  return r;
}

function targetPlayer(state, pid) {
  if (typeof pid !== 'string' || !hasOwn(state.players, pid)) throw notFound('That player isn’t in this game.');
  return state.players[pid];
}

/** Non-folded pids in hand order (clockwise from the seat left of the button). */
function liveIds(hand) {
  return hand.order.filter((pid) => !hand.ps[pid].folded);
}

function addLog(hand, pid, text, amount = null, extra = null) {
  const e = { street: hand.street, pid: pid ?? null, text, amount: amount ?? null };
  if (extra) Object.assign(e, extra);
  hand.log.push(e);
}

function commit(player, ps, amount) {
  player.stack -= amount;
  ps.bet += amount;
  ps.committed += amount;
}

// ─── settings ────────────────────────────────────────────────────────────────

/**
 * Merge `partial` over `base` (defaults when absent) and validate. Out-of-range timers / counts are
 * clamped; nonsense (bad enums, non-integer chips, sb > bb, min > max) throws EngineError.
 * Unknown keys are ignored; null / undefined / '' values mean "unchanged".
 */
export function sanitizeSettings(partial, base) {
  if (partial == null) partial = {};
  if (typeof partial !== 'object' || Array.isArray(partial)) throw badRequest('Settings must be an object.');
  const out = { ...DEFAULT_SETTINGS };
  if (base && typeof base === 'object') {
    for (const k of Object.keys(DEFAULT_SETTINGS)) if (base[k] !== undefined && base[k] !== null) out[k] = base[k];
  }
  const given = (k) => hasOwn(partial, k) && partial[k] !== undefined && partial[k] !== null && partial[k] !== '';

  if (given('variant')) {
    const v = String(partial.variant).trim().toUpperCase();
    if (!VARIANTS.includes(v)) throw badRequest('The game must be No-Limit Hold’em (NLH) or Pot-Limit Omaha (PLO).');
    out.variant = v;
  }
  const chips = (k, label) => {
    if (!given(k)) return;
    const n = toInt(partial[k]);
    if (!Number.isInteger(n)) throw badRequest(`${label} must be a whole number of chips.`);
    if (n < 1) throw badRequest(`${label} must be at least 1.`);
    if (n > LIMITS.maxChips) throw badRequest(`${label} is too large.`);
    out[k] = n;
  };
  chips('sb', 'The small blind');
  chips('bb', 'The big blind');
  chips('minBuyIn', 'The minimum buy-in');
  chips('maxBuyIn', 'The maximum buy-in');
  const ranged = (k, label, lo, hi) => {
    if (!given(k)) return;
    const n = toNum(partial[k]);
    if (!Number.isFinite(n)) throw badRequest(`${label} must be a number.`);
    out[k] = clamp(Math.round(n), lo, hi);
  };
  ranged('seats', 'Seats', 2, 9);
  ranged('maxRuns', 'Run it more than once', 1, 3);
  ranged('actionTime', 'The action timer', 10, 120);
  ranged('nextHandDelay', 'The time between hands', 3, 30);
  ranged('autoAwayTimeouts', 'Auto-away after timeouts', 0, 10);
  if (given('approveBuyIns')) {
    const v = partial.approveBuyIns;
    if (typeof v === 'boolean') out.approveBuyIns = v;
    else if (v === 'true' || v === 'false') out.approveBuyIns = v === 'true';
    else throw badRequest('“Approve buy-ins” must be on or off.');
  }
  if (given('revealRunout')) {
    const v = String(partial.revealRunout).trim().toLowerCase();
    if (!REVEAL_MODES.includes(v)) throw badRequest('Who can reveal the runout must be anyone, the winner, the host, or off.');
    out.revealRunout = v;
  }
  if (given('showdownLosers')) {
    const v = String(partial.showdownLosers).trim().toLowerCase();
    if (!LOSER_MODES.includes(v)) throw badRequest('Losing hands at showdown must be “choose” or “show”.');
    out.showdownLosers = v;
  }
  if (out.bb < out.sb) throw badRequest('The big blind can’t be smaller than the small blind.');
  if (out.minBuyIn > out.maxBuyIn) throw badRequest('The minimum buy-in can’t be more than the maximum.');
  return out;
}

// ─── room + players ──────────────────────────────────────────────────────────

function newPlayer(id, name, tokenHash, now) {
  return {
    id,
    name,
    tokenHash: tokenHash ?? null,
    seat: null,
    stack: 0,
    away: false,
    awayBy: null,
    waitForBB: false,
    timeouts: 0,
    leaveAfterHand: false,
    awayAfterHand: false,
    pendingChips: 0,
    joinedAt: now,
    leaveBy: null, // server-only: host pid when the host removed them (deferred to hand end)
  };
}

export function createRoom({ code, name, hostName, hostId, hostTokenHash, settings } = {}, ctx) {
  const now = requireCtx(ctx);
  if (typeof code !== 'string' || !code.trim()) throw badRequest('Missing room code.');
  if (typeof hostId !== 'string' || !hostId) throw badRequest('Missing host id.');
  const host = cleanText(hostName, LIMITS.nameMax, 'Your name');
  const game =
    typeof name === 'string' && name.trim() ? cleanText(name, LIMITS.gameNameMax, 'The game name') : 'Home Game';
  const s = sanitizeSettings(settings, DEFAULT_SETTINGS);
  const state = {
    schema: 1,
    code,
    name: game,
    createdAt: now,
    hostId,
    settings: s,
    players: {},
    requests: [],
    pendingAdjust: [],
    ledger: [],
    paid: {},
    chat: [],
    handNo: 0,
    button: null,
    paused: false,
    pauseAfterHand: false,
    ended: false,
    endAfterHand: false,
    hand: null,
    lastHand: null,
    deadline: null,
    deadlineKind: null,
    seq: 0,
  };
  state.players[hostId] = newPlayer(hostId, host, hostTokenHash, now);
  return state;
}

export function addPlayer(state, { id, name, tokenHash } = {}, ctx) {
  const now = requireCtx(ctx);
  if (typeof id !== 'string' || !id) throw badRequest('Missing player id.');
  if (hasOwn(state.players, id)) throw conflict('That player has already joined.');
  if (Object.keys(state.players).length >= LIMITS.maxPlayers) {
    throw conflict(`This game is full (${LIMITS.maxPlayers} players).`);
  }
  const player = newPlayer(id, cleanText(name, LIMITS.nameMax, 'Your name'), tokenHash, now);
  state.players[id] = player;
  return player;
}

// ─── queries shared with lib/view.js ─────────────────────────────────────────

/** Σ committed this hand, including the current street's bets. */
export function potTotal(hand) {
  if (!hand) return 0;
  let t = 0;
  for (const pid of hand.order) t += hand.ps[pid].committed;
  return t;
}

/** The board the hand is currently showing: the current run's board during/after a runout. */
export function displayBoard(hand) {
  if (!hand) return [];
  if (hand.runBoards && hand.runBoards.length) {
    return hand.runBoards[Math.min(hand.currentRun || 0, hand.runBoards.length - 1)];
  }
  return hand.board;
}

/**
 * Legal moves for `pid` right now, or null when it isn't their turn.
 * → { fold, check, call (chips to call, capped at stack; 0 if none), raise (bool), minTo, maxTo, potTo }
 * minTo/maxTo/potTo are "raise to" totals for this street (0 when raising isn't allowed).
 * potTo is the pot-sized raise (the PLO cap; a preset for NLH), clamped into [minTo, maxTo].
 */
export function legalActions(state, pid) {
  const hand = state && state.hand;
  if (!hand || hand.phase !== 'betting' || !pid || hand.toAct !== pid) return null;
  const h = hand.ps[pid];
  const p = state.players[pid];
  if (!h || !p || h.folded || h.allIn) return null;
  const toCall = Math.max(0, hand.currentBet - h.bet);
  const allInTo = h.bet + p.stack;
  const othersCanAct = hand.order.some((q) => q !== pid && !hand.ps[q].folded && !hand.ps[q].allIn);
  const raise = othersCanAct && !h.raiseLocked && allInTo > hand.currentBet;
  let minTo = 0;
  let maxTo = 0;
  let potTo = 0;
  if (raise) {
    minTo = hand.currentBet + hand.minRaise; // opening bet: currentBet 0 + minRaise (= bb) → bb
    potTo = hand.currentBet + potTotal(hand) + toCall;
    maxTo = hand.variant === 'PLO' ? Math.min(allInTo, Math.max(potTo, minTo)) : allInTo;
    if (allInTo < minTo) {
      // all-in for less than a full raise is the only raise available
      minTo = allInTo;
      maxTo = allInTo;
    }
    potTo = clamp(potTo, minTo, maxTo);
  }
  return { fold: true, check: toCall === 0, call: Math.min(toCall, p.stack), raise, minTo, maxTo, potTo };
}

/** True when `pid` may still show cards: hand complete, they were dealt in, something is hidden. */
export function canShow(state, pid) {
  const hand = state && state.hand;
  if (!hand || hand.phase !== 'complete' || state.ended || !pid) return false;
  const h = hand.ps[pid];
  return !!h && h.shown.some((s) => !s);
}

function revealRunoutProblem(state, pid) {
  const hand = state.hand;
  if (!hand || hand.phase !== 'complete' || !hand.results) return conflict('There’s no finished hand to reveal.');
  if (hand.results.endedBy !== 'fold') return conflict('Only a hand that ended with everyone folding has a runout to reveal.');
  if (hand.board.length >= 5) return conflict('The whole board was already dealt.');
  if (hand.runout) return conflict('The runout has already been revealed.');
  if (!pid || !hasOwn(state.players, pid)) return forbidden('Join this game first.');
  const mode = state.settings.revealRunout;
  if (mode === 'off') return forbidden('Revealing the runout is turned off for this game.');
  if (mode === 'host' && pid !== state.hostId) return forbidden('Only the host can reveal the runout.');
  if (mode === 'winner' && !(hand.results.winners || []).includes(pid)) {
    return forbidden('Only the winner can reveal the runout.');
  }
  return null;
}

export function canRevealRunout(state, pid) {
  return !!(state && state.hand) && !revealRunoutProblem(state, pid);
}

/** True when a new hand could be dealt right now (enough eligible players, not paused/ended). */
export function canStartHand(state) {
  return !state.hand && !!lineup(state);
}

// ─── apply / tick ────────────────────────────────────────────────────────────

/**
 * Perform `action` ({ type, ...args }, SPEC §8) for player `pid` (null only for 'tick').
 * Runs tick() first so stale deadlines are processed before the action, then the action, then
 * advance() (auto-actions for away players, vote shortcuts, scheduling).
 */
export function apply(state, pid, action, ctx) {
  requireCtx(ctx);
  const type = action && typeof action === 'object' ? action.type : undefined;
  const handler = typeof type === 'string' && hasOwn(HANDLERS, type) ? HANDLERS[type] : null;
  if (!handler) throw badRequest('Unknown action.');
  tick(state, ctx);
  if (type === 'tick') return;
  if (pid == null || !hasOwn(state.players, pid)) throw forbidden('Join this game first.');
  if (state.ended && !ALLOWED_WHEN_ENDED.has(type)) throw conflict('This game has ended.');
  if (HOST_ONLY.has(type) && pid !== state.hostId) throw forbidden('Only the host can do that.');
  handler(state, pid, action, ctx);
  advance(state, ctx);
}

/** Process every elapsed deadline in order. Returns true if anything changed. */
export function tick(state, ctx) {
  requireCtx(ctx);
  let changed = false;
  for (let i = 0; i < MAX_TICK_STEPS; i++) {
    if (state.deadline == null || !(state.deadline <= ctx.now)) break;
    const due = state.deadline;
    const kind = state.deadlineKind;
    clearDeadline(state);
    // Inside a hand, transitions happen "when they were due" so follow-ups chain correctly.
    // A new hand is dealt at the real time (see the header comment).
    const at = { now: kind === 'nextHand' ? ctx.now : due, rng: ctx.rng };
    fireDeadline(state, kind, at);
    advance(state, at, false);
    changed = true;
  }
  if (changed) refreshEquity(state, ctx);
  return changed;
}

function fireDeadline(state, kind, ctx) {
  const hand = state.hand;
  switch (kind) {
    case 'action':
      if (hand && hand.phase === 'betting' && hand.toAct) actionTimeout(state, ctx, hand.toAct);
      break;
    case 'ritVote':
      if (hand && hand.phase === 'ritVote') closeVote(state, ctx);
      break;
    case 'runout':
      if (hand && hand.phase === 'runout') runoutStep(state, ctx);
      break;
    case 'nextHand':
      if (!hand) startNextHand(state, ctx);
      else if (hand.phase === 'complete') finishHand(state, ctx);
      break;
    default:
      break;
  }
}

/**
 * Bring the state to rest after any change: auto-act away players whose turn it is, auto-vote
 * "once" for away voters and close a vote that is complete, make sure the hand has its timer,
 * schedule / cancel the next-hand timer when no hand is running.
 */
function advance(state, ctx, withEquity = true) {
  for (let guard = 0; guard < 500; guard++) {
    const hand = state.hand;
    if (!hand) break;
    if (hand.phase === 'betting' && hand.toAct) {
      const p = state.players[hand.toAct];
      if (!p || p.away || p.seat == null) {
        autoAct(state, ctx, hand.toAct, 'away');
        continue;
      }
      break;
    }
    if (hand.phase === 'ritVote') {
      for (const v of hand.ritVoters) {
        const p = state.players[v];
        if (hand.ritVotes[v] == null && (!p || p.away)) hand.ritVotes[v] = 1;
      }
      if (hand.ritVoters.every((v) => hand.ritVotes[v] != null)) {
        closeVote(state, ctx);
        continue;
      }
    }
    break;
  }

  const hand = state.hand;
  if (hand) {
    if (state.deadline == null) {
      // Defensive: a running hand always has exactly one timer.
      const s = state.settings;
      if (hand.phase === 'betting' && hand.toAct) setDeadline(state, ctx.now + s.actionTime * 1000, 'action');
      else if (hand.phase === 'ritVote') setDeadline(state, ctx.now + TIMING.ritVote, 'ritVote');
      else if (hand.phase === 'runout') setDeadline(state, ctx.now + TIMING.runoutStep, 'runout');
      else if (hand.phase === 'complete') setDeadline(state, ctx.now + s.nextHandDelay * 1000, 'nextHand');
    }
  } else {
    const startable = !!lineup(state);
    if (startable && state.deadline == null) setDeadline(state, ctx.now + TIMING.startDelay, 'nextHand');
    else if (!startable && state.deadline != null) clearDeadline(state);
  }
  if (withEquity) refreshEquity(state, ctx);
}

// ─── starting a hand (§6.1) ──────────────────────────────────────────────────

/**
 * Who is dealt into the next hand and where the button / blinds go, or null if no hand can start.
 *
 * Button: the next seat clockwise after the previous button among the regular eligible players
 * (lowest seat for the first hand). Players returning with waitForBB are dealt in only on the hand
 * where they'd post the big blind: with the button fixed, a waiter sitting clockwise after the
 * small blind and before the regular big blind becomes the big blind (the first such waiter only).
 * When fewer than two regular players are available the waiters are dealt in anyway — otherwise
 * nobody could play.
 */
function lineup(state) {
  if (state.paused || state.ended || state.endAfterHand) return null;
  const cand = Object.values(state.players)
    .filter((p) => p.seat != null && p.stack > 0 && !p.away && !p.leaveAfterHand)
    .sort((a, b) => a.seat - b.seat);
  if (cand.length < 2) return null;

  const regular = cand.filter((p) => !p.waitForBB);
  let dealt;
  let button;
  if (regular.length >= 2) {
    const rs = regular.map((p) => p.seat);
    button = seatAfter(rs, state.button);
    dealt = regular;
    const sbR = seatAfter(rs, button);
    const bbR = seatAfter(rs, sbR);
    let bbWaiter = null;
    for (const w of cand) {
      if (!w.waitForBB) continue;
      const d = cw(sbR, w.seat);
      if (d > 0 && d < cw(sbR, bbR) && (!bbWaiter || d < cw(sbR, bbWaiter.seat))) bbWaiter = w;
    }
    if (bbWaiter) dealt = [...regular, bbWaiter];
  } else {
    dealt = cand;
    button = seatAfter(
      cand.map((p) => p.seat),
      state.button,
    );
  }
  // Clockwise starting with the seat left of the button; the button itself is last.
  const order = dealt
    .slice()
    .sort((a, b) => cw(button + 1, a.seat) - cw(button + 1, b.seat))
    .map((p) => p.id);
  const seatOf = (pid) => state.players[pid].seat;
  const headsUp = order.length === 2;
  return {
    order,
    button,
    sbSeat: headsUp ? button : seatOf(order[0]),
    bbSeat: headsUp ? seatOf(order[0]) : seatOf(order[1]),
  };
}

function startNextHand(state, ctx) {
  const lu = lineup(state);
  if (lu) startHand(state, ctx, lu);
  return !!lu;
}

function startHand(state, ctx, lu) {
  const s = state.settings;
  const nHole = s.variant === 'PLO' ? 4 : 2;
  const deck = shuffle(fullDeck(), ctx.rng);
  let di = 0;
  const ps = {};
  for (const pid of lu.order) {
    const p = state.players[pid];
    p.waitForBB = false;
    ps[pid] = {
      pid,
      seat: p.seat,
      hole: [],
      startStack: p.stack,
      bet: 0,
      committed: 0,
      folded: false,
      allIn: false,
      acted: false,
      raiseLocked: false,
      matched: 0, // the bet level this player last acted at (for re-opening rules)
      lastAction: null,
      shown: new Array(nHole).fill(false),
      won: 0,
      handName: null,
    };
  }
  for (let k = 0; k < nHole; k++) for (const pid of lu.order) ps[pid].hole.push(deck[di++]);

  state.handNo = (state.handNo || 0) + 1;
  state.button = lu.button;
  const hand = {
    no: state.handNo,
    startedAt: ctx.now,
    variant: s.variant,
    sb: s.sb,
    bb: s.bb,
    button: lu.button,
    sbSeat: lu.sbSeat,
    bbSeat: lu.bbSeat,
    deck: deck.slice(di),
    order: lu.order,
    ps,
    board: [],
    street: 'preflop',
    phase: 'betting',
    toAct: null,
    currentBet: 0,
    minRaise: s.bb,
    lastAggressor: null,
    log: [],
    ritVotes: {},
    ritVoters: [],
    ritMaxRuns: s.maxRuns,
    runs: 1,
    runBoards: [],
    currentRun: 0,
    runResults: [],
    equity: null,
    results: null,
    runout: null,
    completedAt: null,
  };
  state.hand = hand;

  const pidAt = (seat) => lu.order.find((pid) => ps[pid].seat === seat);
  const sbPid = pidAt(lu.sbSeat);
  const bbPid = pidAt(lu.bbSeat);
  postBlind(state, hand, sbPid, s.sb, 'small blind');
  postBlind(state, hand, bbPid, s.bb, 'big blind');
  // A short big blind: the bet to match is what was actually posted; the minimum raise stays bb.
  hand.currentBet = Math.max(ps[sbPid].bet, ps[bbPid].bet);
  hand.minRaise = s.bb;

  const firstIdx = lu.order.length === 2 ? lu.order.indexOf(sbPid) : 2 % lu.order.length;
  if (roundComplete(hand)) endStreet(state, ctx);
  else setTurn(state, ctx, nextToAct(hand, firstIdx));
}

function postBlind(state, hand, pid, amount, what) {
  const p = state.players[pid];
  const h = hand.ps[pid];
  const amt = Math.min(amount, p.stack);
  commit(p, h, amt);
  if (p.stack === 0) h.allIn = true;
  addLog(hand, pid, `posts ${what}${h.allIn ? ' (all-in)' : ''}`, amt);
}

// ─── betting (§6.2) ──────────────────────────────────────────────────────────

function setTurn(state, ctx, pid) {
  state.hand.toAct = pid;
  setDeadline(state, ctx.now + state.settings.actionTime * 1000, 'action');
}

/** Betting round over? (≤1 player left, nobody can act, or everyone who can has acted and matched.) */
function roundComplete(hand) {
  let live = 0;
  let actors = 0;
  let pending = false;
  let lone = null;
  for (const pid of hand.order) {
    const h = hand.ps[pid];
    if (h.folded) continue;
    live++;
    if (h.allIn) continue;
    actors++;
    lone = h;
    if (!h.acted || h.bet !== hand.currentBet) pending = true;
  }
  if (live <= 1 || actors === 0) return true;
  if (actors === 1) return lone.bet >= hand.currentBet; // nobody left to bet against
  return !pending;
}

/** First player at or after order index `fromIdx` (cyclic) who still has to act this street. */
function nextToAct(hand, fromIdx) {
  const n = hand.order.length;
  for (let k = 0; k < n; k++) {
    const pid = hand.order[(fromIdx + k) % n];
    const h = hand.ps[pid];
    if (!h.folded && !h.allIn && (!h.acted || h.bet < hand.currentBet)) return pid;
  }
  return null;
}

/**
 * Execute an already-validated move. `auto` is null for a voluntary action, otherwise the reason
 * ('timeout' | 'away' | 'left' | 'removed').
 */
function doMove(state, ctx, pid, move, to, auto) {
  const hand = state.hand;
  const h = hand.ps[pid];
  const p = state.players[pid];
  const idx = hand.order.indexOf(pid);
  const suffix = auto ? AUTO_SUFFIX[auto] || '' : '';

  if (move === 'fold') {
    h.folded = true;
    h.lastAction = { type: 'fold', amount: 0 };
    addLog(hand, pid, 'folds' + suffix);
  } else if (move === 'check') {
    h.lastAction = { type: 'check', amount: 0 };
    addLog(hand, pid, 'checks' + suffix);
  } else if (move === 'call') {
    commit(p, h, Math.min(hand.currentBet - h.bet, p.stack));
    if (p.stack === 0) h.allIn = true;
    h.lastAction = { type: h.allIn ? 'allin' : 'call', amount: h.bet };
    addLog(hand, pid, h.allIn ? 'calls all-in' : 'calls', h.bet);
  } else {
    // raise (also an opening bet)
    const before = hand.currentBet;
    commit(p, h, to - h.bet);
    if (p.stack === 0) h.allIn = true;
    const increment = to - before;
    const full = increment >= hand.minRaise;
    hand.currentBet = to;
    hand.lastAggressor = pid;
    if (full) {
      // A full raise re-opens the betting for everyone still able to act.
      hand.minRaise = increment;
      for (const q of hand.order) {
        const o = hand.ps[q];
        if (q !== pid && !o.folded && !o.allIn) {
          o.acted = false;
          o.raiseLocked = false;
        }
      }
    } else {
      // A short all-in raise doesn't re-open the betting for players who already acted: they may
      // call or fold but not raise — unless the short raises since their last action add up to a
      // full raise (TDA rule: "facing at least a full raise").
      for (const q of hand.order) {
        const o = hand.ps[q];
        if (q !== pid && !o.folded && !o.allIn && o.acted) o.raiseLocked = hand.currentBet - o.matched < hand.minRaise;
      }
    }
    const type = h.allIn ? 'allin' : before === 0 ? 'bet' : 'raise';
    h.lastAction = { type, amount: to };
    addLog(hand, pid, h.allIn ? 'all-in' : before === 0 ? 'bets' : 'raises to', to);
  }
  h.acted = true;
  h.matched = hand.currentBet;
  if (!auto) p.timeouts = 0;
  afterAction(state, ctx, idx);
}

function afterAction(state, ctx, idx) {
  const hand = state.hand;
  if (liveIds(hand).length <= 1) return endByFold(state, ctx);
  if (roundComplete(hand)) return endStreet(state, ctx);
  const next = nextToAct(hand, idx + 1);
  if (!next) return endStreet(state, ctx); // unreachable when roundComplete is false; defensive
  setTurn(state, ctx, next);
}

/** Check if that's free, otherwise fold — used for timeouts and away players. */
function autoAct(state, ctx, pid, why) {
  const hand = state.hand;
  doMove(state, ctx, pid, hand.ps[pid].bet >= hand.currentBet ? 'check' : 'fold', null, why);
}

function actionTimeout(state, ctx, pid) {
  const p = state.players[pid];
  if (p) {
    p.timeouts = (p.timeouts || 0) + 1;
    const limit = state.settings.autoAwayTimeouts;
    if (limit > 0 && p.timeouts >= limit && !p.away) {
      p.away = true;
      p.awayBy = 'timeout';
    }
  }
  autoAct(state, ctx, pid, 'timeout');
}

/** Fold a player out of turn (leaving / removed). Their bet stays in the pot as dead money. */
function foldNow(state, ctx, pid, why) {
  const hand = state.hand;
  if (hand.toAct === pid) return doMove(state, ctx, pid, 'fold', null, why);
  const h = hand.ps[pid];
  h.folded = true;
  h.lastAction = { type: 'fold', amount: 0 };
  addLog(hand, pid, 'folds' + (AUTO_SUFFIX[why] || ''));
  if (liveIds(hand).length <= 1) return endByFold(state, ctx);
  if (roundComplete(hand)) return endStreet(state, ctx);
  // Otherwise the player whose turn it is keeps the turn (and their clock).
}

function endStreet(state, ctx) {
  const hand = state.hand;
  for (const pid of hand.order) {
    const h = hand.ps[pid];
    h.bet = 0; // already counted in committed
    h.acted = false;
    h.raiseLocked = false;
    h.matched = 0;
    if (!h.folded && !h.allIn) h.lastAction = null;
  }
  hand.currentBet = 0;
  hand.minRaise = hand.bb;
  hand.toAct = null;
  if (hand.board.length >= 5) return settleShowdown(state, ctx);
  const actors = liveIds(hand).filter((pid) => !hand.ps[pid].allIn);
  if (actors.length <= 1) return startAllInRunout(state, ctx);
  dealStreet(hand);
  setTurn(state, ctx, nextToAct(hand, 0));
}

function dealStreet(hand) {
  const cards = hand.deck.splice(0, hand.board.length === 0 ? 3 : 1);
  hand.board.push(...cards);
  hand.street = STREET_AT[hand.board.length];
  addLog(hand, null, STREET_LABEL[hand.street], null, { cards });
}

// ─── all-in runout, run it N times ───────────────────────────────────────────

/** Mark hole cards shown (all of them by default); logs the newly visible cards. */
function reveal(hand, pid, indices = null) {
  const h = hand.ps[pid];
  const idx = indices || h.hole.map((_, i) => i);
  const fresh = [];
  for (const i of idx) {
    if (!h.shown[i]) {
      h.shown[i] = true;
      fresh.push(h.hole[i]);
    }
  }
  if (fresh.length) addLog(hand, pid, 'shows', null, { cards: fresh });
  return fresh.length > 0;
}

function startAllInRunout(state, ctx) {
  const hand = state.hand;
  const live = liveIds(hand);
  for (const pid of live) reveal(hand, pid); // all-in and called: everyone's cards go face up
  hand.toAct = null;
  hand.equity = null;
  hand.runBoards = [];
  hand.currentRun = 0;
  hand.runResults = [];
  if (state.settings.maxRuns > 1) {
    hand.phase = 'ritVote';
    hand.ritVoters = live.slice();
    hand.ritVotes = {};
    hand.ritMaxRuns = state.settings.maxRuns;
    setDeadline(state, ctx.now + TIMING.ritVote, 'ritVote');
  } else {
    hand.runs = 1;
    beginRunout(state, ctx);
  }
}

function closeVote(state, ctx) {
  const hand = state.hand;
  const votes = hand.ritVoters.map((v) => hand.ritVotes[v]);
  const unanimous = votes.length > 0 && votes.every((v) => v != null && v === votes[0]);
  hand.runs = unanimous ? votes[0] : 1;
  addLog(hand, null, hand.runs === 1 ? 'Running it once' : hand.runs === 2 ? 'Running it twice' : `Running it ${hand.runs} times`);
  beginRunout(state, ctx);
}

function beginRunout(state, ctx) {
  const hand = state.hand;
  hand.phase = 'runout';
  hand.runBoards = [hand.board.slice()];
  hand.currentRun = 0;
  hand.runResults = [];
  hand.equity = null;
  setDeadline(state, ctx.now + TIMING.runoutStep, 'runout');
}

/**
 * One runout step: deal the next street of the current run (starting the next run from the shared
 * board when the current one is complete). Cards continue from the same deck. When the last run's
 * river is out, the hand is settled.
 */
function runoutStep(state, ctx) {
  const hand = state.hand;
  let r = hand.currentRun;
  if (hand.runBoards[r].length >= 5) {
    r += 1;
    hand.currentRun = r;
    hand.runBoards[r] = hand.board.slice();
  }
  const rb = hand.runBoards[r];
  const cards = hand.deck.splice(0, rb.length < 3 ? 3 - rb.length : 1);
  rb.push(...cards);
  if (hand.runs === 1) hand.board = rb.slice(); // a single run IS the shared board
  hand.street = STREET_AT[rb.length];
  addLog(hand, null, (hand.runs > 1 ? `Run ${r + 1} · ` : '') + STREET_LABEL[hand.street], null, { cards, run: r });
  hand.equity = null;
  if (rb.length >= 5) {
    hand.runResults[r] = runResult(hand, rb);
    if (r >= hand.runs - 1) return settleShowdown(state, ctx);
  }
  setDeadline(state, ctx.now + TIMING.runoutStep, 'runout');
}

/** Best hand among non-folded players on `board` → { winners (hand order), handName }. */
function runResult(hand, board) {
  let best = -1;
  let winners = [];
  let handName = null;
  for (const pid of liveIds(hand)) {
    const ev = evaluateFor(hand.variant, hand.ps[pid].hole, board);
    if (ev.score > best) {
      best = ev.score;
      winners = [pid];
      handName = ev.name;
    } else if (ev.score === best) {
      winners.push(pid);
    }
  }
  return { winners, handName };
}

/** Win percentages for the current run's board (rounded ints), computed lazily once per board. */
function refreshEquity(state, ctx) {
  const hand = state.hand;
  if (!hand || (hand.phase !== 'ritVote' && hand.phase !== 'runout') || hand.equity) return;
  const run = hand.phase === 'runout' ? hand.currentRun : 0;
  const board = hand.phase === 'runout' ? hand.runBoards[run] : hand.board;
  const live = liveIds(hand);
  let by = {};
  try {
    if (board.length >= 5) {
      const { winners } = runResult(hand, board);
      for (const pid of live) by[pid] = winners.includes(pid) ? Math.round(100 / winners.length) : 0;
    } else {
      const hands = {};
      for (const pid of live) hands[pid] = hand.ps[pid].hole;
      // Cards already used on the other runs' boards can't come on this one.
      const dead = [];
      if (hand.phase === 'runout') {
        hand.runBoards.forEach((b, i) => {
          if (i !== run) for (let k = hand.board.length; k < b.length; k++) dead.push(b[k]);
        });
      }
      const raw = computeEquity({ variant: hand.variant, hands, board, dead, rng: ctx.rng });
      for (const pid of live) by[pid] = Math.round(raw[pid] || 0);
    }
  } catch {
    by = {}; // display-only; an equity failure must never break the game
  }
  hand.equity = { run, by };
}

// ─── settlement (§6.3) ───────────────────────────────────────────────────────

/**
 * Side pots from every dealt player's `committed` (folded players' chips are dead money in the pots
 * they reached). Layers at each distinct commitment level of the non-folded players; chips folded
 * players put in above the top level go to the top pot. Eligible lists are in hand order.
 */
export function buildPots(hand) {
  const all = hand.order.map((pid) => hand.ps[pid]);
  const levels = [...new Set(all.filter((h) => !h.folded).map((h) => h.committed))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const h of all) amount += Math.min(h.committed, level) - Math.min(h.committed, prev);
    if (amount > 0) {
      pots.push({ amount, eligible: hand.order.filter((pid) => !hand.ps[pid].folded && hand.ps[pid].committed >= level) });
    }
    prev = level;
  }
  let extra = 0;
  for (const h of all) extra += Math.max(0, h.committed - prev);
  if (extra > 0) {
    if (pots.length) pots[pots.length - 1].amount += extra;
    else pots.push({ amount: extra, eligible: liveIds(hand) });
  }
  return pots;
}

function settleShowdown(state, ctx) {
  const hand = state.hand;
  const live = liveIds(hand);
  if (!hand.runBoards.length) hand.runBoards = [hand.board.slice()];
  const boards = hand.runBoards;
  const runs = boards.length;
  hand.runs = runs;

  const evals = boards.map((b) => {
    const m = {};
    for (const pid of live) m[pid] = evaluateFor(hand.variant, hand.ps[pid].hole, b);
    return m;
  });
  for (let r = 0; r < runs; r++) if (!hand.runResults[r]) hand.runResults[r] = runResult(hand, boards[r]);

  const pots = buildPots(hand);
  const awards = {};
  const returned = {};
  const wonByRun = boards.map(() => ({}));
  const winners = new Set();
  const give = (pid, n) => {
    awards[pid] = (awards[pid] || 0) + n;
  };
  for (const pot of pots) {
    if (pot.eligible.length === 1) {
      // Nobody else reached this level: an uncalled bet (plus any dead money in it) goes back.
      const e = pot.eligible[0];
      give(e, pot.amount);
      returned[e] = (returned[e] || 0) + pot.amount;
      pot.returned = true;
      pot.winnersByRun = boards.map(() => [e]);
      continue;
    }
    // Split the pot across runs (remainder to run 0), then each part among that run's winners,
    // odd chips one at a time starting with the winner closest clockwise from the button.
    const base = Math.floor(pot.amount / runs);
    pot.winnersByRun = [];
    for (let r = 0; r < runs; r++) {
      const part = base + (r === 0 ? pot.amount - base * runs : 0);
      let best = -1;
      let ws = [];
      for (const pid of pot.eligible) {
        const sc = evals[r][pid].score;
        if (sc > best) {
          best = sc;
          ws = [pid];
        } else if (sc === best) {
          ws.push(pid);
        }
      }
      const share = Math.floor(part / ws.length);
      let odd = part - share * ws.length;
      for (const w of ws) {
        const amt = share + (odd > 0 ? 1 : 0);
        if (odd > 0) odd--;
        give(w, amt);
        wonByRun[r][w] = (wonByRun[r][w] || 0) + amt;
        winners.add(w);
      }
      pot.winnersByRun.push(ws);
    }
  }

  hand.street = 'showdown';
  // Mandatory reveals: every winner, the last aggressor (or the first player clockwise from the
  // button when there was none / they folded), and everyone if losing hands must be shown.
  // All-in runouts revealed everybody already.
  const first =
    hand.lastAggressor && hand.ps[hand.lastAggressor] && !hand.ps[hand.lastAggressor].folded ? hand.lastAggressor : live[0];
  const mustShow = new Set(winners);
  mustShow.add(first);
  if (state.settings.showdownLosers === 'show') for (const pid of live) mustShow.add(pid);
  const start = live.indexOf(first);
  for (let k = 0; k < live.length; k++) {
    const pid = live[(start + k) % live.length];
    if (mustShow.has(pid)) reveal(hand, pid);
  }

  for (const pid of Object.keys(awards)) {
    state.players[pid].stack += awards[pid];
    hand.ps[pid].won = awards[pid];
  }
  const last = runs - 1;
  for (const pid of live) {
    const h = hand.ps[pid];
    if (h.shown.every(Boolean)) h.handName = evals[last][pid].name;
  }

  for (const pid of live) if (returned[pid]) addLog(hand, pid, 'gets back an uncalled bet', returned[pid]);
  for (let r = 0; r < runs; r++) {
    for (const pid of live) {
      if (!wonByRun[r][pid]) continue;
      const runTxt = runs > 1 ? ` run ${r + 1}` : '';
      addLog(hand, pid, `wins${runTxt} with ${evals[r][pid].name}`, wonByRun[r][pid], { run: r, handName: evals[r][pid].name });
    }
  }

  hand.results = {
    endedBy: 'showdown',
    pots,
    awards,
    runs: boards.map((b, r) => ({
      board: b.slice(),
      winners: hand.runResults[r].winners.slice(),
      handName: hand.runResults[r].handName,
      amount: Object.values(wonByRun[r]).reduce((a, n) => a + n, 0),
      awards: { ...wonByRun[r] },
    })),
    winners: hand.order.filter((pid) => winners.has(pid)),
  };
  completeHand(state, ctx, runs);
}

function endByFold(state, ctx) {
  const hand = state.hand;
  const winner = liveIds(hand)[0];
  const total = potTotal(hand);
  state.players[winner].stack += total;
  hand.ps[winner].won = total;
  addLog(hand, winner, 'wins', total);
  hand.results = {
    endedBy: 'fold',
    pots: [{ amount: total, eligible: [winner], winnersByRun: [[winner]] }],
    awards: { [winner]: total },
    runs: [],
    winners: [winner],
  };
  completeHand(state, ctx, 1);
}

function completeHand(state, ctx, runs) {
  const hand = state.hand;
  for (const pid of hand.order) hand.ps[pid].bet = 0; // everything is in the middle now
  hand.phase = 'complete';
  hand.toAct = null;
  hand.completedAt = ctx.now;
  hand.equity = null;
  hand.currentBet = 0;
  const delay = state.settings.nextHandDelay * 1000 + TIMING.extraRun * Math.max(0, runs - 1);
  setDeadline(state, ctx.now + delay, 'nextHand');
}

/** The next-hand timer fired: wrap up the finished hand (§6.3 steps 1–5). */
function finishHand(state, ctx) {
  const hand = state.hand;
  // 1. chips approved during the hand, then the host's queued adjustments in order
  for (const p of Object.values(state.players)) {
    if (p.pendingChips) {
      p.stack += p.pendingChips;
      p.pendingChips = 0;
    }
  }
  const queued = state.pendingAdjust || [];
  state.pendingAdjust = [];
  for (const adj of queued) applyAdjustment(state, ctx, adj);
  // 2. deferred leaves / aways
  for (const p of playersBySeat(state)) {
    if (p.leaveAfterHand && p.seat != null) {
      cashOut(state, ctx, p, p.leaveBy ? { by: p.leaveBy, reason: 'Removed by host' } : {});
    } else {
      p.leaveAfterHand = false;
      p.leaveBy = null;
    }
    if (p.awayAfterHand) {
      p.awayAfterHand = false;
      if (p.seat != null) {
        p.away = true;
        p.awayBy = 'self';
      }
    }
  }
  // 3. archive
  state.lastHand = archiveHand(hand);
  state.hand = null;
  // 4. pause / end requested during the hand
  if (state.pauseAfterHand) {
    state.paused = true;
    state.pauseAfterHand = false;
  }
  if (state.endAfterHand) return endGameNow(state, ctx);
  // 5. deal again if we can
  startNextHand(state, ctx);
}

/** Public summary of a finished hand (only cards that were shown). */
function archiveHand(hand) {
  return {
    no: hand.no,
    log: hand.log,
    results: hand.results,
    boards: hand.runBoards.length ? hand.runBoards.map((b) => b.slice()) : [hand.board.slice()],
    runout: hand.runout ? { cards: hand.runout.cards.slice(), by: hand.runout.by } : null,
    players: hand.order.map((pid) => {
      const h = hand.ps[pid];
      return {
        pid,
        seat: h.seat,
        cards: h.hole.map((c, i) => (h.shown[i] ? c : null)),
        folded: h.folded,
        won: h.won,
        handName: h.handName,
      };
    }),
  };
}

// ─── money: ledger helpers ───────────────────────────────────────────────────

function ledgerPush(state, ctx, entry) {
  state.ledger.push({ id: nextId(state), t: ctx.now, countAsBuyIn: false, reason: null, by: null, hand: state.handNo, ...entry });
}

/** Apply one host adjustment now (stack never below 0). Skips players who are no longer seated. */
function applyAdjustment(state, ctx, a) {
  const p = state.players[a.pid];
  if (!p || p.seat == null) return 0;
  const delta = a.mode === 'add' ? a.amount : a.mode === 'remove' ? -Math.min(a.amount, p.stack) : a.amount - p.stack;
  if (delta === 0) return 0;
  p.stack += delta;
  ledgerPush(state, ctx, {
    type: 'adjust',
    pid: p.id,
    name: p.name,
    amount: delta,
    countAsBuyIn: !!a.countAsBuyIn,
    reason: a.reason || null,
    by: a.by || state.hostId,
    mode: a.mode,
    target: a.amount,
  });
  return delta;
}

/** Apply (and dequeue) one player's queued adjustments right away — used when they leave mid-hand. */
function flushAdjustments(state, ctx, pid) {
  const mine = (state.pendingAdjust || []).filter((a) => a.pid === pid);
  if (!mine.length) return;
  state.pendingAdjust = state.pendingAdjust.filter((a) => a.pid !== pid);
  for (const a of mine) applyAdjustment(state, ctx, a);
}

/** Stand a player up: ledger cashout of stack + pendingChips, clear seat state, drop requests. */
function cashOut(state, ctx, p, { by = null, reason = null } = {}) {
  flushAdjustments(state, ctx, p.id);
  ledgerPush(state, ctx, {
    type: 'cashout',
    pid: p.id,
    name: p.name,
    amount: p.stack + p.pendingChips,
    reason,
    by: by || p.id,
  });
  p.seat = null;
  p.stack = 0;
  p.pendingChips = 0;
  p.away = false;
  p.awayBy = null;
  p.waitForBB = false;
  p.timeouts = 0;
  p.leaveAfterHand = false;
  p.awayAfterHand = false;
  p.leaveBy = null;
  state.requests = state.requests.filter((r) => r.pid !== p.id);
}

function endGameNow(state, ctx) {
  for (const p of playersBySeat(state)) {
    if (p.seat != null) cashOut(state, ctx, p, { by: state.hostId, reason: 'Game ended' });
  }
  state.requests = [];
  state.pendingAdjust = [];
  state.ended = true;
  state.paused = true;
  state.pauseAfterHand = false;
  state.endAfterHand = false;
  clearDeadline(state);
}

/**
 * Leave a seat now, or after the hand when asked to / when all-in / once betting has closed.
 * Leaving now during the betting folds the player (out of turn is fine) before cashing out.
 */
function leaveSeat(state, ctx, p, { afterHand = false, by = null, removed = false } = {}) {
  const hand = state.hand;
  const h = hand && hand.ps[p.id];
  if (h && !h.folded && hand.phase !== 'complete') {
    if (afterHand || h.allIn || hand.phase !== 'betting') {
      p.leaveAfterHand = true;
      p.leaveBy = removed ? by : null;
      return false;
    }
    foldNow(state, ctx, p.id, removed ? 'removed' : 'left');
  }
  cashOut(state, ctx, p, removed ? { by, reason: 'Removed by host' } : {});
  return true;
}

// ─── buy-in requests (§6.5) ──────────────────────────────────────────────────

function buyInRangeText(s) {
  return `Buy-ins are between ${fmt(s.minBuyIn)} and ${fmt(s.maxBuyIn)}.`;
}

/** Validate a rebuy amount for a seated player; returns an error message or null. */
function rebuyProblem(state, p, amount) {
  const s = state.settings;
  const have = p.stack + p.pendingChips;
  if (have === 0) {
    if (amount < s.minBuyIn || amount > s.maxBuyIn) return buyInRangeText(s);
    return null;
  }
  if (have + amount > s.maxBuyIn) {
    const room = s.maxBuyIn - have;
    return room > 0
      ? `You can add at most ${fmt(room)} — stacks are capped at ${fmt(s.maxBuyIn)}.`
      : `You’re already at the maximum stack of ${fmt(s.maxBuyIn)}.`;
  }
  return null;
}

/**
 * Approve `req` for `amount`: validates everything first (throws without mutating), then records the
 * ledger buy-in, seats the player (sit) or adds the chips (rebuy; deferred via pendingChips while
 * they're dealt into the running hand) and drops the request.
 */
function approveRequest(state, ctx, req, amount, by) {
  const p = state.players[req.pid];
  if (!p) throw notFound('That player is no longer in the game.');
  let seat = null;
  if (req.kind === 'sit') {
    if (p.seat != null) throw conflict(`${p.name} is already seated.`);
    seat = req.seat;
    if (seat == null || seat >= state.settings.seats || playerAtSeat(state, seat)) {
      seat = freeSeatFor(state, p.id);
      if (seat == null) throw conflict('There are no free seats — the table is full.');
    }
  } else if (p.seat == null) {
    throw conflict(`${p.name} isn’t seated anymore.`);
  }

  state.requests = state.requests.filter((r) => r !== req);
  ledgerPush(state, ctx, { type: 'buyin', pid: p.id, name: p.name, amount, countAsBuyIn: true, by, kind: req.kind });
  if (req.kind === 'sit') {
    p.seat = seat;
    p.stack = amount;
    p.pendingChips = 0;
    p.away = false;
    p.awayBy = null;
    p.timeouts = 0;
    p.waitForBB = false;
    p.leaveAfterHand = false;
    p.awayAfterHand = false;
    p.leaveBy = null;
  } else if (state.hand && state.hand.ps[p.id]) {
    p.pendingChips += amount;
  } else {
    p.stack += amount;
  }
}

function autoApproves(state, pid) {
  return !state.settings.approveBuyIns || pid === state.hostId;
}

/** After the host switches auto-approve on: approve what's pending and still valid; skip the rest. */
function autoApprovePending(state, ctx) {
  const s = state.settings;
  for (const req of state.requests.slice()) {
    const p = state.players[req.pid];
    if (!p) continue;
    const ok =
      req.kind === 'sit' ? req.amount >= s.minBuyIn && req.amount <= s.maxBuyIn : p.seat != null && !rebuyProblem(state, p, req.amount);
    if (!ok) continue;
    try {
      approveRequest(state, ctx, req, req.amount, null);
    } catch {
      // leave it for the host to handle by hand
    }
  }
}

// ─── action handlers (§8) ────────────────────────────────────────────────────

function actSit(state, pid, a, ctx) {
  const p = state.players[pid];
  const s = state.settings;
  if (p.seat != null) throw conflict('You’re already seated.');
  if (requestOf(state, pid)) throw conflict('You already have a pending request — wait for the host or cancel it.');
  let seat = null;
  if (a.seat != null && a.seat !== '') {
    seat = toInt(a.seat);
    if (!(seat >= 0 && seat < s.seats)) throw badRequest('Pick an empty seat at the table.');
    if (playerAtSeat(state, seat)) throw conflict('That seat is taken — pick another.');
    if (seatReservedBy(state, seat, pid)) throw conflict('Someone has already asked for that seat — pick another.');
  } else if (freeSeatFor(state, pid) == null) {
    throw conflict('The table is full.');
  }
  const amount = toInt(a.amount);
  if (!Number.isInteger(amount)) throw badRequest('Enter a whole number of chips.');
  if (amount < s.minBuyIn || amount > s.maxBuyIn) throw badRequest(buyInRangeText(s));

  const req = { id: nextId(state), pid, kind: 'sit', amount, seat, createdAt: ctx.now };
  if (autoApproves(state, pid)) approveRequest(state, ctx, req, amount, pid === state.hostId ? pid : null);
  else state.requests.push(req);
}

function actBuyin(state, pid, a, ctx) {
  const p = state.players[pid];
  if (p.seat == null) throw conflict('Take a seat first.');
  if (requestOf(state, pid)) throw conflict('You already have a pending request — wait for the host or cancel it.');
  const amount = toInt(a.amount);
  if (!Number.isInteger(amount) || amount < 1) throw badRequest('Enter a whole number of chips.');
  const problem = rebuyProblem(state, p, amount);
  if (problem) throw badRequest(problem);

  const req = { id: nextId(state), pid, kind: 'rebuy', amount, seat: null, createdAt: ctx.now };
  if (autoApproves(state, pid)) approveRequest(state, ctx, req, amount, pid === state.hostId ? pid : null);
  else state.requests.push(req);
}

function actCancelRequest(state, pid, a) {
  const req = findRequest(state, a.id);
  if (req.pid !== pid) throw forbidden('That isn’t your request.');
  state.requests = state.requests.filter((r) => r !== req);
}

function actApprove(state, pid, a, ctx) {
  const req = findRequest(state, a.id);
  let amount = req.amount;
  if (a.amount != null && a.amount !== '') {
    amount = toInt(a.amount);
    if (!Number.isInteger(amount) || amount < 1) throw badRequest('The amount must be a whole number of at least 1.');
    if (amount > LIMITS.maxChips) throw badRequest('That amount is too large.');
  }
  approveRequest(state, ctx, req, amount, pid);
}

function actDeny(state, pid, a) {
  const req = findRequest(state, a.id);
  state.requests = state.requests.filter((r) => r !== req);
}

function actAct(state, pid, a, ctx) {
  const hand = state.hand;
  if (!hand || hand.phase !== 'betting') throw conflict('There’s no betting going on right now.');
  if (!hand.ps[pid]) throw forbidden('You’re not in this hand.');
  if (hand.toAct !== pid) throw new EngineError('It’s not your turn.', 'not_your_turn');
  const L = legalActions(state, pid);
  if (!L) throw new EngineError('It’s not your turn.', 'not_your_turn');
  let move = a.move;
  let to = null;
  switch (move) {
    case 'fold':
      break;
    case 'check':
      if (!L.check) throw badRequest(`You can’t check — it’s ${fmt(L.call)} to call.`);
      break;
    case 'call':
      if (L.call === 0) move = 'check'; // nothing to call: treat as a check
      break;
    case 'raise': {
      if (!L.raise) {
        const h = hand.ps[pid];
        const others = hand.order.some((q) => q !== pid && !hand.ps[q].folded && !hand.ps[q].allIn);
        if (!others) throw badRequest('Everyone else is all-in — you can only call or fold.');
        if (h.raiseLocked) throw badRequest('That all-in was less than a full raise, so you can’t re-raise — call or fold.');
        throw badRequest('You don’t have enough chips to raise.');
      }
      to = toInt(a.to);
      if (!Number.isInteger(to)) throw badRequest('Enter a whole number to raise to.');
      const word = hand.currentBet === 0 ? 'bet' : 'raise';
      if (L.minTo === L.maxTo && to !== L.maxTo) throw badRequest(`Your only ${word} is all-in for ${fmt(L.maxTo)}.`);
      if (to < L.minTo) throw badRequest(`The minimum ${word} is ${hand.currentBet === 0 ? '' : 'to '}${fmt(L.minTo)}.`);
      if (to > L.maxTo) {
        const h = hand.ps[pid];
        const allInTo = h.bet + state.players[pid].stack;
        throw badRequest(
          hand.variant === 'PLO' && L.maxTo < allInTo
            ? `Pot limit: the most you can ${word} is ${hand.currentBet === 0 ? '' : 'to '}${fmt(L.maxTo)}.`
            : `You only have ${fmt(allInTo)} — that’s all-in.`,
        );
      }
      break;
    }
    default:
      throw badRequest('Choose fold, check, call or raise.');
  }
  doMove(state, ctx, pid, move, to, null);
}

function actVote(state, pid, a, ctx) {
  const hand = state.hand;
  if (!hand || hand.phase !== 'ritVote') throw conflict('There’s no run-it vote right now.');
  if (!hand.ritVoters.includes(pid)) throw forbidden('Only players still in the hand can vote.');
  const max = hand.ritMaxRuns || state.settings.maxRuns;
  const n = toInt(a.runs);
  if (!(n >= 1 && n <= max)) throw badRequest(`Vote to run it between 1 and ${max} times.`);
  hand.ritVotes[pid] = n;
  if (hand.ritVoters.every((v) => hand.ritVotes[v] != null)) closeVote(state, ctx);
}

function actShow(state, pid, a) {
  const hand = state.hand;
  if (!hand || hand.phase !== 'complete') throw conflict('You can show your cards once the hand is over.');
  const h = hand.ps[pid];
  if (!h) throw forbidden('You weren’t dealt into this hand.');
  if (!Array.isArray(a.cards) || a.cards.length === 0) throw badRequest('Pick at least one card to show.');
  const idx = [];
  for (const v of a.cards) {
    const i = toInt(v);
    if (!(i >= 0 && i < h.hole.length)) throw badRequest('That card isn’t in your hand.');
    if (!idx.includes(i)) idx.push(i);
  }
  idx.sort((x, y) => x - y);
  if (!reveal(hand, pid, idx)) return; // idempotent
  const board = displayBoard(hand);
  if (h.shown.every(Boolean) && board.length >= 3) h.handName = evaluateFor(hand.variant, h.hole, board).name;
}

function actRevealRunout(state, pid) {
  const problem = revealRunoutProblem(state, pid);
  if (problem) throw problem;
  const hand = state.hand;
  const cards = hand.deck.slice(0, 5 - hand.board.length); // exactly what would have been dealt next
  hand.runout = { cards, by: pid };
  addLog(hand, pid, 'reveals the runout', null, { cards });
}

function actAway(state, pid, a) {
  const p = state.players[pid];
  if (p.seat == null) throw conflict('Take a seat first.');
  if (a.on) {
    const hand = state.hand;
    if (a.afterHand && hand && hand.ps[pid]) {
      p.awayAfterHand = true;
      return;
    }
    p.away = true;
    p.awayBy = 'self';
    p.awayAfterHand = false;
  } else {
    p.away = false;
    p.awayBy = null;
    p.timeouts = 0;
    p.waitForBB = !!a.waitForBB;
    p.awayAfterHand = false;
  }
}

function actLeave(state, pid, a, ctx) {
  const p = state.players[pid];
  if (p.seat == null) throw conflict('You’re not seated.');
  leaveSeat(state, ctx, p, { afterHand: !!a.afterHand });
}

function actCancelLeave(state, pid) {
  const p = state.players[pid];
  if (p.seat == null) throw conflict('You’re not seated.');
  if (p.leaveAfterHand && p.leaveBy && p.leaveBy !== pid) throw forbidden('The host is removing you from your seat after this hand.');
  p.leaveAfterHand = false;
  p.leaveBy = null;
}

function actChat(state, pid, a, ctx) {
  const raw = typeof a.text === 'string' ? a.text : '';
  const text = raw.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) throw badRequest('Type a message first.');
  if ([...text].length > LIMITS.chatMax) throw badRequest(`Messages can be at most ${LIMITS.chatMax} characters.`);
  const p = state.players[pid];
  state.chat.push({ id: nextId(state), t: ctx.now, pid, name: p.name, text });
  if (state.chat.length > LIMITS.chatKeep) state.chat.splice(0, state.chat.length - LIMITS.chatKeep);
}

function actAdjust(state, pid, a, ctx) {
  const t = targetPlayer(state, a.pid);
  if (t.seat == null) throw conflict(`${t.name} isn’t seated — only seated players’ chips can be adjusted.`);
  const mode = a.mode;
  if (mode !== 'add' && mode !== 'remove' && mode !== 'set') throw badRequest('Choose add, remove or set.');
  const amount = toInt(a.amount);
  const min = mode === 'set' ? 0 : 1;
  if (!Number.isInteger(amount) || amount < min) {
    throw badRequest(mode === 'set' ? 'Enter a whole number of chips (0 or more).' : 'Enter a whole number of chips (at least 1).');
  }
  if (amount > LIMITS.maxChips) throw badRequest('That amount is too large.');
  let reason = null;
  if (a.reason != null && a.reason !== '') {
    if (typeof a.reason !== 'string') throw badRequest('The reason must be text.');
    const r = a.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if ([...r].length > LIMITS.reasonMax) throw badRequest(`Keep the reason under ${LIMITS.reasonMax + 1} characters.`);
    reason = r || null;
  }
  const adj = { pid: t.id, mode, amount, reason, countAsBuyIn: !!a.countAsBuyIn, by: pid };
  if (state.hand && state.hand.ps[t.id]) state.pendingAdjust.push(adj); // applied when the hand ends
  else applyAdjustment(state, ctx, adj);
}

function actSetAway(state, pid, a) {
  const t = targetPlayer(state, a.pid);
  if (t.seat == null) throw conflict(`${t.name} isn’t seated.`);
  if (a.on) {
    t.away = true;
    t.awayBy = 'host';
  } else {
    t.away = false;
    t.awayBy = null;
    t.timeouts = 0;
  }
}

function actRemove(state, pid, a, ctx) {
  const t = targetPlayer(state, a.pid);
  if (t.seat == null) throw conflict(`${t.name} isn’t seated.`);
  leaveSeat(state, ctx, t, { by: pid, removed: true });
}

function actSettings(state, pid, a, ctx) {
  const next = sanitizeSettings(a.patch, state.settings);
  let highest = -1;
  for (const p of Object.values(state.players)) if (p.seat != null && p.seat > highest) highest = p.seat;
  if (next.seats < highest + 1) {
    throw badRequest(`Seat ${highest + 1} is taken, so the table needs at least ${highest + 1} seats.`);
  }
  const autoOn = state.settings.approveBuyIns && !next.approveBuyIns;
  state.settings = next;
  if (autoOn) autoApprovePending(state, ctx);
}

function actPause(state, pid, a) {
  if (a.on) {
    if (state.hand) state.pauseAfterHand = true;
    else state.paused = true;
  } else {
    state.paused = false;
    state.pauseAfterHand = false;
  }
}

function actMarkPaid(state, pid, a) {
  const key = typeof a.key === 'string' ? a.key.trim() : '';
  if (!key || key.length > 200) throw badRequest('Unknown payment.');
  if (a.paid === undefined || a.paid) state.paid[key] = true;
  else delete state.paid[key];
}

function actTransferHost(state, pid, a) {
  const t = targetPlayer(state, a.pid);
  if (t.id === state.hostId) throw badRequest('They’re already the host.');
  state.hostId = t.id;
}

function actEndGame(state, pid, a, ctx) {
  if (!state.hand) return endGameNow(state, ctx);
  // A hand in progress is never cut short: finish it, then cash everyone out.
  state.endAfterHand = true;
  state.pauseAfterHand = true;
  if (state.hand.phase === 'complete') finishHand(state, ctx); // already settled — wrap up now
}

const HANDLERS = Object.freeze({
  tick: () => {},
  sit: actSit,
  buyin: actBuyin,
  cancelRequest: actCancelRequest,
  act: actAct,
  vote: actVote,
  show: actShow,
  revealRunout: actRevealRunout,
  away: actAway,
  leave: actLeave,
  cancelLeave: actCancelLeave,
  chat: actChat,
  approve: actApprove,
  deny: actDeny,
  adjust: actAdjust,
  setAway: actSetAway,
  remove: actRemove,
  settings: actSettings,
  pause: actPause,
  markPaid: actMarkPaid,
  transferHost: actTransferHost,
  endGame: actEndGame,
});
