// public/js/room.js — room data, realtime, the single deadline timer, and the server clock (SPEC §0, §12).
//
// Network rules (SPEC §0): no polling. The view is refetched only when
//   - the page mounts / the tab becomes visible again / the browser comes back online,
//   - a realtime 'update' event announces a version newer than ours, or '$reset' fires,
//   - an action fails with a conflict-ish status (to resync).
// The only timer that touches the network is ONE timeout armed for view.deadline (+150–900 ms
// jitter) which POSTs {type:'tick'}; the server advances time-based transitions lazily.
import { createContext, useContext, useState, useEffect, useRef, useCallback } from './h.js';
import { apiState, apiAct, apiJoin, getSession, setSession, clearSession, normalizeCode } from './api.js';
import { toast } from './ui.js';

export const RoomContext = createContext(null);

/** Inside the room page: { view, act, refresh, joined, join, code, ... } (+ UI openers added by main.js). */
export function useRoom() {
  return useContext(RoomContext);
}

// ─── server clock ────────────────────────────────────────────────────────────
// offset = serverTime − localTime, estimated from view.serverNow at the request midpoint.
// The true offset lies within ±rtt/2 of a sample, so:
//   - a sample whose round trip took longer than MAX_RTT is ignored (a request that was in flight
//     while the device slept or its clock was changed measures nothing useful);
//   - low-latency samples win; a best sample older than 60 s may be replaced by any newer one;
//   - a sample that proves the current estimate wrong (outside both error bars) replaces it at
//     once — the device clock jumped (sleep, NTP, manual change).
// When the estimate moves noticeably, subscribers (the deadline timer) re-arm.

const MAX_RTT = 5000;
let clockOffset = 0;
let bestRtt = Infinity;
let bestAt = 0;
const clockSubs = new Set();

function sampleClock(serverTime, t0, t1) {
  if (!Number.isFinite(serverTime) || !Number.isFinite(t0) || !Number.isFinite(t1)) return;
  const rtt = t1 - t0;
  if (rtt < 0 || rtt > MAX_RTT) return;
  const offset = serverTime - (t0 + t1) / 2;
  const now = Date.now();
  const stale = now - bestAt > 60000;
  const wrong = bestRtt !== Infinity && Math.abs(offset - clockOffset) > rtt / 2 + bestRtt / 2 + 250;
  if (rtt <= bestRtt || stale || wrong) {
    const moved = Math.abs(offset - clockOffset);
    clockOffset = offset;
    bestRtt = rtt;
    bestAt = now;
    if (moved > 500) clockSubs.forEach((fn) => fn());
  }
}

/** Re-render when the server-clock estimate jumps (returns a counter usable as an effect dep). */
function useClockEpoch() {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const fn = () => setEpoch((e) => e + 1);
    clockSubs.add(fn);
    return () => clockSubs.delete(fn);
  }, []);
  return epoch;
}

/** Current time on the server's clock (ms). */
export function serverNow() {
  return Date.now() + clockOffset;
}

/** Align the clock to a view received "just now" (used by the dev preview, which has no requests). */
export function syncClock(serverTime) {
  if (Number.isFinite(serverTime)) {
    clockOffset = serverTime - Date.now();
    bestRtt = Infinity;
    bestAt = 0;
  }
}

/**
 * now (ms, server-corrected). Re-renders every 250 ms ONLY while view.deadline (or the run-it vote
 * deadline) is in the future; otherwise it's just a snapshot taken at render time.
 */
