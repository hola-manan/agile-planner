// End-to-end HTTP tests: spawns the local dev server (dev/server.mjs with the fake Hatchable SDK)
// and drives the real api/*.js routes + lib/store.js + engine over HTTP, including realtime (SSE)
// delivery and the browser events shim.  Run: node --test test/api.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let server;
let BASE;

before(async () => {
  server = spawn(process.execPath, ['--import', './dev/register.mjs', 'dev/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', FELT_DEV_TIME: '1', FELT_QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => (stderr += d));
  BASE = await new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error('dev server did not start:\n' + out + stderr)), 10000);
    server.stdout.on('data', (d) => {
      out += d;
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    server.on('exit', (c) => reject(new Error('dev server exited ' + c + ':\n' + out + stderr)));
  });
});

after(() => {
  server?.kill('SIGTERM');
});

async function call(method, p, { body, token } = {}) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers['x-felt-token'] = token;
  const r = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: r.status, json, text };
}
const post = (p, body, token) => call('POST', p, { body, token });
const get = (p, token) => call('GET', p, { token });
const act = (code, token, type, args = {}) => post('/api/act', { code, type, ...args }, token);
const advanceClock = (ms) => post('/__dev/time', { advance: ms });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open an SSE stream for `channel`; returns { events, close, waitFor(pred) }. */
async function openSse(code) {
  const grant = await get('/api/events-token?code=' + code);
  assert.equal(grant.status, 200);
  const ac = new AbortController();
  const r = await fetch(`${BASE}/__dev/sse?channel=${encodeURIComponent('room:' + code)}&token=${encodeURIComponent(grant.json.token)}`, { signal: ac.signal });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const waiters = [];
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          if (!data) continue;
          events.push(JSON.parse(data));
          for (const w of waiters.splice(0)) w();
        }
      }
    } catch {}
  })();
  return {
    events,
    close: () => ac.abort(),
    async waitFor(pred, ms = 2000) {
      const deadline = Date.now() + ms;
      while (!events.some(pred)) {
        if (Date.now() > deadline) throw new Error('timed out waiting for SSE event; got ' + JSON.stringify(events));
        await new Promise((res) => {
          waiters.push(res);
          setTimeout(res, 50);
        });
      }
      return events.find(pred);
    },
  };
}

const SETTINGS = {
  variant: 'NLH', sb: 1, bb: 2, seats: 6, minBuyIn: 100, maxBuyIn: 400, approveBuyIns: true, maxRuns: 2,
  revealRunout: 'anyone', showdownLosers: 'choose', actionTime: 25, nextHandDelay: 8, autoAwayTimeouts: 2,
};

const room = {}; // shared across the sequential tests below

test('create: validates input', async () => {
  let r = await post('/api/create', { gameName: 'x', settings: {} });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'bad_request');
  assert.equal(typeof r.json.error, 'string');
  r = await post('/api/create', { hostName: 'a'.repeat(21), settings: {} });
  assert.equal(r.status, 400);
  r = await post('/api/create', { hostName: 'Dana', settings: 'nope' });
  assert.equal(r.status, 400);
  r = await get('/api/create');
  assert.equal(r.status, 405);
});

test('create: returns code, credentials and a host view without secrets', async () => {
  const r = await post('/api/create', { hostName: '  Dana  ', gameName: 'Friday Night Game', settings: SETTINGS });
  assert.equal(r.status, 200, r.text);
  const { code, pid, token, view } = r.json;
  assert.match(code, /^[A-Z]{3}-[0-9]{4}$/);
  assert.match(pid, /^[A-Za-z0-9_-]{12}$/);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(view.code, code);
  assert.equal(view.version, 1);
  assert.equal(view.isHost, true);
  assert.equal(view.hostId, pid);
  assert.equal(view.me.id, pid);
  assert.equal(view.me.name, 'Dana');
  assert.equal(view.name, 'Friday Night Game');
  const viewText = JSON.stringify(view);
  assert.ok(!viewText.includes('tokenHash'), 'view must not leak tokenHash');
  assert.ok(!viewText.includes(token), 'view must not contain the token');
  Object.assign(room, { code, host: { pid, token } });
});

