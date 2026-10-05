// lib/store.js — room persistence (optimistic versioning), player auth, realtime publish, HTTP errors.
//
// The ONLY lib/ module that touches the platform SDK (SPEC §0). Everything else in lib/ is pure.
// SQL statements are exactly the three in SPEC §9 (the dev fake matches them by regex).

import { db, events } from 'hatchable';
import { cleanDisplayText, hasVisibleText, isReservedName } from './engine.js';

const SQL_SELECT = 'SELECT state, version FROM rooms WHERE code = $1';
const SQL_INSERT = 'INSERT INTO rooms (code, state, version) VALUES ($1, $2::jsonb, 1)';
const SQL_UPDATE =
  'UPDATE rooms SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE code = $1 AND version = $3';

const MAX_RETRIES = 6; // retries after the first attempt → up to 7 attempts total
const TOKEN_HEADER = 'x-felt-token';

// ─── errors ──────────────────────────────────────────────────────────────────

/** Error status map (SPEC §9). Works for EngineError and StoreError alike — both carry `code`. */
export const ERROR_STATUS = Object.freeze({
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  not_your_turn: 409,
  rate_limited: 429,
});

/** Error thrown by the store / API layer. Same `code` vocabulary as EngineError. */
export class StoreError extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** EngineError / StoreError → mapped status + `{ error, code }`; anything else → 500 (logged). */
export function sendError(res, err) {
  const status = err && typeof err.code === 'string' ? ERROR_STATUS[err.code] : undefined;
  if (status) {
    return res.status(status).json({ error: String(err.message || err.code), code: err.code });
  }
  console.error('[felt] unexpected error:', err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Something went wrong on the server. Please try again.', code: 'internal' });
}

// ─── ids, tokens, codes ──────────────────────────────────────────────────────

function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding (no btoa/Buffer dependency — works in any isolate). */
function base64url(bytes) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((i + 1 < bytes.length ? bytes[i + 1] : 0) << 8);
    out += B64URL[n >> 18] + B64URL[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64URL[(n >> 6) & 63];
  }
  return out;
}

/** 32 random bytes, base64url (43 chars). The player's secret; only its sha256 is stored. */
export function newToken() {
  return base64url(randomBytes(32));
}

/** 12-char base64url player id (9 random bytes). */
export function newPid() {
  return base64url(randomBytes(9));
}

/** Random room code `[A-Z]{3}-[0-9]{4}` (uniform via rejection sampling). */
export function newRoomCode() {
  const pick = (alphabet) => {
    const limit = 256 - (256 % alphabet.length);
    for (;;) {
      const [x] = randomBytes(1);
      if (x < limit) return alphabet[x % alphabet.length];
    }
  };
  const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const D = '0123456789';
  return pick(L) + pick(L) + pick(L) + '-' + pick(D) + pick(D) + pick(D) + pick(D);
}

const CODE_RE = /^[A-Z]{3}-[0-9]{4}$/;

/**
 * Normalise a user-supplied room code: trims, uppercases, accepts a missing dash or a space
 * ("rvr4821", "RVR 4821"). Returns the canonical `ABC-1234` or null when it can't be a code.
 */
export function normalizeCode(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase().replace(/[\s_–—-]+/g, '');
  const m = /^([A-Z]{3})([0-9]{4})$/.exec(s);
  if (!m) return null;
  const code = m[1] + '-' + m[2];
  return CODE_RE.test(code) ? code : null;
}

/**
 * Clean a display name: strips control, format and other invisible characters (zero-width
 * joiners, bidi controls, Hangul fillers …), collapses whitespace, trims.
 * Throws StoreError('bad_request') unless the result is 1..`max` characters (code points) with
 * something visible in it. `player: true` also refuses names the UI uses as labels ("You").
 */
export function cleanName(raw, { max = 20, label = 'Name', player = false } = {}) {
  if (typeof raw !== 'string') throw new StoreError(label + ' is required.', 'bad_request');
  const s = cleanDisplayText(raw);
  const len = [...s].length;
  if (len < 1 || !hasVisibleText(s)) throw new StoreError(label + ' is required.', 'bad_request');
  if (len > max) throw new StoreError(label + ' must be at most ' + max + ' characters.', 'bad_request');
  if (player && isReservedName(s)) throw new StoreError('“' + s + '” is reserved — pick another name.', 'bad_request');
  return s;
}

/** Room code from a request value, or throws StoreError (400 when malformed). */
export function requireCode(raw) {
  const code = normalizeCode(raw);
  if (!code) throw new StoreError('Room codes look like ABC-1234.', 'bad_request');
  return code;
}

/** sha256 of `text` as lowercase hex (WebCrypto; available in isolates and Node). */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  const b = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < b.length; i++) hex += b[i].toString(16).padStart(2, '0');
  return hex;
}

// ─── auth ────────────────────────────────────────────────────────────────────

const hashCache = new WeakMap(); // req → Promise<string|null>   (token hashed once per request)

/** The raw `x-felt-token` header value, or null. */
export function tokenFromReq(req) {
  const h = req && req.headers ? req.headers[TOKEN_HEADER] : undefined;
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= 16 && t.length <= 256 ? t : null;
}

