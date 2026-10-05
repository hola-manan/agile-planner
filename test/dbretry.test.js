// lib/store.js retries a database call the platform briefly refuses (rate limited) instead of
// failing the request. Runs the real store.js against the dev fake in a child process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const script = `
import { db } from 'hatchable';
import { loadRoom, insertRoom, mutateRoom } from 'lib/store.js';
const real = db.query.bind(db);
let fails = 0;
const limited = () => { const e = new Error('Too many requests'); e.code = 'rate_limited'; return e; };

// 1) two refusals, then success → the read succeeds
db.query = async (sql, params) => { if (fails < 2) { fails++; throw limited(); } return real(sql, params); };
await insertRoom({ code: 'DBR-0001', name: 'x', players: {} });
fails = 0;
const got = await loadRoom('DBR-0001');
const ok1 = !!got && got.state.code === 'DBR-0001' && fails === 2;

// 2) writes retry too
fails = 0;
const out = await mutateRoom('DBR-0001', (s) => { s.name = 'y'; return true; });
const ok2 = out.state.name === 'y';

// 3) a refusal that never clears still fails (bounded retries)
db.query = async () => { throw limited(); };
let threw = false;
try { await loadRoom('DBR-0001'); } catch (e) { threw = e.code === 'rate_limited'; }

// 4) other errors are not retried
let calls = 0;
db.query = async () => { calls++; throw new TypeError('syntax error at or near'); };
let other = false;
try { await loadRoom('DBR-0001'); } catch (e) { other = e instanceof TypeError; }

console.log(JSON.stringify({ ok1, ok2, threw, other, calls }));
`;

test('store retries rate-limited database calls, bounded, and only for rate limits', () => {
  const r = spawnSync(process.execPath, ['--import', './dev/register.mjs', '--input-type=module', '-e', script], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim().split('\n').pop();
  const res = JSON.parse(line);
  assert.deepEqual(res, { ok1: true, ok2: true, threw: true, other: true, calls: 1 });
});