test('join: new players, idempotent rejoin, validation', async () => {
  const { code } = room;
  // code normalisation: lowercase, no dash
  let r = await post('/api/join', { code: code.toLowerCase().replace('-', ''), name: 'Ravi' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.view.me.name, 'Ravi');
  assert.equal(r.json.view.isHost, false);
  room.p1 = { pid: r.json.pid, token: r.json.token };

  r = await post('/api/join', { code, name: 'Mo' });
  assert.equal(r.status, 200, r.text);
  room.p2 = { pid: r.json.pid, token: r.json.token };
  assert.notEqual(room.p1.pid, room.p2.pid);

  // valid token for this room → same player back, no new player
  r = await post('/api/join', { code, name: 'Someone Else' }, room.p1.token);
  assert.equal(r.status, 200);
  assert.equal(r.json.pid, room.p1.pid);
  assert.equal(r.json.token, room.p1.token);
  assert.equal(r.json.view.players.length, 3);

  r = await post('/api/join', { code, name: 'ravi' });
  assert.equal(r.status, 409, 'duplicate names are rejected');
  r = await post('/api/join', { code, name: '   ' });
  assert.equal(r.status, 400);
  r = await post('/api/join', { code, name: 'x'.repeat(21) });
  assert.equal(r.status, 400);
  r = await post('/api/join', { code: 'ZZZ-0000', name: 'Kim' });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'not_found');
  r = await post('/api/join', { code: 'hello', name: 'Kim' });
  assert.equal(r.status, 400);
});

test('state: anonymous vs authenticated views, 404/400', async () => {
  const { code } = room;
  let r = await get('/api/state?code=' + code);
  assert.equal(r.status, 200);
  assert.equal(r.json.view.me, null);
  assert.equal(r.json.view.isHost, false);
  r = await get('/api/state?code=' + code, room.p2.token);
  assert.equal(r.json.view.me.id, room.p2.pid);
  r = await get('/api/state?code=' + code, 'not-a-real-token-but-long-enough');
  assert.equal(r.json.view.me, null);
  assert.equal((await get('/api/state?code=QQQ-1234')).status, 404);
  assert.equal((await get('/api/state?code=bad')).status, 400);
  assert.equal((await get('/api/state')).status, 400);
});

test('events-token: grants the room channel, 404 for unknown rooms', async () => {
  const r = await get('/api/events-token?code=' + room.code);
  assert.equal(r.status, 200);
  assert.equal(typeof r.json.token, 'string');
  assert.deepEqual(r.json.channels, ['room:' + room.code]);
  assert.equal((await get('/api/events-token?code=ABC-0000')).status, 404);
});

