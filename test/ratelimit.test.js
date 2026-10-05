// Rate limiting (lib/ratelimit.js) and the realtime publish retry (lib/store.js publishUpdate).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RATE, RATE_LIMITED, rateWait, spendRate } from '../lib/ratelimit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const T0 = 1_700_000_000_000;

test('a player gets a burst, then about one limited action per refill interval', () => {
  const s = {};
  let now = T0;
  let ok = 0;
  for (let i = 0; i < 100; i++) {
    if (rateWait(s, 'troll', now) === 0) {
      spendRate(s, 'troll', now);
      ok++;
    }
  }
  assert.equal(ok, RATE.player.cap, 'a burst of exactly cap actions');
  const wait = rateWait(s, 'troll', now);
  assert.ok(wait > 0 && wait <= RATE.player.every);
  // another player is not affected by the troll (only the room bucket is shared)
  assert.equal(rateWait(s, 'friend', now), 0);
  now += RATE.player.every;
  assert.equal(rateWait(s, 'troll', now), 0, 'one token back after one interval');
  spendRate(s, 'troll', now);
  assert.ok(rateWait(s, 'troll', now) > 0);
  // over 10 s a looping client gets at most cap + 10s/every changes through
  let n = 0;
  for (let t = 0; t < 10_000; t += 50) {
    if (rateWait(s, 'troll', now + t) === 0) {
      spendRate(s, 'troll', now + t);
      n++;
    }
  }
  assert.ok(n <= Math.ceil(10_000 / RATE.player.every) + 1, `sustained rate ${n} per 10 s`);
});

test('the room bucket caps everyone together (joins included)', () => {
  const s = {};
  let ok = 0;
  for (let i = 0; i < 200; i++) {
    const pid = 'p' + i; // a fresh player each time: only the room bucket stops them
    if (rateWait(s, pid, T0) === 0) {
      spendRate(s, pid, T0);
      ok++;
    }
  }
  assert.equal(ok, RATE.room.cap);
  assert.ok(rateWait(s, null, T0) > 0, 'anonymous joins wait too');
  assert.ok(Object.keys(s.rate.players).length <= RATE.room.cap, 'player buckets stay bounded');
});

test('game moves, ticks and host tools are not rate limited; cheap repeatable actions are', () => {
  for (const t of ['act', 'vote', 'tick', 'approve', 'adjust', 'remove', 'markPaid']) assert.ok(!RATE_LIMITED.has(t), t);
  for (const t of ['chat', 'away', 'sit', 'cancelRequest', 'leave', 'cancelLeave', 'buyin', 'show']) assert.ok(RATE_LIMITED.has(t), t);
});

test('publishUpdate retries a publish refused by the project-wide rate limit, and reports a final failure', () => {
  const script = `
    import { events } from 'hatchable';
    import { publishUpdate } from 'lib/store.js';
    const real = events.publish.bind(events);
    let calls = 0;
    events.publish = async (...a) => { calls++; if (calls <= 2) { const e = new Error('rate limited'); e.code = 'rate_limited'; e.retryAfter = 0.05; throw e; } return real(...a); };
    const t0 = Date.now();
    const ok = await publishUpdate('ABC-1234', 7);
    const first = { ok, calls, ms: Date.now() - t0 };
    calls = 0;
    events.publish = async () => { calls++; const e = new Error('rate limited'); e.code = 'rate_limited'; e.retryAfter = 0.01; throw e; };
    const ok2 = await publishUpdate('ABC-1234', 8);
    const second = { ok: ok2, calls };
    calls = 0;
    events.publish = async () => { calls++; throw new TypeError('bad channel'); };
    const third = { ok: await publishUpdate('ABC-1234', 9), calls };
    console.log(JSON.stringify({ first, second, third }));
  `;
  const r = spawnSync(process.execPath, ['--import', './dev/register.mjs', '--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual([out.first.ok, out.first.calls], [true, 3], 'delivered on the third try');
  assert.ok(out.first.ms >= 90, 'waited for retryAfter between tries');
  assert.deepEqual(out.second, { ok: false, calls: 3 }, 'gives up after a bounded number of tries');
  assert.deepEqual(out.third, { ok: false, calls: 1 }, 'other errors are not retried');
});
