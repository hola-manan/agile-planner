import { readFileSync, writeFileSync, renameSync } from 'node:fs';

// ─── db ──────────────────────────────────────────────────────────────────────

const rooms = new Map(); // code → { state: jsonText, version, created_at, updated_at }
const DB_FILE = process.env.FELT_DB_FILE || '';

if (DB_FILE) {
  try {
    const saved = JSON.parse(readFileSync(DB_FILE, 'utf8'));
    for (const [code, row] of Object.entries(saved)) rooms.set(code, row);
    process.stderr.write(`[hatchable] loaded ${rooms.size} room(s) from ${DB_FILE}\n`);
  } catch (err) {
    if (err.code !== 'ENOENT') process.stderr.write(`[hatchable] could not read ${DB_FILE}: ${err.message}\n`);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (!DB_FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DB_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(rooms)));
      renameSync(tmp, DB_FILE);
    } catch (err) {
      process.stderr.write(`[hatchable] save failed: ${err.message}\n`);
    }
  }, 200);
  saveTimer.unref?.();
}

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim().replace(/;$/, '');

const RE_SELECT = /^SELECT state, version FROM rooms WHERE code = \$1$/i;
const RE_INSERT = /^INSERT INTO rooms \(code, state, version\) VALUES \(\$1, \$2::jsonb, 1\)$/i;
const RE_UPDATE =
  /^UPDATE rooms SET state = \$2::jsonb, version = version \+ 1, updated_at = now\(\) WHERE code = \$1 AND version = \$3$/i;
const RE_CREATE = /^CREATE TABLE IF NOT EXISTS rooms\b/i;

/** JSONB input: accepts JSON text (what the store sends) or a plain value; stores canonical text. */
function toJsonText(v) {
  if (typeof v === 'string') return JSON.stringify(JSON.parse(v)); // validates like ::jsonb would
  return JSON.stringify(v);
}

function pgError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const yieldTick = () => new Promise((r) => setImmediate(r));

export const db = {
  async query(sql, params = []) {
    await yieldTick();
    const q = norm(sql);

    if (RE_SELECT.test(q)) {
      const row = rooms.get(String(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      return { rows: [{ state: JSON.parse(row.state), version: row.version }], rowCount: 1 };
    }

    if (RE_INSERT.test(q)) {
      const code = String(params[0]);
      if (rooms.has(code)) {
        throw pgError('duplicate key value violates unique constraint "rooms_pkey"', '23505');
      }
      const t = new Date().toISOString();
      rooms.set(code, { state: toJsonText(params[1]), version: 1, created_at: t, updated_at: t });
      scheduleSave();
      return { rows: [], rowCount: 1 };
    }

    if (RE_UPDATE.test(q)) {
      const code = String(params[0]);
      const row = rooms.get(code);
      if (!row || row.version !== Number(params[2])) return { rows: [], rowCount: 0 };
      row.state = toJsonText(params[1]);
      row.version += 1;
      row.updated_at = new Date().toISOString();
      scheduleSave();
      return { rows: [], rowCount: 1 };
    }

    if (RE_CREATE.test(q)) return { rows: [], rowCount: 0 };

    throw new Error('hatchable: unsupported SQL (only the SPEC §9 statements are implemented): ' + q);
  },
};

// ─── events ──────────────────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TOKEN_TTL_MS = 120_000;
const REPLAY_PER_CHANNEL = 200;

const channelSeq = new Map(); // channel → last event id (ids are per channel, contiguous)
const subscribers = new Map(); // channel → Set<fn(ev)>
const history = new Map(); // channel → ev[] (bounded, for Last-Event-ID replay)
const grants = new Map(); // token → { channels: Set, exp }

function randomToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString('base64url');
}

export const events = {
  /** publish(channel, event, payload) — payload JSON ≤ 64KB. Delivered to in-process subscribers. */
  async publish(channel, event, payload) {
    if (arguments.length < 3 || typeof event !== 'string') {
      throw new TypeError("events.publish(channel, event, payload): missing the event name — e.g. publish('board', 'moved', { id })");
    }
    if (!NAME_RE.test(channel)) throw new TypeError('events.publish: invalid channel name ' + JSON.stringify(channel));
    if (!NAME_RE.test(event)) throw new TypeError('events.publish: invalid event name ' + JSON.stringify(event));
    const text = JSON.stringify(payload === undefined ? null : payload);
    if (Buffer.byteLength(text) > 64 * 1024) throw new RangeError('events.publish: payload exceeds 64KB');
    const seq = (channelSeq.get(channel) || 0) + 1;
    channelSeq.set(channel, seq);
    const ev = { id: String(seq), channel, event, data: JSON.parse(text) };
    let h = history.get(channel);
    if (!h) history.set(channel, (h = []));
    h.push(ev);
    if (h.length > REPLAY_PER_CHANNEL) h.splice(0, h.length - REPLAY_PER_CHANNEL);
    for (const fn of subscribers.get(channel) || []) {
      try {
        fn(ev);
      } catch (err) {
        process.stderr.write(`[hatchable] subscriber error: ${err.message}\n`);
      }
    }
    return { id: ev.id };
  },

  /** grant(channels) → short-lived subscribe token for exactly these channels. */
  async grant(channels) {
    if (!Array.isArray(channels) || channels.length === 0) throw new TypeError('events.grant: channels must be a non-empty array');
    for (const c of channels) if (!NAME_RE.test(c)) throw new TypeError('events.grant: invalid channel name ' + JSON.stringify(c));
    const token = randomToken();
    const exp = Date.now() + TOKEN_TTL_MS;
    grants.set(token, { channels: new Set(channels), exp });
    for (const [t, g] of grants) if (g.exp < Date.now()) grants.delete(t);
    return { token, channels: [...channels], expiresAt: new Date(exp).toISOString(), expiresIn: TOKEN_TTL_MS / 1000 };
  },
};

// ─── server helpers (used by server/index.mjs) ───────────────────────────────

export const server = {
  rooms,
  /** true iff `token` is an unexpired grant that covers `channel`. */
  verifyGrant(token, channel) {
    const g = grants.get(token);
    return !!g && g.exp >= Date.now() && g.channels.has(channel);
  },
  /** subscribe(channel, fn) → unsubscribe */
  subscribe(channel, fn) {
    let set = subscribers.get(channel);
    if (!set) subscribers.set(channel, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) subscribers.delete(channel);
    };
  },
  /**
   * Events on `channel` after `lastId` (ids are per-channel and contiguous). `gap` = true when the
   * client is missing events that are no longer buffered, or its id is from a previous server run.
   */
  since(channel, lastId) {
    const n = Number(lastId);
    if (!Number.isInteger(n) || n < 0) return { events: [], gap: false };
    const h = history.get(channel) || [];
    const last = channelSeq.get(channel) || 0;
    if (n > last) return { events: [], gap: true };
    const after = h.filter((ev) => Number(ev.id) > n);
    const gap = n < last && (h.length === 0 || Number(h[0].id) > n + 1);
    return { events: after, gap };
  }
};