export function useClock(view) {
  const [, setTick] = useState(0);
  const target = Math.max(
    (view && view.deadline) || 0,
    (view && view.hand && view.hand.ritVote && view.hand.ritVote.deadline) || 0,
  );
  useEffect(() => {
    if (!target || serverNow() >= target) return undefined;
    const id = setInterval(() => {
      setTick((t) => t + 1);
      if (serverNow() >= target) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [target]);
  return serverNow();
}

// ─── views handed over from the lobby (create → table without a loading flash) ──

const primed = new Map();

export function primeRoom(code, view) {
  if (code && view) primed.set(normalizeCode(code), view);
}

// ─── the hook ────────────────────────────────────────────────────────────────

const RESYNC_STATUSES = new Set([403, 404, 409]);
/** Refetch delays after a transient failure (429 / 5xx / network), reset by the next success. */
const TRANSIENT_BACKOFF = [400, 1200, 3000];

export function useRoomData(rawCode) {
  const code = normalizeCode(rawCode);
  const [view, setView] = useState(() => primed.get(code) || null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(() => !primed.has(code));
  const [session, setSess] = useState(() => getSession(code));
  const [acting, setActing] = useState(0);

  const viewRef = useRef(view);
  const verRef = useRef(view ? view.version : -1);
  const wantRef = useRef(0); // highest version announced by realtime
  const lagRetryRef = useRef(0);
  const transientRef = useRef(0); // consecutive transient refetch failures (see TRANSIENT_BACKOFF)
  const refreshRef = useRef(null);
  const inflightRef = useRef(null);
  const againRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    primed.delete(code);
    return () => {
      aliveRef.current = false;
    };
  }, [code]);

  /** Adopt a view unless it is older than what we have or was fetched under a different identity. */
  const accept = useCallback(
    (v, t0, t1, tokenUsed) => {
      if (!v || !aliveRef.current) return false;
      sampleClock(v.serverNow, t0, t1);
      const cur = getSession(code);
      if ((cur ? cur.token : null) !== (tokenUsed ?? null)) return false; // joined/left mid-flight
      if (typeof v.version === 'number' && v.version < verRef.current) return false;
      verRef.current = typeof v.version === 'number' ? v.version : verRef.current;
      viewRef.current = v;
      setView(v);
      setError(null);
      if (cur && v.me) {
        // keep the lobby's "your tables" metadata fresh (cheap: only writes on change)
        if (cur.game !== v.name || cur.name !== v.me.name) setSession(code, { pid: cur.pid, token: cur.token, game: v.name, name: v.me.name });
      }
      return true;
    },
    [code],
  );

  const fetchOnce = useCallback(async () => {
    const s = getSession(code);
    const tokenUsed = s ? s.token : null;
    const t0 = Date.now();
    try {
      const { view: v } = await apiState(code);
      const t1 = Date.now();
      if (tokenUsed && v && !v.me) {
        // Our stored token isn't valid for this room any more (room recreated, storage copied…).
        const now = getSession(code);
        if (now && now.token === tokenUsed) {
          clearSession(code);
          if (aliveRef.current) setSess(null);
        }
        accept(v, t0, t1, getSession(code) ? getSession(code).token : null);
      } else if (!accept(v, t0, t1, tokenUsed) && aliveRef.current) {
        const cur = getSession(code);
        if ((cur ? cur.token : null) !== tokenUsed) againRef.current = true; // identity changed: fetch again
      }
      transientRef.current = 0;
    } catch (err) {
      if (!aliveRef.current) return;
      if (err.code === 'not_found' || !viewRef.current) setError(err);
      // A transient failure (rate limit, server hiccup, network) while we already have a view: keep
      // showing it and refetch a few times with backoff, so a missed update can't leave us stale until
      // the next event. Other errors wait for the next event as before.
      const transient = err.status === 429 || err.status >= 500 || !err.status;
      if (transient && viewRef.current && transientRef.current < TRANSIENT_BACKOFF.length) {
        const wait = TRANSIENT_BACKOFF[transientRef.current++];
        setTimeout(() => aliveRef.current && refreshRef.current && refreshRef.current(), wait);
      }
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [code, accept]);

  const refresh = useCallback(() => {
    if (inflightRef.current) {
      againRef.current = true;
      return inflightRef.current;
    }
    const p = (async () => {
      do {
        againRef.current = false;
        await fetchOnce();
      } while (againRef.current && aliveRef.current);
      inflightRef.current = null;
      // Read-after-publish lag: the event said v=N but we got less. Retry once for that N.
      const want = wantRef.current;
      if (aliveRef.current && want > verRef.current && lagRetryRef.current !== want) {
        lagRetryRef.current = want;
        setTimeout(() => aliveRef.current && refresh(), 400);
      }
    })();
    inflightRef.current = p;
    return p;
  }, [fetchOnce]);
  refreshRef.current = refresh;

  // initial load + resync when the tab comes back / the network returns
  useEffect(() => {
    refresh();
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onOnline = () => refresh();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh]);

  // realtime subscription
  useEffect(() => {
    const events = window.hatchable && window.hatchable.events;
    if (!events || typeof events.connect !== 'function') {
      console.warn('[felt] realtime unavailable — updates arrive only on your own actions.');
      return undefined;
    }
    let conn = null;
    let ch = null;
    const onUpdate = (ev) => {
      const v = ev && ev.data ? ev.data.v : undefined;
      if (typeof v === 'number') {
        if (v <= verRef.current) return;
        wantRef.current = Math.max(wantRef.current, v);
      }
      refresh();
    };
    const onReset = () => refresh();
    try {
      conn = events.connect({ authUrl: '/api/events-token?code=' + encodeURIComponent(code) });
      ch = conn.channel('room:' + code);
      ch.on('update', onUpdate);
      ch.on('$reset', onReset);
    } catch (err) {
      console.warn('[felt] realtime connect failed', err);
    }
    return () => {
      try {
        if (ch && ch.off) {
          ch.off('update', onUpdate);
          ch.off('$reset', onReset);
        }
        if (conn && conn.close) conn.close();
      } catch {
        /* ignore */
      }
    };
  }, [code, refresh]);

  const act = useCallback(
    async (type, args = {}, opts = {}) => {
      const silent = !!opts.silent || type === 'tick';
      const s = getSession(code);
      const tokenUsed = s ? s.token : null;
      if (!silent) setActing((n) => n + 1);
      const t0 = Date.now();
      try {
        const res = await apiAct(code, type, args);
        accept(res.view, t0, Date.now(), tokenUsed);
        return res.view || null;
      } catch (err) {
        if (!silent && aliveRef.current) toast(err.message || 'Something went wrong.');
        if (RESYNC_STATUSES.has(err.status)) refresh();
        return null;
      } finally {
        if (!silent && aliveRef.current) setActing((n) => Math.max(0, n - 1));
      }
    },
    [code, accept, refresh],
  );

  const join = useCallback(
    async (name) => {
      const t0 = Date.now();
      try {
        const res = await apiJoin(code, name);
        const s = getSession(code);
        if (aliveRef.current) setSess(s);
        accept(res.view, t0, Date.now(), s ? s.token : null);
        try {
          localStorage.setItem('felt:name', String(name || '').trim());
        } catch {
          /* ignore */
        }
        return res.view || null;
      } catch (err) {
        toast(err.message || 'Couldn’t join the game.');
        return null;
      }
    },
    [code, accept],
  );

  // ONE timeout for the next server-side transition. Re-armed whenever view.deadline changes (or
  // the server-clock estimate jumps, so a corrected clock never leaves it armed for the wrong time).
  const deadline = view && !view.ended ? view.deadline : null;
  const clockEpoch = useClockEpoch();
  useEffect(() => {
    if (!deadline) return undefined;
    let cancelled = false;
    let timer = null;
    let attempt = 0;
    const arm = () => {
      const wait = Math.max(0, deadline - serverNow()) + 150 + Math.random() * 750 + attempt * 1500;
      timer = setTimeout(async () => {
        attempt += 1;
        await act('tick', {}, { silent: true });
        // Normally the response carries a new deadline and this effect re-runs. If it didn't move
        // (clock skew, lost response), retry a few times with backoff, then wait for events.
        if (!cancelled && viewRef.current && viewRef.current.deadline === deadline && attempt < 4) arm();
      }, Math.min(wait, 2147483000));
    };
    arm();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deadline, act, clockEpoch]);

  const joined = view ? !!view.me : !!session;
  return { code, view, error, loading, act, refresh, joined, join, session, acting: acting > 0 };
}
