// public/js/api.js — HTTP client + per-room session storage (SPEC §9, §12).
//
// Session: localStorage['felt:' + CODE] = JSON.stringify({ pid, token, ...meta }). Only pid/token are
// required by the contract; `game`, `name` and `t` are display metadata for the lobby's
// "your tables" list and are ignored by everything else.

export class ApiError extends Error {
  constructor(message, code = 'internal', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const KEY = (code) => 'felt:' + String(code || '').toUpperCase();
const CODE_RE = /^[A-Z]{3}-[0-9]{4}$/;

/** 'rvr4821' / 'RVR 4821' / 'rvr-4821' → 'RVR-4821'. Anything else is returned upper-cased and trimmed. */
export function normalizeCode(input) {
  const raw = String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{3}[0-9]{4}$/.test(raw)) return raw.slice(0, 3) + '-' + raw.slice(3);
  return String(input || '').trim().toUpperCase();
}

export function isValidCode(code) {
  return CODE_RE.test(String(code || ''));
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getSession(code) {
  const ls = storage();
  if (!ls || !code) return null;
  try {
    const s = JSON.parse(ls.getItem(KEY(code)) || 'null');
    return s && typeof s.pid === 'string' && typeof s.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

export function setSession(code, s) {
  const ls = storage();
  if (!ls || !code || !s) return;
  const prev = getSession(code);
  const next = { ...(prev && prev.pid === s.pid ? prev : {}), ...s, t: Date.now() };
  try {
    ls.setItem(KEY(code), JSON.stringify(next));
  } catch {
    /* storage full / disabled — the session just won't survive a reload */
  }
}

export function clearSession(code) {
  const ls = storage();
  if (!ls || !code) return;
  try {
    ls.removeItem(KEY(code));
  } catch {
    /* ignore */
  }
}

/** Every stored room session, newest first: [{ code, pid, token, game?, name?, t? }]. */
export function listSessions() {
  const ls = storage();
  if (!ls) return [];
  const out = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (!k || !k.startsWith('felt:')) continue;
      const code = k.slice(5);
      if (!CODE_RE.test(code)) continue;
      const s = getSession(code);
      if (s) out.push({ ...s, code });
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => (b.t || 0) - (a.t || 0));
}

// ─── transport ───────────────────────────────────────────────────────────────

async function request(method, url, { body, code } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const s = code ? getSession(code) : null;
  if (s) headers['x-felt-token'] = s.token;

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Can’t reach the server. Check your connection and try again.', 'network', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok || !data || data.error) {
    const msg =
      (data && data.error) ||
      (res.status === 404 ? 'Not found.' : res.status >= 500 ? 'Something went wrong on the server. Please try again.' : 'Request failed (' + res.status + ').');
    throw new ApiError(msg, (data && data.code) || statusCode(res.status), res.status);
  }
  return data;
}

function statusCode(status) {
  return status === 400 ? 'bad_request' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'internal';
}

export async function apiCreate({ hostName, gameName, settings }) {
  const data = await request('POST', '/api/create', { body: { hostName, gameName, settings } });
  setSession(data.code, { pid: data.pid, token: data.token, game: data.view && data.view.name, name: hostName });
  return data;
}

export async function apiJoin(code, name) {
  code = normalizeCode(code);
  const data = await request('POST', '/api/join', { body: { code, name }, code });
  setSession(code, { pid: data.pid, token: data.token, game: data.view && data.view.name, name: (data.view && data.view.me && data.view.me.name) || name });
  return data;
}

export async function apiState(code) {
  code = normalizeCode(code);
  return request('GET', '/api/state?code=' + encodeURIComponent(code), { code });
}

export async function apiAct(code, type, args = {}) {
  code = normalizeCode(code);
  return request('POST', '/api/act', { body: { ...args, code, type }, code });
}
