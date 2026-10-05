// Live smoke test against a DEPLOYED Felt site (not the dev server).
//
//   node test/live-smoke.mjs '<preview-or-public URL>'
//
// The URL may be a Hatchable preview link (…/?_preview=…): each browser context opens it first so the
// platform's sign-in wall lets it through, then plays on the same origin. Three players in separate
// contexts (two desktop, one phone) create a game, sit, get approved, and play real hands through the UI,
// including an all-in that both players vote to run twice. Fails on page errors, console errors
// (Google Fonts excepted), unhandled rejections, a reload, or any realtime update that never arrives.
// Screenshots go to dev/shots/live-*.png.

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'dev', 'shots');
const ENTRY = process.argv[2];
if (!ENTRY) {
  console.error('usage: node test/live-smoke.mjs <site or preview URL>');
  process.exit(2);
}
const ORIGIN = new URL(ENTRY).origin;
const T = 20000;

const require = createRequire(import.meta.url);
function loadPlaywright() {
  for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
    try {
      return require(p);
    } catch {}
  }
  throw new Error('Playwright not installed');
}
const { chromium } = loadPlaywright();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's', ...a);
class Fail extends Error {}
const assert = (c, m) => {
  if (!c) throw new Fail(m);
};
async function until(desc, fn, timeout = T, every = 200) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Fail('timed out waiting for ' + desc + (last ? ' (' + last.message + ')' : ''));
}

const problems = [];
const players = [];
let browser;
let CODE;

function proxyCaSpki(file) {
  try {
    const pem = fs.readFileSync(file, 'utf8');
    const key = crypto.createPublicKey(new crypto.X509Certificate(pem).publicKey.export({ type: 'spki', format: 'pem' }));
    return crypto.createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64');
  } catch {
    return null;
  }
}