test('act: auth and error mapping', async () => {
  const { code } = room;
  let r = await act(code, null, 'chat', { text: 'hi' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'forbidden');
  r = await act(code, room.p1.token, 'approve', { id: 'whatever' });
  assert.ok([403, 404].includes(r.status), 'non-host approve is rejected: ' + r.status);
  r = await post('/api/act', { code, type: '' }, room.p1.token);
  assert.equal(r.status, 400);
  r = await post('/api/act', '{not json', room.p1.token);
  assert.equal(r.status, 400);
  r = await post('/api/act', { type: 'chat', text: 'x' }, room.p1.token);
  assert.equal(r.status, 400, 'missing code');
  assert.equal((await get('/api/act')).status, 405);
  assert.equal((await get('/api/does-not-exist')).status, 404);
});

test('flow: sit → approve → hand starts on tick, SSE delivers every committed version', async () => {
  const { code, host, p1, p2 } = room;
  const sse = await openSse(code);
  try {
    let r = await act(code, p1.token, 'sit', { seat: 1, amount: 200 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.view.me.request?.kind, 'sit');
    await sse.waitFor((ev) => ev.event === 'update' && ev.data.v === r.json.view.version);

    r = await act(code, p2.token, 'sit', { seat: 3, amount: 300 });
    assert.equal(r.status, 200, r.text);
    // non-host only sees their own request; host sees all
    assert.equal(r.json.view.requests.length, 1);
    r = await get('/api/state?code=' + code, host.token);
    const reqs = r.json.view.requests;
    assert.equal(reqs.length, 2);

    for (const q of reqs) {
      r = await act(code, host.token, 'approve', { id: q.id });
      assert.equal(r.status, 200, r.text);
    }
    const v = r.json.view;
    assert.deepEqual(v.seats.filter((s) => s.pid).map((s) => s.seat), [1, 3]);
    assert.equal(v.deadlineKind, 'nextHand');
    assert.equal(v.hand, null);
    await sse.waitFor((ev) => ev.data.v === v.version);

    // Before the deadline, GET /api/state is a pure read (no version bump).
    r = await get('/api/state?code=' + code);
    assert.equal(r.json.view.version, v.version);

    // Pass the deadline: GET runs the tick once, saves, publishes.
    await advanceClock(3500);
    r = await get('/api/state?code=' + code, p1.token);
    const hv = r.json.view;
    assert.equal(hv.version, v.version + 1);
    assert.ok(hv.hand, 'hand started');
    assert.equal(hv.handNo, 1);
    assert.equal(hv.deadlineKind, 'action');
    assert.equal(hv.me.hole.length, 2);
    for (const hp of hv.hand.players) {
      if (hp.pid !== p1.pid) assert.ok(hp.cards.every((c) => c === null), "opponent's cards are hidden");
    }
    assert.ok(!('deck' in hv.hand), 'deck never in view');
    await sse.waitFor((ev) => ev.data.v === hv.version);

    // A second GET does not write again.
    r = await get('/api/state?code=' + code);
    assert.equal(r.json.view.version, hv.version);
    for (const hp of r.json.view.hand.players) assert.ok(hp.cards.every((c) => c === null), 'spectator sees no hole cards');

    room.hand = hv;
  } finally {
    sse.close();
  }
});

test('flow: turn order, actions and the action timeout via tick', async () => {
  const { code, p1, p2 } = room;
  const toAct = room.hand.hand.toAct;
  const [actor, other] = toAct === p1.pid ? [p1, p2] : [p2, p1];

  let r = await act(code, other.token, 'act', { move: 'call' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'not_your_turn');

  r = await get('/api/state?code=' + code, actor.token);
  const legal = r.json.view.hand.legal;
  assert.ok(legal && legal.fold, 'actor has legal moves');
  r = await act(code, actor.token, 'act', { move: legal.check ? 'check' : 'call' });
  assert.equal(r.status, 200, r.text);
  const afterCall = r.json.view;
  assert.equal(afterCall.hand.toAct, other.pid);
  assert.equal(afterCall.hand.legal, null, 'not my turn → no legal moves');

  // Tick before the deadline: no write.
  r = await act(code, null, 'tick');
  assert.equal(r.status, 200);
  assert.equal(r.json.view.version, afterCall.version);
  assert.equal(r.json.view.me, null);

  // Let the other player's clock run out. Acting late is rejected (the timeout already acted for
  // them) but the overdue transition is still committed, so the table never stalls.
  await advanceClock(SETTINGS.actionTime * 1000 + 500);
  r = await act(code, other.token, 'act', { move: 'raise', to: -5 }); // always invalid
  assert.ok([400, 409].includes(r.status), r.text);
  r = await get('/api/state?code=' + code, other.token);
  const late = r.json.view;
  assert.ok(late.version > afterCall.version, 'catch-up tick committed');
  assert.equal(late.me.timeouts, 1);
  const h = late.hand;
  assert.ok(!h || h.toAct !== other.pid || h.street !== afterCall.hand.street, 'timed-out player was auto-acted');

  // Next deadline: anyone (even anonymous) may tick it.
  const due = late.deadline - late.serverNow + 100;
  await advanceClock(Math.max(due, 0));
  r = await act(code, null, 'tick');
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.view.version > late.version, 'anonymous tick committed a change');
});

test('mutateRoom: concurrent writers all commit (optimistic retry), versions are unique', async () => {
  const { code, host, p1, p2 } = room;
  const start = (await get('/api/state?code=' + code)).json.view.version;
  const who = [host, p1, p2, host, p1, p2, host, p1];
  const results = await Promise.all(who.map((pl, i) => act(code, pl.token, 'chat', { text: 'msg ' + i })));
  for (const r of results) assert.equal(r.status, 200, r.text);
  const versions = results.map((r) => r.json.view.version);
  assert.equal(new Set(versions).size, who.length, 'each write got its own version');
  const end = (await get('/api/state?code=' + code)).json.view;
  assert.equal(end.version, start + who.length);
  const texts = end.chat.map((c) => c.text);
  for (let i = 0; i < who.length; i++) assert.ok(texts.includes('msg ' + i));
});

test('SSE: Last-Event-ID replay and $reset on an unknown id', async () => {
  const { code } = room;
  const grant = (await get('/api/events-token?code=' + code)).json;
  const url = `${BASE}/__dev/sse?channel=${encodeURIComponent('room:' + code)}&token=${encodeURIComponent(grant.token)}`;
  const read = async (headers, extra = '') => {
    const ac = new AbortController();
    const r = await fetch(url + extra, { headers, signal: ac.signal });
    const reader = r.body.getReader();
    let text = '';
    const t = setTimeout(() => ac.abort(), 300);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch {}
    clearTimeout(t);
    return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
  };
  const replay = await read({ 'last-event-id': '1' });
  assert.ok(replay.length >= 2 && replay.every((e) => e.event === 'update'));
  assert.equal(replay[0].id, '2');
  const reset = await read({}, '&lastEventId=999999');
  assert.equal(reset[0].event, '$reset');
  const bad = await fetch(url.replace(/token=[^&]+/, 'token=nope'));
  assert.equal(bad.status, 401);
});

test('browser shim /__hatchable/events.js delivers updates (run under Node EventSource)', async () => {
  const { code, host } = room;
  const script = `
    const base = process.env.SHIM_BASE, code = process.env.SHIM_CODE, token = process.env.SHIM_TOKEN;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (u, o) => realFetch(new URL(u, base), o);
    const RealES = globalThis.EventSource;
    globalThis.EventSource = class extends RealES { constructor(u, o) { super(new URL(u, base), o); } };
    globalThis.window = globalThis;
    new Function(await (await realFetch(base + '/__hatchable/events.js')).text())();
    const conn = hatchable.events.connect({ authUrl: '/api/events-token?code=' + code });
    const got = [];
    conn.channel('room:' + code).on('update', (ev) => got.push(ev));
    await new Promise((r) => setTimeout(r, 400));
    const r = await realFetch(base + '/api/act', { method: 'POST', headers: { 'content-type': 'application/json', 'x-felt-token': token }, body: JSON.stringify({ code, type: 'chat', text: 'via shim' }) });
    const { view } = await r.json();
    for (let i = 0; i < 40 && !got.some((e) => e.data.v === view.version); i++) await new Promise((r) => setTimeout(r, 50));
    conn.close();
    console.log(JSON.stringify({ version: view.version, got }));
  `;
  const child = spawn(process.execPath, ['--experimental-eventsource', '--no-warnings', '--input-type=module', '-e', script], {
    env: { ...process.env, SHIM_BASE: BASE, SHIM_CODE: code, SHIM_TOKEN: host.token },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exitCode = await new Promise((res) => child.on('exit', res));
  assert.equal(exitCode, 0, err);
  const { version, got } = JSON.parse(out.trim().split('\n').pop());
  const ev = got.find((e) => e.data.v === version);
  assert.ok(ev, 'shim delivered the update: ' + out);
  assert.equal(ev.channel, 'room:' + code);
  assert.equal(ev.event, 'update');
});

test('static: public, vendor MIME types, design and dev paths, traversal blocked', async () => {
  let r = await fetch(BASE + '/vendor/react.js');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/javascript/);
  r = await fetch(BASE + '/__hatchable/events.js');
  assert.match(r.headers.get('content-type'), /text\/javascript/);
  r = await fetch(BASE + '/__design/');
  assert.equal(r.status, 200);
  r = await fetch(BASE + '/__dev/events-shim.js');
  assert.equal(r.status, 200);
  r = await fetch(BASE + '/js/definitely-missing.js');
  assert.equal(r.status, 404);
  r = await fetch(BASE + '/%2e%2e/SPEC.md');
  assert.equal(r.status, 404);
});

// ─── review regressions ──────────────────────────────────────────────────────

async function freshRoom(hostName = 'Host') {
  const r = await post('/api/create', { hostName, gameName: 'Review', settings: SETTINGS });
  assert.equal(r.status, 200, r.text);
  return { code: r.json.code, host: { pid: r.json.pid, token: r.json.token } };
}

test('one client looping chat is rate limited (429) instead of using up the project-wide publish budget', async () => {
  const a = await freshRoom();
  const b = await freshRoom();
  const troll = await post('/api/join', { code: a.code, name: 'Troll' });
  assert.equal(troll.status, 200);
  const sse = await openSse(a.code);
  const statuses = [];
  for (let i = 0; i < 40; i++) statuses.push((await act(a.code, troll.json.token, 'chat', { text: 'spam ' + i })).status);
  const ok = statuses.filter((s) => s === 200).length;
  assert.ok(ok >= 5 && ok <= 12, `a short burst gets through, then it stops (${ok} accepted)`);
  assert.ok(statuses.slice(ok).every((s) => s === 429), 'the rest are 429: ' + statuses.join(','));
  const last = await act(a.code, troll.json.token, 'chat', { text: 'again' });
  assert.equal(last.json.code, 'rate_limited');
  assert.match(last.json.error, /Slow down/);
  // other people in the room still chat; another room is untouched
  assert.equal((await act(a.code, a.host.token, 'chat', { text: 'host here' })).status, 200);
  assert.equal((await act(b.code, b.host.token, 'chat', { text: 'other table' })).status, 200);
  await sleep(150);
  const published = sse.events.filter((e) => e && e.data && typeof e.data.v === 'number').length;
  assert.ok(published >= ok && published <= ok + 2, `one publish per accepted change, none for refused ones (${published})`);
  sse.close();
  // the bucket refills over time
  await advanceClock(20_000);
  assert.equal((await act(a.code, troll.json.token, 'chat', { text: 'calm now' })).status, 200);
});

test('join: lookalike names (zero-width / case / full-width), invisible names and "You" are refused', async () => {
  const { code } = await freshRoom('Alice');
  for (const name of ['Ali‍ce', 'ALICE⁠', 'Ａｌｉｃｅ']) {
    const r = await post('/api/join', { code, name });
    assert.equal(r.status, 409, `${JSON.stringify(name)} → ${r.status} ${r.text}`);
  }
  for (const name of ['ㅤ', '‌', 'You', ' you ']) {
    const r = await post('/api/join', { code, name });
    assert.equal(r.status, 400, `${JSON.stringify(name)} → ${r.status} ${r.text}`);
  }
  assert.equal((await post('/api/create', { hostName: 'YOU', settings: SETTINGS })).status, 400);
  const ok = await post('/api/join', { code, name: 'Al​ex' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.view.me.name, 'Alex');
});

test('the host can remove a joined player without a seat: their token stops working, the slot and name free up', async () => {
  const { code, host } = await freshRoom();
  const joins = [];
  for (let i = 0; i < 29; i++) {
    const r = await post('/api/join', { code, name: 'G' + i });
    assert.equal(r.status, 200, r.text);
    joins.push(r.json);
    if (i % 20 === 19) await advanceClock(20_000); // the room bucket also paces joins
  }
  const full = await post('/api/join', { code, name: 'Friend' });
  assert.equal(full.status, 409);
  assert.match(full.json.error, /full/);
  const r = await act(code, host.token, 'remove', { pid: joins[0].pid });
  assert.equal(r.status, 200, r.text);
  assert.ok(!r.json.view.players.some((p) => p.id === joins[0].pid));
  assert.equal((await act(code, joins[0].token, 'chat', { text: 'hi' })).status, 403);
  assert.equal((await get('/api/state?code=' + code, joins[0].token)).json.view.me, null);
  const again = await post('/api/join', { code, name: 'G0' }); // the slot and the name are free
  assert.equal(again.status, 200, again.text);
});
