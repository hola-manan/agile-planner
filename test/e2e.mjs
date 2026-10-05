#!/usr/bin/env node
// test/e2e.mjs — end-to-end: three real browsers play a game against the local dev server.
//
//   node test/e2e.mjs                 boots dev/server.mjs on a free port (FELT_DEV_TIME=1), runs the
//                                     whole scenario, writes dev/shots/e2e-*.png, exits 1 on failure
//   E2E_STOP=<text> node test/e2e.mjs stop after the first step whose name contains <text>
//   E2E_HEADED=1                      watch it run (needs a display)
//
// Cast: Maya hosts at 1440×1000, Ben joins from the invite link at 1440×1000, Cleo joins on a phone
// (390×844, touch). Every game action is a real click/tap in the UI; the HTTP API is only read
// (GET /api/state) to make assertions and to pick a branch where the cards decide (e.g. who busted).
//
// Time: each browser context runs a Playwright fake clock that keeps ticking in real time. To skip
// ahead we move the server clock (POST /__dev/time) and every browser clock by the same amount, so
// the clients' own deadline timers fire and POST {type:'tick'} — exactly what happens in production
// when a deadline passes. Nothing here reloads a page: every cross-player assertion is a realtime
// update arriving over the events channel.
//
// Fails on: any page error / unhandled rejection, any console error (Google Fonts excepted — the
// sandbox may have no internet), any failed same-origin request, any API response ≥ 400 that the
// step didn't expect, and any server-side exception in the dev server log.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'dev', 'shots');
const STOP = process.env.E2E_STOP || '';
const HEADED = !!process.env.E2E_HEADED;
const T = 12000; // default wait for UI conditions (ms, real time)

const require = createRequire(import.meta.url);
function loadPlaywright() {
  const tries = ['playwright', '/opt/node22/lib/node_modules/playwright'];
  for (const t of tries) {
    try {
      return require(t);
    } catch {
      /* next */
    }
  }
  try {
    const globalRoot = require('node:child_process').execSync('npm root -g', { encoding: 'utf8' }).trim();
    return require(path.join(globalRoot, 'playwright'));
  } catch {
    console.error('e2e: Playwright is not installed (npm i -g playwright).');
    process.exit(2);
  }
}
const { chromium } = loadPlaywright();

// ─── tiny utils ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const log = (...a) => console.log(stamp(), ...a);

class Fail extends Error {}
function assert(cond, msg) {
  if (!cond) throw new Fail(msg);
}

/** Poll `fn` (async ok) until it returns truthy. */
async function until(desc, fn, timeout = T, every = 120) {
  const end = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    if (Date.now() > end) throw new Fail('Timed out waiting for ' + desc + (last ? ' — last error: ' + last.message : ''));
    await sleep(every);
  }
}

// ─── dev server ──────────────────────────────────────────────────────────────

let server = null;
let serverLog = '';
let BASE = '';

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: '0', HOST: '127.0.0.1', FELT_DEV_TIME: '1', FELT_QUIET: '1' };
    delete env.FELT_DEV_DB;
    const child = spawn(process.execPath, ['--import', './dev/register.mjs', 'dev/server.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('dev server did not start:\n' + out)), 20000);
    child.stdout.on('data', (d) => {
      out += d;
      serverLog += d;
      const m = out.match(/listening on (http:\/\/[^\s]+)/);
      if (m && !BASE) {
        clearTimeout(timer);
        BASE = m[1].replace('localhost', '127.0.0.1');
        resolve(child);
      }
    });
    child.stderr.on('data', (d) => {
      serverLog += d;
    });
    child.on('exit', (code) => {
      if (!BASE) reject(new Error('dev server exited (' + code + '):\n' + out + serverLog));
    });
    server = child;
  });
}

// ─── clock: server + every browser move together ────────────────────────────

let clockOffset = 0; // how far the server clock has been pushed ahead of real time
const players = [];

async function advance(ms) {
  const r = await fetch(BASE + '/__dev/time', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advance: ms }) });
  assert(r.ok, 'POST /__dev/time failed (' + r.status + ')');
  clockOffset += ms;
  for (const p of players) await p.ctx.clock.fastForward(ms);
  if (process.env.E2E_CLOCK_DEBUG) {
    for (const p of players) {
      const err = await p.page.evaluate(() => import('/js/room.js').then((m) => m.serverNow())).catch(() => null);
      log(`  clock ${p.name}: serverNow error ${err == null ? '?' : err - (Date.now() + clockOffset)} ms`);
    }
  }
}

// ─── problems seen in the browsers ───────────────────────────────────────────

const problems = [];
const allowedApiErrors = []; // [{ who, type, status }] expected by the current step

function isFontNoise(text, url) {
  return /fonts\.(googleapis|gstatic)\.com/.test(String(url || '') + ' ' + String(text || ''));
}

