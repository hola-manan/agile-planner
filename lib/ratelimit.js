// lib/ratelimit.js — per-player and per-room token buckets for cheap, repeatable actions (SPEC §9).
//
// PURE module (SPEC §0): the caller passes `now`. Buckets live in the room state
// (`state.rate = { room: {n, t}, players: { [pid]: {n, t} } }`, server-only, never in a view).
//
// Why: every committed change publishes one realtime event, and the platform allows only about
// 60 publishes per 10 s for the WHOLE project (every room shares it). Without a limit one client
// looping chat / away / sit-cancel could use that budget up and freeze every table. Game moves
// (act, vote) are paced by the turn order and timers; ticks only advance due deadlines; host
// tools are the host's. Everything else a player can repeat at will is limited here.

/** Action types that cost a token when they change the room. */
export const RATE_LIMITED = new Set([
  'chat', 'away', 'leave', 'cancelLeave', 'sit', 'buyin', 'cancelRequest', 'show', 'revealRunout',
]);

/** cap = burst size, every = ms to earn one token back. */
export const RATE = Object.freeze({
  player: Object.freeze({ cap: 10, every: 1500 }), // ≈ 6–7 per 10 s sustained per player
  room: Object.freeze({ cap: 30, every: 400 }), // ≈ 25 per 10 s sustained per room (joins included)
});

function level(bucket, now, { cap, every }) {
  if (!bucket || !Number.isFinite(bucket.n) || !Number.isFinite(bucket.t)) return { n: cap, t: now };
  const earned = Math.floor(Math.max(0, now - bucket.t) / every);
  if (earned <= 0) return { n: bucket.n, t: bucket.t };
  const n = Math.min(cap, bucket.n + earned);
  return { n, t: n === cap ? now : bucket.t + earned * every };
}

function buckets(state) {
  if (!state.rate || typeof state.rate !== 'object') state.rate = { room: null, players: {} };
  if (!state.rate.players || typeof state.rate.players !== 'object') state.rate.players = {};
  return state.rate;
}

/**
 * ms until `pid` (null = only the room bucket) may make another limited change; 0 = allowed now.
 * Read-only: never mutates `state`.
 */
export function rateWait(state, pid, now) {
  const r = state.rate || {};
  const room = level(r.room, now, RATE.room);
  let wait = room.n >= 1 ? 0 : room.t + RATE.room.every - now;
  if (pid != null) {
    const p = level(r.players && r.players[pid], now, RATE.player);
    if (p.n < 1) wait = Math.max(wait, p.t + RATE.player.every - now);
  }
  return Math.max(0, wait);
}

/** Spend one token from the room bucket and (when pid is given) the player's bucket. */
export function spendRate(state, pid, now) {
  const r = buckets(state);
  const room = level(r.room, now, RATE.room);
  r.room = { n: Math.max(0, room.n - 1), t: room.t };
  if (pid != null) {
    const p = level(r.players[pid], now, RATE.player);
    r.players[pid] = { n: Math.max(0, p.n - 1), t: p.t };
  }
  // Forget full buckets of other players so the map can't grow without bound.
  for (const id of Object.keys(r.players)) {
    if (id !== pid && level(r.players[id], now, RATE.player).n >= RATE.player.cap) delete r.players[id];
  }
}