async function launch() {
  const args = [];
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    const u = new URL(proxy);
    args.push('--proxy-server=' + u.protocol + '//' + u.host);
    // Trust exactly the sandbox proxy's CA (it re-terminates TLS) by its public-key hash — not a blanket
    // certificate bypass. Set LIVE_PROXY_CA to override the CA file.
    const spki = proxyCaSpki(process.env.LIVE_PROXY_CA || '/root/.ccr/agent-proxy-ca.crt');
    if (spki) args.push('--ignore-certificate-errors-spki-list=' + spki);
  }
  // The full Chrome build reads the user's NSS store (~/.pki/nssdb), which trusts the sandbox proxy's CA;
  // the headless shell does not. Prefer it, fall back to Playwright's default.
  try {
    return await chromium.launch({ args, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  } catch {
    return chromium.launch({ args });
  }
}

async function newPlayer(name, mobile) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await ctx.newPage();
  const p = { name, mobile, ctx, page };
  page.on('pageerror', (e) => problems.push(`${name}: pageerror ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/fonts\.(googleapis|gstatic)\.com/.test(t) || /favicon/.test(t)) return;
    problems.push(`${name}: console.error ${t}`);
  });
  page.on('response', (r) => {
    if (r.url().startsWith(ORIGIN + '/api/') && r.status() >= 500) problems.push(`${name}: ${r.status()} ${r.url()}`);
  });
  // Pass the platform wall (preview links set a cookie), then mark the page to detect reloads later.
  await page.goto(ENTRY, { waitUntil: 'load' });
  players.push(p);
  return p;
}

const press = (p, loc) => (p.mobile ? loc.tap() : loc.click());
const bar = (p) => p.page.locator('section.abar');
const dialog = (p) => p.page.getByRole('dialog');
async function mark(p) {
  await p.page.evaluate(() => (window.__live = true));
}
async function assertNoReload(p) {
  assert(await p.page.evaluate(() => window.__live === true), p.name + ' reloaded');
}
async function viewOf(p) {
  // The test polls far harder than a real client; ride out a transient 429/5xx instead of failing.
  for (let attempt = 0; ; attempt++) {
    const v = await p.page.evaluate(async (code) => {
      const s = JSON.parse(localStorage.getItem('felt:' + code) || 'null');
      const r = await fetch('/api/state?code=' + code, { headers: s ? { 'x-felt-token': s.token } : {} });
      return r.ok ? (await r.json()).view : null;
    }, CODE);
    if (v || attempt >= 5) return v;
    await sleep(500 * (attempt + 1));
  }
}
async function shot(label, p) {
  await sleep(500);
  await p.page.screenshot({ path: path.join(SHOTS, `live-${label}-${p.name.toLowerCase()}.png`) });
}
async function act(p, loc) {
  const [res] = await Promise.all([
    p.page.waitForResponse((r) => r.url().startsWith(ORIGIN + '/api/') && r.request().method() === 'POST' && !/"type":"tick"/.test(r.request().postData() || ''), { timeout: T }),
    press(p, loc),
  ]);
  assert(res.status() === 200, `${p.name}: ${res.url()} → ${res.status()} ${await res.text().catch(() => '')}`);
}

async function whoseTurn(ps) {
  const v = await viewOf(ps[0]);
  if (!v.hand || v.hand.phase !== 'betting' || !v.hand.toAct) return null;
  return ps.find((p) => p.pid === v.hand.toAct) || null;
}

/** Plays the current hand to the end: check when free, else call. */
/** The armed player's "Call any" fired on its own: their call/check is in this street's hand log. */
async function assertPreFired(a) {
  const w = await viewOf(players[0]);
  const log0 = (w.hand && w.hand.no === a.hand ? w.hand.log : (w.lastHand && w.lastHand.log)) || [];
  const hit = log0.find((e) => e.pid === a.p.pid && e.street === a.street && /call|check/i.test(e.text));
  assert(hit, a.p.name + ' pre-action should have called/checked on ' + a.street + ': ' + JSON.stringify(log0.slice(-6)));
  log(a.p.name, 'pre-action fired by itself →', hit.text, hit.amount != null ? hit.amount : '');
}

/** POSTs triggered by a key press (not a click) → asserts 200. */
async function actKey(p, key) {
  const [res] = await Promise.all([
    p.page.waitForResponse((r) => r.url().startsWith(ORIGIN + '/api/act') && r.request().method() === 'POST' && !/"type":"tick"/.test(r.request().postData() || ''), { timeout: T }),
    p.page.keyboard.press(key),
  ]);
  assert(res.status() === 200, `${p.name}: key ${key} → ${res.status()} ${await res.text().catch(() => '')}`);
  return JSON.parse(res.request().postData() || '{}');
}

/** Plays the current hand to the end: check when free, else call. Desktop players use the keyboard
 *  (K / C), the phone player taps. Before the first decision, one waiting desktop player arms the
 *  "Call any" pre-action with A and we check it fires on their turn without another key press. */
async function checkDown(ps, label, { preAction = false } = {}) {
  let armed = null;
  for (let i = 0; i < 40; i++) {
    const v = await viewOf(ps[0]);
    if (!v.hand || v.hand.phase === 'complete') return v;
    const p = await whoseTurn(ps);
    if (!p) {
      await sleep(400);
      continue;
    }
    if (preAction && !armed) {
      const waiter = ps.find((q) => !q.mobile && q !== p && v.hand.players.some((x) => x.pid === q.pid && !x.folded && !x.allIn));
      if (waiter) {
        const before = JSON.stringify(v.hand.players.find((x) => x.pid === waiter.pid).lastAction || null);
        await waiter.page.keyboard.press('a');
        await bar(waiter).getByRole('button', { name: /^Call any/ }).and(waiter.page.locator('[aria-pressed="true"]')).waitFor({ timeout: T });
        armed = { p: waiter, before, street: v.hand.street, hand: v.hand.no };
        log(waiter.name, 'armed Call any with A');
      }
    }
    if (armed && armed.p && p === armed.p) {
      // The pre-action must fire by itself once the turn reaches the armed player: their lastAction
      // changes to a call/check this street without any key press from the test.
      const a = armed;
      await until(a.p.name + ' pre-action fired', async () => {
        const w = await viewOf(ps[0]);
        if (!w.hand || w.hand.no !== a.hand) return true;
        const me = w.hand.players.find((x) => x.pid === a.p.pid);
        return w.hand.street !== a.street || JSON.stringify(me.lastAction || null) !== a.before;
      }, T);
      await assertPreFired(a);
      armed = 'done';
      continue;
    }
    if (armed && armed.p) {
      // the armed player may already have been passed by (it fired between our polls): detect it
      const me = v.hand.players.find((x) => x.pid === armed.p.pid);
      if (v.hand.no !== armed.hand || v.hand.street !== armed.street || JSON.stringify(me.lastAction || null) !== armed.before) {
        await assertPreFired(armed);
        armed = 'done';
      }
    }
    await bar(p).getByRole('button', { name: 'Fold', exact: true }).waitFor({ timeout: T });
    const canCheck = (await bar(p).getByRole('button', { name: 'Check', exact: true }).count()) > 0;
    if (p.mobile) {
      if (canCheck) await act(p, bar(p).getByRole('button', { name: 'Check', exact: true }));
      else await act(p, bar(p).getByRole('button', { name: /^Call/ }).first());
    } else {
      const sent = await actKey(p, canCheck ? 'k' : 'c');
      assert(sent.move === (canCheck ? 'check' : 'call'), `${p.name}: key sent ${JSON.stringify(sent)}`);
    }
  }
  throw new Fail('hand did not finish: ' + label);
}

async function waitNextHand(ps, after) {
  await until('hand #' + (after + 1), async () => {
    const v = await viewOf(ps[0]);
    return v.hand && v.hand.no > after && v.hand.phase === 'betting';
  }, 30000);
}

async function main() {
  browser = await launch();
  const H = await newPlayer('Maya', false);
  const B = await newPlayer('Ben', false);
  const C = await newPlayer('Cleo', true);

  // ── lobby → create
  await H.page.goto(ORIGIN + '/', { waitUntil: 'load' });
  await H.page.getByRole('button', { name: 'Create table' }).waitFor({ timeout: T });
  await shot('01-lobby', H);
  await H.page.getByPlaceholder('e.g. Maya').fill('Maya');
  await H.page.getByPlaceholder('Friday Night Game').fill('Live check');
  await H.page.getByLabel('Seats', { exact: true }).selectOption('6');
  await H.page.getByLabel('Action timer', { exact: true }).selectOption('120');
  await H.page.getByRole('button', { name: 'Create table' }).click();
  await H.page.waitForURL(/\?room=[A-Z]{3}-\d{4}$/, { timeout: T });
  CODE = new URL(H.page.url()).searchParams.get('room');
  log('room', CODE);
  await mark(H);

  // ── host sits
  await H.page.getByRole('button', { name: 'Sit in seat 1' }).click();
  await dialog(H).locator('#buyin-amt').fill('200');
  await act(H, dialog(H).getByRole('button', { name: /^Sit down/ }));
  await dialog(H).waitFor({ state: 'detached' });

  // ── Ben + Cleo join from the invite link and request seats
  for (const [p, seat] of [[B, 3], [C, 5]]) {
    await p.page.goto(ORIGIN + '/?room=' + CODE, { waitUntil: 'load' });
    const dlg = dialog(p);
    await dlg.getByPlaceholder('What should the table call you?').fill(p.name);
    await act(p, dlg.getByRole('button', { name: 'Join game' }));
    await dlg.waitFor({ state: 'detached' });
    await mark(p);
    await press(p, p.page.getByRole('button', { name: 'Sit in seat ' + seat }));
    const d2 = dialog(p);
    await d2.locator('#buyin-amt').fill('200');
    await act(p, d2.getByRole('button', { name: /^Request/ }));
    await d2.waitFor({ state: 'detached' });
  }
  for (const p of [H, B, C]) p.pid = JSON.parse(await p.page.evaluate((c) => localStorage.getItem('felt:' + c), CODE)).pid;
  log('joined; waiting for the host badge (realtime)');
  await H.page.getByRole('button', { name: 'Host tools, 2 pending' }).waitFor({ timeout: T });
  await shot('02-spectator', C);

  // ── host approves both
  await H.page.getByRole('button', { name: 'Host tools, 2 pending' }).click();
  const host = dialog(H);
  for (const n of ['Ben', 'Cleo']) await act(H, host.locator('.req').filter({ hasText: n }).getByRole('button', { name: 'Approve' }));
  await H.page.keyboard.press('Escape');
  await until('Ben sees himself seated (realtime)', async () => ((await B.page.locator('.pod-hero').innerText().catch(() => '')) || '').includes('200'));

  // ── hand 1: check / call down
  const ps = [H, B, C];
  await waitNextHand(ps, 0);
  log('hand 1 dealt');
  await shot('03-preflop', H);
  await shot('03-preflop', C);
  let v = await checkDown(ps, 'hand 1', { preAction: true });
  assert(v.hand.results, 'hand 1 has results');
  log('hand 1 done:', v.hand.results.endedBy, JSON.stringify(v.hand.results.awards));
  await shot('04-hand1-complete', B);

  // ── hand 2: first actor shoves, everyone calls, both vote Twice
  await waitNextHand(ps, 1);
  log('hand 2 dealt');
  let p = await whoseTurn(ps);
  await until('someone to act', async () => (p = await whoseTurn(ps)));
  await press(p, bar(p).locator('.presets button.preset').filter({ hasText: /^All-in/ }));
  const go = p.mobile ? bar(p).locator('.abar-grid .btn-primary') : bar(p).locator('.raise-go');
  await act(p, go);
  log(p.name, 'is all-in');
  for (let i = 0; i < 6; i++) {
    v = await viewOf(ps[0]);
    if (v.hand.phase !== 'betting') break;
    const q = await whoseTurn(ps);
    if (!q) {
      await sleep(300);
      continue;
    }
    // wait for the turn buttons: while waiting, the bar's pre-actions ("Call any", "Call 60") also start with "Call"
    await bar(q).getByRole('button', { name: 'Fold', exact: true }).waitFor({ timeout: T });
    await act(q, bar(q).getByRole('button', { name: /^Call/ }));
  }
  await until('vote or runout', async () => ['ritVote', 'runout', 'complete'].includes((await viewOf(ps[0])).hand.phase));
  v = await viewOf(ps[0]);
  if (v.hand.phase === 'ritVote') {
    for (const pid of v.hand.ritVote.voters) {
      const q = ps.find((x) => x.pid === pid);
      await act(q, bar(q).getByRole('button', { name: 'Twice', exact: true }));
    }
    await shot('05-voted', H);
  }
  await until('hand 2 complete', async () => (await viewOf(ps[0])).hand.phase === 'complete', 30000);
  v = await viewOf(ps[0]);
  log('hand 2 done: runs =', v.hand.runs, 'awards', JSON.stringify(v.hand.results.awards));
  assert(v.hand.players.filter((x) => !x.folded).every((x) => x.cards.every(Boolean)), 'all-in hands are face up for everyone');
  // Screenshots right away: the next hand deals nextHandDelay seconds after this one completes.
  if (v.hand.runs === 2) {
    for (const q of ps) await until(q.name + ' sees two run boards', async () => (await q.page.locator('.tbl-runs .run').count()) === 2);
    const labels = await H.page.locator('.tbl-runs .run-label').allInnerTexts();
    assert(labels.length === 2, 'each run is labelled: ' + labels.join(' | '));
  }
  await Promise.all([shot('06-allin-complete', H), shot('06-allin-complete', C)]);

  // ── ledger is balanced
  await H.page.getByRole('button', { name: 'Ledger' }).first().click();
  await dialog(H).getByText('Balanced').first().waitFor({ timeout: T });
  await shot('07-ledger', H);
  await H.page.keyboard.press('Escape');

  for (const q of ps) await assertNoReload(q);
  if (problems.length) throw new Fail('Problems:\n  - ' + [...new Set(problems)].join('\n  - '));
  log('live smoke passed');
}

main()
  .then(async () => {
    await browser.close();
    process.exit(0);
  })
  .catch(async (e) => {
    console.error('FAILED:', e.message);
    if (problems.length) console.error([...new Set(problems)].join('\n'));
    try {
      for (const p of players) await p.page.screenshot({ path: path.join(SHOTS, `live-fail-${p.name.toLowerCase()}.png`) });
    } catch {}
    if (browser) await browser.close();
    process.exit(1);
  });