function watch(p) {
  const { page, name } = p;
  p.ticks = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url() === BASE + '/api/act' && /"type":"tick"/.test(req.postData() || '')) p.ticks++;
  });
  page.on('pageerror', (e) => problems.push(`${name}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location() || {};
    if (isFontNoise(m.text(), loc.url)) return;
    problems.push(`${name}: console.error: ${m.text()}${loc.url ? ' @ ' + loc.url : ''}`);
  });
  page.on('requestfailed', (req) => {
    const url = req.url();
    if (!url.startsWith(BASE)) return;
    const why = (req.failure() && req.failure().errorText) || '';
    // An EventSource torn down by navigation / context close is not an app failure.
    if (/\/__dev\/sse/.test(url) && /ERR_ABORTED/.test(why)) return;
    problems.push(`${name}: request failed: ${req.method()} ${url} ${why}`);
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (!url.startsWith(BASE + '/api/') || res.status() < 400) return;
    let type = '';
    try {
      type = JSON.parse(res.request().postData() || '{}').type || '';
    } catch {
      /* GET */
    }
    const i = allowedApiErrors.findIndex((a) => a.who === name && a.type === type && a.status === res.status());
    if (i >= 0) {
      allowedApiErrors.splice(i, 1);
      return;
    }
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* gone */
    }
    problems.push(`${name}: API ${res.request().method()} ${url.replace(BASE, '')} ${type} → ${res.status()} ${body.slice(0, 200)}`);
  });
}

function checkProblems(where) {
  const serverErr = serverLog.match(/\[dev\][^\n]*(threw|failed)[^\n]*/);
  if (serverErr) problems.push('server: ' + serverErr[0]);
  if (problems.length) throw new Fail(`Problems during "${where}":\n  - ` + [...new Set(problems)].join('\n  - '));
}

// ─── browsers / players ──────────────────────────────────────────────────────

let browser;

async function launch() {
  const args = ['--ignore-certificate-errors'];
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (proxy) {
    // Google Fonts via the sandbox's proxy; the app itself is local and bypasses it.
    const u = new URL(proxy);
    args.push('--proxy-server=' + u.protocol + '//' + u.host, '--proxy-bypass-list=127.0.0.1;localhost');
  }
  const opts = { headless: !HEADED, args };
  try {
    return await chromium.launch(opts);
  } catch {
    return chromium.launch({ ...opts, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  }
}

async function newPlayer(name, kind) {
  const mobile = kind === 'mobile';
  const ctx = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    ignoreHTTPSErrors: true,
    locale: 'en-US',
    timezoneId: 'Europe/London',
  });
  await ctx.clock.install({ time: Date.now() + clockOffset });
  await ctx.addInitScript(() => {
    window.addEventListener('unhandledrejection', (e) => console.error('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)));
  });
  const page = await ctx.newPage();
  const p = { name, key: name.toLowerCase(), kind, mobile, ctx, page };
  watch(p);
  players.push(p);
  return p;
}

const press = (p, loc) => (p.mobile ? loc.tap() : loc.click());

/** Click/tap and wait for the POST it triggers (/api/act by default; ticks excluded). → response view */
async function act(p, loc, { status = 200, route = '/api/act' } = {}) {
  const isAct = (r) => r.url() === BASE + route && r.request().method() === 'POST' && !/"type":"tick"/.test(r.request().postData() || '');
  const [res] = await Promise.all([p.page.waitForResponse(isAct, { timeout: T }), press(p, loc)]);
  assert(res.status() === status, `${p.name}: expected ${status} from ${route}, got ${res.status()}: ${await res.text().catch(() => '')}`);
  const body = await res.json().catch(() => ({}));
  return body.view || null;
}

async function shot(label, ...ps) {
  await sleep(450); // let flips / sheet transitions settle
  for (const p of ps) {
    await p.page.screenshot({ path: path.join(SHOTS, `e2e-${label}-${p.key}-${p.mobile ? 'mobile' : 'desktop'}.png`) });
  }
}

/** Marks the document; a reload (or a full navigation) would lose the mark. */
async function markLoaded(p) {
  await p.page.evaluate(() => {
    window.__e2eLoaded = true;
  });
}

/** Fails if the page scrolls sideways. */
async function noHorizontalScroll(p, where) {
  const w = await p.page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert(w[0] <= w[1] + 1, `${p.name} (${where}): horizontal scroll — content ${w[0]}px wide in a ${w[1]}px viewport`);
}

// ─── reading the game (assertions only) ─────────────────────────────────────

let CODE = '';

async function sessionOf(p) {
  return p.page.evaluate((code) => {
    try {
      return JSON.parse(localStorage.getItem('felt:' + code) || 'null');
    } catch {
      return null;
    }
  }, CODE);
}

/** GET /api/state as this player. NOTE: the server also processes any deadline that is due. */
async function viewOf(p) {
  const s = await sessionOf(p);
  const r = await fetch(BASE + '/api/state?code=' + CODE, { headers: s ? { 'x-felt-token': s.token } : {} });
  assert(r.ok, 'GET /api/state → ' + r.status);
  return (await r.json()).view;
}

const bar = (p) => p.page.locator('section.abar');
const btn = (scope, name, exact = true) => scope.getByRole('button', { name, exact });
const dialog = (p) => p.page.getByRole('dialog');

async function waitText(p, loc, text, timeout = T) {
  await until(`${p.name}: "${text}" in ${loc}`, async () => ((await loc.innerText().catch(() => '')) || '').includes(text), timeout);
}

async function waitTurn(p, timeout = T) {
  await bar(p).locator('.abar-tone-turn, :scope.abar-tone-turn').first().waitFor({ state: 'attached', timeout }).catch(() => {});
  await btn(bar(p), 'Fold').waitFor({ timeout });
}

/** The bar shows the end of a hand: a result line, or the "show your hand?" prompt. */
async function waitComplete(p, timeout = T) {
  await until(`${p.name}: hand complete in the action bar`, async () => /\bwins?\b|split|Show your hand|You won|Hand over/.test(await bar(p).innerText()), timeout);
}

async function handNoOf(p) {
  const t = await p.page.locator(p.mobile ? '.room-msub' : '.room-sub').innerText();
  const m = t.match(/#(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function waitHand(p, n, timeout = T) {
  await until(`${p.name}: hand #${n} in the header`, async () => (await handNoOf(p)) === n, timeout);
}

/** The seat group for a named player (not the hero). */
const seatOf = (p, name) => p.page.locator('.seat[role=group]').filter({ has: p.page.locator('.pod-name', { hasText: new RegExp('^' + name + '$') }) });

async function boardCount(p) {
  return p.page.locator('.tbl-center .board .card:not(.card-slot):not(.card-ghost)').count();
}

// ─── betting helpers (real clicks) ───────────────────────────────────────────

async function fold(p) {
  await waitTurn(p);
  return act(p, btn(bar(p), 'Fold'));
}
async function check(p) {
  await waitTurn(p);
  return act(p, btn(bar(p), 'Check'));
}
async function call(p) {
  await waitTurn(p);
  return act(p, bar(p).getByRole('button', { name: /^Call/ }));
}
/** Pick a preset (desktop shows "½ pot 7", phone "½ pot") then press the raise/bet button. */
async function presetRaise(p, label) {
  await waitTurn(p);
  const pre = bar(p).locator('.presets button.preset').filter({ hasText: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s|$)') });
  await press(p, pre.first());
  await until(`${p.name}: preset ${label} on`, async () => (await pre.first().getAttribute('aria-pressed')) === 'true', 3000);
  const go = p.mobile ? bar(p).locator('.abar-grid .btn-primary') : bar(p).locator('.raise-go');
  const amount = Number((await bar(p).locator('.raise-num').inputValue().catch(() => '')) || 0);
  const v = await act(p, go);
  return { view: v, amount };
}

// ─── the scenario ────────────────────────────────────────────────────────────

const steps = [];
const step = (name, fn) => steps.push({ name, fn });
let H; // Maya — host, desktop
let B; // Ben — desktop, joins by invite link
let C; // Cleo — phone
const ctxNotes = {};

step('lobby renders on desktop and phone', async () => {
  H = await newPlayer('Maya', 'desktop');
  C = await newPlayer('Cleo', 'mobile');
  for (const p of [H, C]) {
    await p.page.goto(BASE + '/', { waitUntil: 'load' });
    await markLoaded(p);
    await p.page.getByRole('button', { name: 'Create table' }).waitFor();
    await p.page.evaluate(() => document.fonts && document.fonts.ready);
    await noHorizontalScroll(p, 'lobby');
  }
  await shot('01-lobby', H, C);
});

step('host creates a game in the lobby', async () => {
  const pg = H.page;
  // Submitting without a name shows the validation message and stays put.
  await pg.getByRole('button', { name: 'Create table' }).click();
  await pg.getByText('Enter your name', { exact: false }).waitFor();
  await pg.getByPlaceholder('e.g. Maya').fill('Maya');
  await pg.getByPlaceholder('Friday Night Game').fill('E2E Friday');
  await pg.getByLabel('Seats', { exact: true }).selectOption('6');
  await pg.getByLabel('Action timer', { exact: true }).selectOption('120');
  assert((await pg.getByLabel('Run it more than once').inputValue()) === '2', 'run-it default should be "up to twice"');
  assert((await pg.getByRole('switch', { name: 'Host approves buy-ins' }).isChecked()) === true, 'approve buy-ins should default on');
  await pg.getByRole('button', { name: 'Create table' }).click();
  await pg.waitForURL(/\?room=[A-Z]{3}-\d{4}$/, { timeout: T });
  CODE = new URL(pg.url()).searchParams.get('room');
  await waitText(H, pg.locator('.room-head'), 'E2E Friday');
  await waitText(H, pg.locator('.room-sub'), 'Waiting to deal');
  // the four-colour deck toggle flips the whole page (and remembers it)
  const deck = pg.locator('.deck-toggle');
  await deck.click();
  assert(await pg.evaluate(() => document.documentElement.classList.contains('two-color') && localStorage.getItem('felt:fourColor') === 'false'), 'two-colour deck on');
  await deck.click();
  assert(await pg.evaluate(() => !document.documentElement.classList.contains('two-color')), 'four-colour deck back on');
  log('room', CODE);
});

step('host edits the rules and pauses before seating anyone', async () => {
  const pg = H.page;
  await pg.getByRole('button', { name: /^Host tools/ }).click();
  const dlg = dialog(H);
  await dlg.getByRole('button', { name: 'Edit rules (applies next hand)' }).click();
  await dlg.getByLabel('Seconds between hands').fill('30');
  await dlg.getByLabel('Auto-away after timeouts').selectOption('1');
  await act(H, dlg.getByRole('button', { name: 'Save rules' }));
  await waitText(H, dlg.locator('.host-rules'), '30s');
  await act(H, dlg.getByRole('button', { name: 'Pause', exact: true }));
  await dlg.getByRole('button', { name: 'Resume' }).waitFor();
  await pg.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  await waitText(H, pg.locator('.room-banner'), 'paused');
  const v = await viewOf(H);
  assert(v.settings.nextHandDelay === 30 && v.settings.autoAwayTimeouts === 1 && v.settings.actionTime === 120, 'settings not saved: ' + JSON.stringify(v.settings));
  assert(v.paused === true, 'game should be paused');
});

step('host takes seat 1', async () => {
  const pg = H.page;
  await pg.getByRole('button', { name: 'Sit in seat 1' }).click();
  const dlg = dialog(H);
  await dlg.getByRole('heading', { name: 'Take seat 1' }).waitFor();
  await dlg.locator('#buyin-amt').fill('300');
  await act(H, dlg.getByRole('button', { name: /^Sit down/ }));
  await dlg.waitFor({ state: 'detached' });
  await waitText(H, pg.locator('.pod-hero'), '300');
});

step('Ben opens the invite link, joins and asks for seat 3', async () => {
  B = await newPlayer('Ben', 'desktop');
  const pg = B.page;
  await pg.goto(BASE + '/?room=' + CODE, { waitUntil: 'load' });
  await markLoaded(B);
  const dlg = dialog(B);
  await dlg.getByRole('heading', { name: 'Join E2E Friday' }).waitFor();
  await shot('02-join', B);
  await dlg.getByPlaceholder('What should the table call you?').fill('Ben');
  await act(B, dlg.getByRole('button', { name: 'Join game' }), { route: '/api/join' });
  await dlg.waitFor({ state: 'detached' });
  await waitText(B, bar(B), 'Pick an empty seat');
  await pg.getByRole('button', { name: 'Sit in seat 3' }).click();
  const d2 = dialog(B);
  await d2.getByText('Maya approves buy-ins').waitFor();
  await act(B, d2.getByRole('button', { name: /^Request/ }));
  await d2.waitFor({ state: 'detached' });
  await waitText(B, bar(B), 'Seat request sent');
  // realtime: the host's header badge counts the request
  await H.page.getByRole('button', { name: 'Host tools, 1 pending' }).waitFor({ timeout: T });
});

step('Cleo joins on her phone and asks for seat 5', async () => {
  const pg = C.page;
  await pg.goto(BASE + '/?room=' + CODE, { waitUntil: 'load' });
  await markLoaded(C);
  const dlg = dialog(C);
  await dlg.getByRole('heading', { name: 'Join E2E Friday' }).waitFor();
  await shot('02-join', C);
  await dlg.getByPlaceholder('What should the table call you?').fill('Cleo');
  await act(C, dlg.getByRole('button', { name: 'Join game' }), { route: '/api/join' });
  await dlg.waitFor({ state: 'detached' });
  await noHorizontalScroll(C, 'spectator');
  await press(C, pg.getByRole('button', { name: 'Sit in seat 5' }));
  const d2 = dialog(C);
  await d2.getByRole('heading', { name: 'Take seat 5' }).waitFor();
  await press(C, d2.locator('.buyin-presets button', { hasText: 'Min' }));
  await act(C, d2.getByRole('button', { name: /^Request 100/ }));
  await d2.waitFor({ state: 'detached' });
  await H.page.getByRole('button', { name: 'Host tools, 2 pending' }).waitFor({ timeout: T });
  await shot('03-seat-requested', C);
});

step('chat between the three players (realtime)', async () => {
  // Ben, desktop side panel
  await B.page.getByRole('tab', { name: /^Chat/ }).click();
  const input = B.page.locator('.side').getByRole('textbox', { name: 'Message' });
  await input.fill('gl all');
  await act(B, B.page.locator('.side').getByRole('button', { name: 'Send' }));
  await waitText(B, B.page.locator('.chat-list'), 'gl all');
  // Cleo, phone: menu → Chat sheet
  await press(C, C.page.getByRole('button', { name: /^Menu/ }));
  await press(C, dialog(C).getByRole('button', { name: /^Chat/ }));
  const sheet = dialog(C);
  await waitText(C, sheet.locator('.chat-list'), 'gl all');
  await sheet.getByRole('textbox', { name: 'Message' }).fill('ty, you too');
  await act(C, sheet.getByRole('button', { name: 'Send' }));
  await waitText(C, sheet.locator('.chat-list'), 'ty, you too');
  await shot('04-chat', C);
  // realtime to Ben (chat tab open) and Maya (unread dot on the Chat tab, then the message)
  await waitText(B, B.page.locator('.chat-list'), 'ty, you too');
  await H.page.locator('.side-tab .side-dot').waitFor({ timeout: T });
  await H.page.getByRole('tab', { name: /^Chat/ }).click();
  await waitText(H, H.page.locator('.chat-list'), 'ty, you too');
  await shot('04-chat', B);
  await press(C, sheet.getByRole('button', { name: 'Back to table' }));
  await sheet.waitFor({ state: 'detached' });
  await H.page.getByRole('tab', { name: 'Hand' }).click();
  await B.page.getByRole('tab', { name: 'Hand' }).click();
});

step('host approves both requests from Host tools (one with an edited amount) and resumes', async () => {
  const pg = H.page;
  await pg.getByRole('button', { name: 'Host tools, 2 pending' }).click();
  const dlg = dialog(H);
  const ben = dlg.locator('.req').filter({ hasText: 'Ben wants to sit in seat 3' });
  const cleo = dlg.locator('.req').filter({ hasText: 'Cleo wants to sit in seat 5' });
  await ben.waitFor();
  await cleo.waitFor();
  await shot('05-host-requests', H);
  await ben.getByRole('button', { name: 'Edit amount' }).click();
  await ben.getByLabel('Amount for Ben').fill('250');
  await act(H, ben.getByRole('button', { name: 'Approve' }));
  await act(H, cleo.getByRole('button', { name: 'Approve' }));
  await dlg.locator('.req').first().waitFor({ state: 'detached' });
  // realtime: both see themselves seated with the approved amounts
  await waitText(B, B.page.locator('.pod-hero'), '250');
  await until('Cleo seated', async () => (await viewOf(C)).me.seat === 4);
  await act(H, dlg.getByRole('button', { name: 'Resume', exact: true }));
  await pg.keyboard.press('Escape');
  await dlg.waitFor({ state: 'detached' });
  const v = await viewOf(H);
  assert(v.paused === false && v.deadlineKind === 'nextHand', 'resume should schedule the first hand: ' + v.deadlineKind);
  const stacks = Object.fromEntries(v.players.map((p) => [p.name, p.stack]));
  assert(stacks.Maya === 300 && stacks.Ben === 250 && stacks.Cleo === 100, 'stacks after approval: ' + JSON.stringify(stacks));
});

// Seats 0 (Maya), 2 (Ben), 4 (Cleo). Hand 1: button Maya, SB Ben, BB Cleo; Maya acts first.
step('hand 1 deals when the clients tick (3-handed)', async () => {
  const ticksBefore = players.reduce((a, p) => a + p.ticks, 0);
  await advance(3200);
  for (const p of [H, B, C]) await waitHand(p, 1);
  assert(players.reduce((a, p) => a + p.ticks, 0) > ticksBefore, 'the deal came from a client tick');
  await waitTurn(H);
  // everyone sees their own two cards; others are face down
  assert((await H.page.locator('.hero-cards .card:not(.card-back)').count()) === 2, 'Maya should see 2 hole cards');
  assert((await B.page.locator('.hero-cards .card:not(.card-back)').count()) === 2, 'Ben should see 2 hole cards');
  assert((await C.page.locator('.hero-m .card:not(.card-back)').count()) === 2, 'Cleo should see 2 hole cards');
  assert((await H.page.locator('.seat .card-back').count()) === 4, 'Maya should see 4 face-down cards');
  await shot('06-preflop-turn', H, C);
});

step('hand 1 preflop: Maya raises with the slider, Ben folds, Cleo calls', async () => {
  // raise with the keyboard on the slider: min 4 → 6
  const range = bar(H).locator('.raise-range');
  await range.focus();
  await H.page.keyboard.press('ArrowRight');
  await H.page.keyboard.press('ArrowRight');
  assert((await bar(H).locator('.raise-num').inputValue()) === '6', 'slider should move the amount to 6');
  await act(H, bar(H).locator('.raise-go'));
  await waitText(B, seatOf(B, 'Maya'), 'Raise to 6'); // realtime
  await waitText(C, seatOf(C, 'Maya'), 'Raise to 6');
  await waitTurn(B);
  await shot('07-facing-raise', B);
  await fold(B);
  await waitText(H, seatOf(H, 'Ben'), 'Folded');
  await waitTurn(C);
  await shot('07-facing-raise', C);
  await call(C);
});

step('hand 1 flop/turn/river: check, ½-pot bet, call, checks to a showdown', async () => {
  await until('flop on Maya', async () => (await boardCount(H)) === 3);
  await check(C);
  const { amount } = await presetRaise(H, '½ pot');
  assert(amount === 7, '½ pot on a 13 pot should be 7, was ' + amount);
  await waitText(C, seatOf(C, 'Maya'), 'Bet 7');
  await call(C);
  await until('turn', async () => (await boardCount(H)) === 4);
  await check(C);
  await check(H);
  await until('river', async () => (await boardCount(H)) === 5);
  await check(C);
  await check(H);
  for (const p of [H, B, C]) await waitComplete(p);
  const v = await viewOf(B);
  const h = v.hand;
  assert(h.phase === 'complete' && h.results.endedBy === 'showdown', 'hand 1 should end at a showdown');
  const maya = h.players.find((x) => x.name === 'Maya');
  const cleo = h.players.find((x) => x.name === 'Cleo');
  // Maya bet last → she shows; the winner shows. Ben (a spectator of this showdown) sees those cards.
  assert(maya.cards.every(Boolean), 'the last aggressor must be shown at showdown');
  for (const w of h.players.filter((x) => x.isWinner)) assert(w.cards.every(Boolean), w.name + ' won and must be shown');
  ctxNotes.hand1 = { winners: h.players.filter((x) => x.isWinner).map((x) => x.name), cleoShown: cleo.cards.every(Boolean) };
  // the shown cards are face up on Ben's table (flip) and winning cards are lifted
  await until('Ben sees Maya’s cards face up', async () => (await seatOf(B, 'Maya').locator('.seat-cards .card-flip').count()) === 2);
  assert((await B.page.locator('.tbl-center .card-lift').count()) > 0 || (await B.page.locator('.seat .card-lift').count()) > 0, 'winning cards should be lifted');
  await shot('08-showdown', H, C);
  await shot('08-showdown', B);
});

step('hand 1 after the showdown: Ben (folded preflop) shows one card; the loser keeps hidden', async () => {
  await waitText(B, bar(B), 'Show your hand?');
  const first = B.page.locator('.hero-cards .hero-card-btn').first();
  await first.click();
  const showOne = bar(B).getByRole('button', { name: /^Show (?!both)/ });
  await showOne.waitFor();
  await act(B, showOne);
  // realtime: Maya and Cleo now see exactly one of Ben's cards
  await until('Maya sees one Ben card', async () => (await seatOf(H, 'Ben').locator('.seat-cards .card:not(.card-back)').count()) === 1);
  await until('Cleo sees one Ben card', async () => (await seatOf(C, 'Ben').locator('.seat-cards .card:not(.card-back)').count()) === 1);
  await waitText(H, H.page.locator('.handlog'), 'Ben shows'); // the hand log, live
  await waitText(C, seatOf(C, 'Ben'), 'Folded · showed');
  if (!ctxNotes.hand1.cleoShown) {
    // Cleo lost without having to show: she picks "Hide" (keep hidden)
    await waitText(C, bar(C), 'Show your hand?');
    await press(C, bar(C).getByRole('button', { name: 'Hide' }));
    await bar(C).getByRole('button', { name: 'Hide' }).waitFor({ state: 'detached' });
  }
  await shot('09-folder-shows', H, B);
});

// Hand 2: button Ben, SB Cleo, BB Maya; Ben acts first.
step('hand 2: Ben raises with the Pot preset, both fold; Cleo reveals the runout (ghost cards)', async () => {
  await advance(30500); // nextHandDelay is 30s: every client's timer fires a tick
  for (const p of [H, B, C]) await waitHand(p, 2);
  const { amount } = await presetRaise(B, 'Pot');
  assert(amount === 7, 'pot-size raise facing the 2 blind with 3 in the pot should be to 7, was ' + amount);
  await waitText(C, seatOf(C, 'Ben'), 'Raise to 7');
  await fold(C);
  await fold(H);
  for (const p of [H, B, C]) await waitComplete(p);
  await waitText(H, H.page.locator('.handlog'), 'Ben wins'); // Maya folded: her bar offers to show, the log names the winner
  await waitText(H, seatOf(H, 'Ben'), '+10');
  // Ben won without a showdown: he may show, nobody else sees his cards
  await waitText(B, bar(B), 'You won');
  assert((await seatOf(H, 'Ben').locator('.seat-cards').count()) === 0, 'Ben’s cards must stay hidden');
  // Cleo (phone) reveals what would have come
  const reveal = bar(C).getByRole('button', { name: /^Reveal the runout/ });
  await reveal.waitFor();
  await act(C, reveal);
  for (const p of [H, B, C]) {
    await until(`${p.name} sees 5 ghost cards`, async () => (await p.page.locator('.tbl-center .card-ghost').count()) === 5);
    await waitText(p, p.page.locator('.tbl-center .revealed'), 'Cleo');
  }
  assert((await viewOf(H)).hand.runout.cards.length === 5, 'runout should hold the 5 cards that would have come');
  await bar(B).getByRole('button', { name: 'Keep hidden' }).click(); // local choice, no request
  await bar(B).getByRole('button', { name: 'Keep hidden' }).waitFor({ state: 'detached' });
  await shot('10-runout-revealed', H, C);
});

// Hand 3: button Cleo, SB Maya, BB Ben; Cleo acts first.
step('hand 3: Cleo shoves with the All-in preset, Maya folds, Ben calls → run-it vote', async () => {
  await advance(30500);
  for (const p of [H, B, C]) await waitHand(p, 3);
  const before = await viewOf(H);
  ctxNotes.stacksBefore3 = Object.fromEntries(before.players.map((x) => [x.name, x.stack + (before.hand.players.find((h) => h.pid === x.id) || { committed: 0 }).committed]));
  await presetRaise(C, 'All-in');
  await waitText(H, seatOf(H, 'Cleo'), 'All-in');
  await fold(H);
  await call(B);
  // all-in and called: both hands are face up for everyone, then the vote
  for (const p of [H, B, C]) await waitText(p, bar(p), p === H ? 'voting' : 'Run it how many times?');
  await until('Maya sees both all-in hands', async () => (await H.page.locator('.seat .seat-cards .card:not(.card-back)').count()) === 4);
  assert((await H.page.locator('.seat .eq').count()) === 2, 'win % under both all-in players');
  await shot('11-vote', B, C);
  await act(B, btn(bar(B), 'Twice'));
  await waitText(C, bar(C), 'Ben'); // Ben's vote chip shows up on Cleo's phone
  await act(C, btn(bar(C), 'Twice'));
});

step('hand 3: it runs twice — two boards, the pot is split between the runs', async () => {
  for (const p of [H, B, C]) await waitText(p, p.page.locator('.tbl-center .pot'), p.mobile ? '2 runs' : 'running it twice');
  await advance(1900); // run 1 flop
  await until('run 1 flop on Maya', async () => (await H.page.locator('.tbl-runs .run').first().locator('.card:not(.card-slot)').count()) >= 3);
  assert((await H.page.locator('.tbl-runs .run').count()) === 2, 'two board rows while running it twice');
  await shot('12-running-twice', H, C);
  for (let i = 0; i < 6; i++) {
    const v = await viewOf(H);
    if (v.hand.phase === 'complete') break;
    await advance(1900);
    await sleep(150);
  }
  for (const p of [H, B, C]) await waitText(p, p.page.locator('.tbl-center .pot'), p.mobile ? '2 runs' : 'ran twice');
  const v = await viewOf(H);
  const h = v.hand;
  assert(h.results && h.results.runs.length === 2, 'two runs in the results');
  for (const r of h.results.runs) assert(r.board.length === 5, 'each run has a full board');
  const pot = h.results.pots.filter((x) => !x.returned).reduce((a, x) => a + x.amount, 0);
  const perRun = h.results.runs.map((r) => r.amount);
  assert(perRun[0] + perRun[1] === pot && Math.abs(perRun[0] - perRun[1]) <= 1, `pot ${pot} must be split between the runs: ${perRun.join(' + ')}`);
  const labels = await H.page.locator('.tbl-runs .run-label').allInnerTexts();
  assert(labels.length === 2 && labels.every((t) => /Ben|Cleo/.test(t)), 'each run is labelled with its winner: ' + labels.join(' | '));
  // the chips really moved: Σ awards = the pot, and nobody's stack is off
  const awards = Object.values(h.results.awards).reduce((a, x) => a + x, 0);
  const committed = h.players.reduce((a, x) => a + x.committed, 0);
  assert(awards === committed, `awards ${awards} must equal the chips committed ${committed}`);
  const busted = v.players.filter((x) => x.seat != null && x.stack === 0).map((x) => x.name);
  ctxNotes.busted = busted[0] || null;
  log('  runs won by', h.results.runs.map((r) => r.winners.map((w) => v.players.find((x) => x.id === w).name).join('+')).join(' / '), '— busted:', ctxNotes.busted || 'nobody');
  await shot('13-ran-twice', H, B, C);
});

// ─── between hands: pause, chip adjustments, a busted player's rebuy ────────

const who = (name) => ({ Maya: H, Ben: B, Cleo: C })[name];
const headerHost = (p = H) => p.page.getByRole('button', { name: /^Host tools/ });

async function openHostTools() {
  await headerHost().click();
  const dlg = H.page.getByRole('dialog', { name: 'Host tools' });
  await dlg.getByRole('heading', { name: 'Host tools' }).waitFor();
  return dlg;
}

async function closeTop(p) {
  const n = await p.page.getByRole('dialog').count();
  await p.page.keyboard.press('Escape');
  await until(`${p.name}: a dialog closes`, async () => (await p.page.getByRole('dialog').count()) < n, 5000);
}

/** Host tools (desktop) → Adjust chips on `name`'s row → fill the form → submit. → response view */
async function adjustChips(dlg, name, { mode, amount, reason, count }) {
  const row = dlg.locator('tbody tr').filter({ has: H.page.locator('.tbl-name', { hasText: new RegExp('^' + name + '$') }) });
  await row.getByRole('button', { name: 'Adjust chips' }).click();
  const form = dlg.getByRole('form', { name: `Adjust ${name}’s chips` });
  await form.waitFor();
  await form.getByRole('button', { name: { add: 'Add', remove: 'Remove', set: 'Set to' }[mode], exact: true }).click();
  if (reason) await form.getByRole('button', { name: reason, exact: true }).click();
  await form.getByRole('checkbox', { name: /Count as a buy-in/ }).setChecked(!!count);
  await form.getByLabel('Amount', { exact: true }).fill(String(amount));
  const v = await act(H, form.locator('button[type=submit]'));
  await form.waitFor({ state: 'detached' });
  return v;
}

/** Shoot a desktop player's page at phone size too (the layout is width-driven). */
async function shotAsPhone(label, p) {
  await p.page.setViewportSize({ width: 390, height: 844 });
  await sleep(600);
  await p.page.screenshot({ path: path.join(SHOTS, `e2e-${label}-${p.key}-mobile.png`) });
  await noHorizontalScroll(p, label + ' at phone width');
  await p.page.setViewportSize({ width: 1440, height: 1000 });
  await sleep(300);
}

step('host pauses after the hand; the table stops dealing (realtime banner)', async () => {
  const dlg = await openHostTools();
  await act(H, dlg.getByRole('button', { name: 'Pause after hand' }));
  await dlg.getByRole('button', { name: 'Keep playing' }).waitFor();
  await closeTop(H);
  for (const p of [H, B, C]) await waitText(p, p.page.locator('.room-banner'), 'Pausing after this hand');
  await advance(31600); // nextHandDelay 30s + 1.5s for the second run: the clients tick, hand 3 is archived
  for (const p of [H, B, C]) await waitText(p, p.page.locator('.room-banner'), 'paused');
  await H.page.locator('.room-banner').getByRole('button', { name: 'Resume' }).waitFor();
  assert((await B.page.locator('.room-banner button').count()) === 0, 'only the host gets the Resume button');
  const v = await viewOf(H);
  assert(v.paused && !v.hand && v.lastHand && v.lastHand.no === 3, 'paused with hand 3 archived');
  for (const p of [B, C]) await waitText(p, p.page.locator('.tbl-center'), 'Paused');
  await shot('14-paused', B, C);
});

step('host adjusts chips: add, set and (when nobody busted) a move from one player to another', async () => {
  const v0 = await viewOf(H);
  const stack = (v, name) => v.players.find((x) => x.name === name).stack;
  const dlg = await openHostTools();
  if (!ctxNotes.busted) {
    // Nobody busted in the all-in: Cleo hands all her chips to Maya (a side bet) — remove + add,
    // neither counted as a buy-in, so the books still balance.
    const x = stack(v0, 'Cleo');
    await adjustChips(dlg, 'Cleo', { mode: 'remove', amount: x, reason: 'Move from player', count: false });
    await adjustChips(dlg, 'Maya', { mode: 'add', amount: x, reason: 'Move from player', count: false });
    ctxNotes.busted = 'Cleo';
    await waitText(C, bar(C), 'out of chips'); // realtime on her phone
  } else {
    await adjustChips(dlg, 'Maya', { mode: 'add', amount: 50, reason: 'Cash rebuy', count: true });
  }
  // "Set to" on whoever isn't busted (Ben unless he is), counted as a buy-in
  const setName = ctxNotes.busted === 'Ben' ? 'Cleo' : 'Ben';
  const v1 = await viewOf(H);
  const target = stack(v1, setName) + 100;
  // open the form and look at it before submitting (before → after preview)
  const row = dlg.locator('tbody tr').filter({ has: H.page.locator('.tbl-name', { hasText: new RegExp('^' + setName + '$') }) });
  await row.getByRole('button', { name: 'Adjust chips' }).click();
  const form = dlg.getByRole('form', { name: `Adjust ${setName}’s chips` });
  await form.getByRole('button', { name: 'Set to', exact: true }).click();
  await form.getByLabel('Amount', { exact: true }).fill(String(target));
  await waitText(H, form.locator('.adjust-after'), String(target));
  await shot('15-adjust-form', H);
  await act(H, form.locator('button[type=submit]'));
  await form.waitFor({ state: 'detached' });
  await shotAsPhone('15-host-tools', H); // the same dialog as a full-screen sheet at phone width
  const tp = who(setName);
  await waitText(tp, tp.page.locator('.pod-hero .pod-stack'), target.toLocaleString('en-US')); // realtime
  const v2 = await viewOf(H);
  assert(stack(v2, setName) === target, `${setName} should have been set to ${target}, has ${stack(v2, setName)}`);
  const L = v2.ledger;
  assert(L.totals.balanced, 'the ledger must still balance after the adjustments: ' + JSON.stringify(L.totals));
  assert(L.entries.filter((e) => e.type === 'adjust').length >= 2, 'adjustments are on the ledger');
  await closeTop(H);
});

step('the busted player asks to buy back in and the host approves it (realtime)', async () => {
  const p = who(ctxNotes.busted);
  await waitText(p, bar(p), 'out of chips');
  await shot('16-busted', p);
  await press(p, bar(p).getByRole('button', { name: 'Request a buy-in' }));
  const d = dialog(p);
  await d.getByRole('heading', { name: 'Buy back in' }).waitFor();
  await press(p, d.locator('.buyin-presets button', { hasText: 'Min' }));
  await act(p, d.getByRole('button', { name: /^Request 100/ }));
  await d.waitFor({ state: 'detached' });
  await waitText(p, bar(p), 'requested');
  await H.page.getByRole('button', { name: 'Host tools, 1 pending' }).waitFor(); // badge, realtime
  const dlg = await openHostTools();
  const req = dlg.locator('.req').filter({ hasText: `${p.name} wants to rebuy` });
  await waitText(H, req, 'Busted');
  await shot('17-rebuy-request', H);
  if (p === C) await shot('17-rebuy-request', C);
  await act(H, req.getByRole('button', { name: 'Approve' }));
  await req.waitFor({ state: 'detached' });
  await closeTop(H);
  // realtime: the player is back with 100 chips
  await until(`${p.name} has chips again`, async () => !/out of chips|requested/.test(await bar(p).innerText()));
  const v = await viewOf(p);
  assert(v.me.stack === 100 && !v.me.busted && !v.me.request, 'rebuy of 100 applied: ' + JSON.stringify({ stack: v.me.stack, busted: v.me.busted }));
  assert(v.ledger.entries.some((e) => e.type === 'buyin' && e.pid === v.me.id && e.amount === 100), 'the rebuy is on the ledger');
});

// ─── hand 4: a timeout → auto-away, leaving after the hand, a typed raise ───

// Hand 4: button Maya (seat 1), SB Ben, BB Cleo — Maya acts first.
step('host resumes; hand 4 deals 3-handed', async () => {
  await act(H, H.page.locator('.room-banner').getByRole('button', { name: 'Resume' }));
  for (const p of [H, B, C]) await p.page.locator('.room-banner').waitFor({ state: 'detached' });
  await advance(3200);
  for (const p of [H, B, C]) await waitHand(p, 4);
  const v = await viewOf(H);
  assert(v.hand.players.length === 3, 'all three are dealt in');
  assert(v.hand.toAct === v.me.id, 'Maya (button, 3-handed) acts first preflop');
});

step('hand 4: Ben chooses to leave after this hand (realtime "Leaving" tag)', async () => {
  await B.page.locator('.side').getByRole('button', { name: 'Leave seat' }).click();
  const d = B.page.getByRole('dialog', { name: 'Leave your seat?' });
  await d.getByText('After this hand').waitFor();
  await d.getByText('Right now').waitFor();
  await shot('18-leave-dialog', B);
  await shotAsPhone('18-leave-dialog', B); // the same dialog as a bottom sheet
  await act(B, d.getByRole('button', { name: 'Leave seat' }));
  await d.waitFor({ state: 'detached' });
  await waitText(B, bar(B), 'when this hand ends');
  await waitText(H, seatOf(H, 'Ben'), 'Leaving');
  await waitText(C, seatOf(C, 'Ben'), 'Leaving');
  assert((await viewOf(B)).me.leaveAfterHand === true, 'leaveAfterHand set');
});

step('hand 4: Maya’s clock runs out → she is folded and set away (the clients’ tick does it)', async () => {
  const v = await viewOf(H);
  assert(v.deadlineKind === 'action' && v.hand.toAct === v.me.id, 'Maya is on the clock');
  const ticksBefore = players.reduce((a, p) => a + p.ticks, 0);
  await advance(v.deadline - v.serverNow + 400);
  await waitText(H, bar(H), 'You’re away');
  // nobody but the browsers' own deadline timers asked the server to move on
  assert(players.reduce((a, p) => a + p.ticks, 0) > ticksBefore, 'a client tick processed the timeout');
  await waitText(H, bar(H), 'timed out');
  for (const p of [B, C]) await waitText(p, seatOf(p, 'Maya'), 'Away'); // realtime
  const v2 = await viewOf(H);
  assert(v2.me.away && v2.me.awayBy === 'timeout', 'auto-away after 1 timeout: ' + JSON.stringify({ away: v2.me.away, by: v2.me.awayBy }));
  assert(v2.hand.players.find((x) => x.pid === v2.me.id).folded, 'the timed-out player (facing the big blind) was folded');
  await shot('19-timed-out-away', H);
  await shotAsPhone('19-timed-out-away', H);
});

step('hand 4: Ben calls, Cleo raises by typing an amount on her phone, Ben folds', async () => {
  await call(B);
  await waitTurn(C);
  const num = bar(C).locator('.raise-m .raise-num');
  await num.fill('8');
  const go = bar(C).locator('.abar-grid .btn-primary');
  await until('Cleo: the raise button reads "Raise 8"', async () => (await go.innerText()).replace(/\s+/g, '') === 'Raise8');
  await shot('20-typed-raise', C);
  await act(C, go);
  await waitText(B, seatOf(B, 'Cleo'), 'Raise to 8');
  await fold(B);
  for (const p of [B, C]) await waitComplete(p);
  await until('Cleo: "You won" in the bar', async () => /You won|You win/.test(await bar(C).innerText()));
  // Maya is away: her bar keeps offering "I'm back" while the hand finishes; the log names the winner
  await waitText(H, bar(H), 'You’re away');
  await waitText(H, H.page.locator('.handlog'), 'Cleo wins');
});

step('hand 4 ends: Ben is cashed out and the ledger shows it', async () => {
  const before = await viewOf(B);
  const cash = before.players.find((x) => x.name === 'Ben').stack;
  await advance(30500);
  await waitText(B, bar(B), 'Pick an empty seat');
  const v = await viewOf(H);
  assert(v.players.find((x) => x.name === 'Ben').seat === null, 'Ben stood up');
  const e = v.ledger.entries.find((x) => x.type === 'cashout' && x.name === 'Ben');
  assert(e && e.amount === cash, `Ben's cash-out of ${cash} is on the ledger: ` + JSON.stringify(e));
  assert(v.ledger.totals.balanced, 'still balanced after the cash-out');
  assert(!v.hand, 'no hand: Maya is away and Cleo is alone');
  // Ben looks it up in the ledger
  await B.page.getByRole('button', { name: 'Ledger' }).click();
  const led = B.page.getByRole('dialog', { name: 'Ledger' });
  await waitText(B, led.locator('.lfeed'), 'You cashed out ' + cash);
  await led.getByText('Balanced').waitFor();
  await shot('21-ledger-after-cashout', B);
  await closeTop(B);
});

// ─── voluntary away, I'm back ×2, hand 5 heads-up ───────────────────────────

step('Cleo steps away from the phone menu; both come back', async () => {
  await press(C, C.page.getByRole('button', { name: /^Menu/ }));
  const menu = C.page.getByRole('dialog', { name: 'Menu' });
  await menu.getByText('Your session').waitFor();
  await shot('22-menu', C);
  await act(C, menu.getByRole('button', { name: 'Away', exact: true }));
  await menu.getByRole('button', { name: /I’m back/ }).waitFor();
  await closeTop(C);
  await waitText(C, bar(C), 'You’re away');
  await waitText(H, seatOf(H, 'Cleo'), 'Away'); // realtime
  await shot('23-away', C);
  // Maya first (play the next hand, don't wait for the big blind)
  await bar(H).getByRole('checkbox', { name: /Wait for the big blind/ }).uncheck();
  await act(H, bar(H).getByRole('button', { name: 'I’m back' }));
  await waitText(H, bar(H), 'Waiting for players');
  const mid = await viewOf(H);
  assert(!mid.me.away && !mid.me.waitForBB && !mid.deadline, 'Maya is back; still nobody to play with');
  await bar(C).getByRole('checkbox', { name: /Wait for the big blind/ }).uncheck();
  await act(C, bar(C).getByRole('button', { name: 'I’m back' }));
  await until('next hand scheduled', async () => (await viewOf(H)).deadlineKind === 'nextHand');
  await advance(3200);
  for (const p of [H, B, C]) await waitHand(p, 5);
});

// Hand 5, heads-up: Cleo is the button and small blind and acts first preflop; Maya first after.
step('hand 5 (heads-up): Cleo limps, Maya checks, then bets a typed amount with Enter; Cleo folds', async () => {
  const v = await viewOf(C);
  assert(v.hand.players.length === 2 && v.hand.button === v.me.seat && v.hand.toAct === v.me.id, 'heads-up: the button acts first preflop');
  await call(C);
  await check(H);
  await until('flop', async () => (await boardCount(H)) === 3);
  await waitTurn(H);
  const num = bar(H).locator('.raise-num');
  await num.click();
  await num.fill('4');
  const [res] = await Promise.all([
    H.page.waitForResponse((r) => r.url() === BASE + '/api/act' && /"move":"raise"/.test(r.request().postData() || '')),
    num.press('Enter'),
  ]);
  assert(res.status() === 200, 'typed bet accepted');
  await waitText(C, seatOf(C, 'Maya'), 'Bet 4');
  await shot('24-facing-bet', C);
  await fold(C);
  for (const p of [H, C]) await waitComplete(p);
  await until('Maya: "You won" in the bar', async () => /You won|You win/.test(await bar(H).innerText()));
});

// ─── remove, ledger + settle up, end the game ───────────────────────────────

step('host removes Cleo from the table (confirm dialog); she is cashed out and watches', async () => {
  const dlg = await openHostTools();
  await dlg.getByRole('button', { name: 'Remove Cleo from seat' }).click();
  const confirm = H.page.getByRole('dialog', { name: 'Remove Cleo from the table?' });
  await confirm.getByText('cashed out for').waitFor();
  await shot('25-remove-confirm', H);
  await act(H, confirm.getByRole('button', { name: 'Remove', exact: true }));
  await confirm.waitFor({ state: 'detached' });
  await closeTop(H);
  await waitText(C, bar(C), 'Pick an empty seat'); // realtime on her phone
  const v = await viewOf(C);
  assert(v.me.seat === null && v.ledger.entries.some((e) => e.type === 'cashout' && e.pid === v.me.id), 'Cleo cashed out');
});

step('ledger: balanced, settle-up ticked by the host shows up for everyone', async () => {
  // Ben and Cleo open the ledger first, so the tick has to arrive in realtime
  await B.page.getByRole('button', { name: 'Ledger' }).click();
  const bl = B.page.getByRole('dialog', { name: 'Ledger' });
  await press(C, C.page.getByRole('button', { name: 'Ledger', exact: true }));
  const cl = C.page.getByRole('dialog', { name: 'Ledger' });
  await cl.getByText('Settle up').waitFor();
  await H.page.getByRole('button', { name: 'Ledger' }).click();
  const hl = H.page.getByRole('dialog', { name: 'Ledger' });
  await hl.getByText('Balanced').waitFor();
  const v = await viewOf(H);
  assert(v.ledger.totals.balanced && v.ledger.totals.diff === 0, 'balanced books');
  const nets = v.ledger.players.reduce((a, r) => a + r.net, 0);
  assert(nets === 0, 'nets sum to zero, got ' + nets);
  assert(v.ledger.settlement.length >= 1, 'somebody owes somebody');
  const pay = hl.locator('label.pay').first();
  assert((await B.page.locator('label.pay input:disabled').count()) >= 1, 'only the host can tick payments');
  await act(H, pay.locator('input[type=checkbox]'));
  await until('the payment is ticked for Maya', async () => (await hl.locator('label.pay.is-paid').count()) === 1);
  await until('Ben sees it ticked (realtime)', async () => (await bl.locator('label.pay.is-paid').count()) === 1);
  await until('Cleo sees it ticked (realtime)', async () => (await cl.locator('label.pay.is-paid').count()) === 1);
  assert((await viewOf(B)).ledger.settlement.filter((s) => s.paid).length === 1, 'markPaid stored');
  await shot('26-ledger-settle', H, C);
  await closeTop(H);
  await closeTop(B);
  await closeTop(C);
});

step('host ends the game: everyone sees the final ledger', async () => {
  const dlg = await openHostTools();
  await dlg.getByRole('button', { name: 'End game' }).click();
  const confirm = H.page.getByRole('dialog', { name: 'End the game?' });
  await act(H, confirm.getByRole('button', { name: 'End game', exact: true }));
  await confirm.waitFor({ state: 'detached' });
  await closeTop(H);
  for (const p of [H, B, C]) await waitText(p, p.page.locator('.room-ended'), 'This game has ended');
  const v = await viewOf(H);
  assert(v.ended && v.players.every((x) => x.seat === null), 'ended, everyone stood up');
  assert(v.ledger.totals.balanced && v.ledger.totals.chipsOnTable === 0, 'final ledger balanced, nothing left on the table');
  for (const p of [H, B, C]) await noHorizontalScroll(p, 'ended');
  await shot('27-ended', H, C);
  // nothing in this run reloaded a page: every update above arrived over realtime
  for (const p of [H, B, C]) assert(await p.page.evaluate(() => window.__e2eLoaded === true), p.name + ' reloaded the page');
});

// ─── runner ──────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const f of fs.readdirSync(SHOTS)) if (/^e2e-.*\.png$/.test(f)) fs.unlinkSync(path.join(SHOTS, f));
  await startServer();
  log('dev server', BASE);
  browser = await launch();
  let failed = null;
  let done = 0;
  for (const s of steps) {
    const ts = Date.now();
    try {
      await s.fn();
      checkProblems(s.name);
      done++;
      log(`ok  ${s.name}  (${((Date.now() - ts) / 1000).toFixed(1)}s)`);
    } catch (err) {
      failed = { step: s.name, err };
      log(`FAIL ${s.name}`);
      break;
    }
    if (STOP && s.name.includes(STOP)) {
      log(`stopping after "${s.name}" (E2E_STOP)`);
      break;
    }
  }
  if (failed) {
    for (const p of players) {
      await p.page.screenshot({ path: path.join(SHOTS, `e2e-FAIL-${p.key}.png`) }).catch(() => {});
    }
    console.error('\n' + (failed.err && failed.err.stack ? failed.err.stack : failed.err));
    if (problems.length) console.error('\nBrowser problems:\n  - ' + [...new Set(problems)].join('\n  - '));
    console.error('\nServer log (tail):\n' + serverLog.split('\n').slice(-30).join('\n'));
  }
  await browser.close().catch(() => {});
  server.kill('SIGTERM');
  log(failed ? `e2e FAILED at "${failed.step}" (${done}/${steps.length} steps passed)` : `e2e passed (${done}/${steps.length} steps)`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    if (browser) await browser.close();
  } catch {
    /* ignore */
  }
  if (server) server.kill('SIGTERM');
  process.exit(1);
});