function tokenHashFor(req) {
  if (!req || typeof req !== 'object') return Promise.resolve(null);
  let p = hashCache.get(req);
  if (!p) {
    const token = tokenFromReq(req);
    p = token ? sha256Hex(token) : Promise.resolve(null);
    hashCache.set(req, p);
  }
  return p;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** → pid of the player whose token is in `x-felt-token`, or null (anonymous / unknown token). */
export async function resolvePlayer(state, req) {
  const hash = await tokenHashFor(req);
  if (!hash || !state || !state.players) return null;
  for (const pid of Object.keys(state.players)) {
    const p = state.players[pid];
    if (p && safeEqual(p.tokenHash, hash)) return pid;
  }
  return null;
}

// ─── persistence ─────────────────────────────────────────────────────────────

function parseState(raw) {
  // JSONB normally arrives parsed; tolerate drivers that hand back text.
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** → { state, version } | null */
/**
 * The platform's data gateway can briefly refuse queries during write bursts (seen live as HTTP 429
 * on GET /api/state while a run-it-twice runout was ticking). Every DB call goes through this:
 * a rate-limited query is retried after a short jittered backoff instead of failing the request.
 */
const DB_RETRY_DELAYS = [80, 200, 450, 900];
function isRateLimited(err) {
  if (!err) return false;
  if (err.code === 'rate_limited' || err.status === 429 || err.statusCode === 429) return true;
  return /rate.?limit|too many requests|\b429\b/i.test(String(err.message || ''));
}
export async function dbQuery(sql, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.query(sql, params);
    } catch (err) {
      if (!isRateLimited(err) || attempt >= DB_RETRY_DELAYS.length) throw err;
      const base = DB_RETRY_DELAYS[attempt];
      await new Promise((r) => setTimeout(r, base + Math.floor(Math.random() * base)));
    }
  }
}

export async function loadRoom(code) {
  const r = await dbQuery(SQL_SELECT, [code]);
  const row = r && r.rows && r.rows[0];
  if (!row) return null;
  return { state: parseState(row.state), version: Number(row.version) };
}

function isUniqueViolation(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  return /duplicate key|unique constraint|already exists/i.test(String(err.message || ''));
}

/**
 * INSERT a new room at version 1. Returns true when inserted, false when the code is already
 * taken (PK conflict — the caller picks a new code and retries). Other DB errors throw.
 */
export async function insertRoom(state) {
  try {
    await dbQuery(SQL_INSERT, [state.code, JSON.stringify(state)]);
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

const PUBLISH_ATTEMPTS = 3;
const PUBLISH_WAIT_CAP = 2500; // ms per retry; clients would otherwise sit on a stale view

/** `err.retryAfter` → ms (the platform may give seconds or ms); a short default when absent. */
function retryAfterMs(err, attempt) {
  const r = Number(err && err.retryAfter);
  const ms = Number.isFinite(r) && r > 0 ? (r < 100 ? r * 1000 : r) : 400 * (attempt + 1);
  return Math.min(PUBLISH_WAIT_CAP, Math.max(50, ms));
}

/**
 * Publish `update {v}` on `room:CODE`. Never throws: the write already committed. A publish refused
 * by the project-wide rate limit is retried (after `retryAfter`, capped) — a dropped update would
 * leave every other client on a stale view, e.g. not knowing it's their turn while their clock runs.
 * → true when delivered.
 */
export async function publishUpdate(code, version) {
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      await events.publish('room:' + code, 'update', { v: version });
      return true;
    } catch (err) {
      const limited = err && err.code === 'rate_limited';
      if (!limited || attempt === PUBLISH_ATTEMPTS - 1) {
        console.error('[felt] publish failed for room ' + code + ':', err && err.message ? err.message : err);
        return false;
      }
      await pause(retryAfterMs(err, attempt));
    }
  }
  return false;
}

/**
 * Optimistic read-modify-write.
 *   load → `await fn(state, version)` → if the state changed, UPDATE … WHERE version = $v.
 * On a version conflict the whole thing is retried with a fresh load (≤ 6 retries), so `fn`
 * must be safe to run more than once (compute `now` inside it). If `fn` throws, nothing is written.
 * Change detection is by JSON comparison, so a no-op `fn` never writes or publishes.
 *
 * → { state, version, changed, result }   (`result` = fn's return value from the committed attempt)
 * Throws StoreError('not_found') if the room doesn't exist, StoreError('conflict') if retries run out.
 */
export async function mutateRoom(code, fn) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const loaded = await loadRoom(code);
    if (!loaded) throw new StoreError('That game doesn’t exist. Check the room code.', 'not_found');
    const { state, version } = loaded;
    const before = JSON.stringify(state);
    const result = await fn(state, version);
    const after = JSON.stringify(state);
    if (after === before) return { state, version, changed: false, result };

    const r = await dbQuery(SQL_UPDATE, [code, after, version]);
    if (r && r.rowCount === 1) {
      const newVersion = version + 1;
      await publishUpdate(code, newVersion);
      return { state, version: newVersion, changed: true, result };
    }
    // Lost the race: someone else committed first. Back off a little (with jitter) and redo.
    await pause(Math.min(200, 5 * 2 ** attempt) + Math.floor(Math.random() * 15));
  }
  throw new StoreError('The table is busy right now — please try that again.', 'conflict');
}
