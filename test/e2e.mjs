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
// After the game ends, a second table plays two hands with the keyboard shortcuts (real key presses on
// the desktops, pre-action taps on the phone) and writes dev/shots/hotkeys-*.png.
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
  p.sent = []; // every non-tick POST /api/act body this page sent (the keyboard steps count them)
  page.on('request', (req) => {
    if (req.method() !== 'POST' || req.url() !== BASE + '/api/act') return;
    if (/"type":"tick"/.test(req.postData() || '')) p.ticks++;
    else {
      try {
        p.sent.push(JSON.parse(req.postData() || '{}'));
      } catch {
        /* not JSON */
      }
    }
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

// ─── review regressions on engine-generated states (dev preview harness) ────────
// Real viewFor() fixtures (dev/make-fixtures.mjs) rendered by the real UI; the harness's act()
// only reports "Preview — would send …" in a toast, so we can check what a button would do.

async function preview(fixture, { mobile = false, width, height, pref, page: pagePath = 'preview.html', rename, query = '' } = {}) {
  const ctx = await browser.newContext({
    viewport: mobile ? { width: width || 390, height: height || 844 } : { width: width || 1440, height: height || 1000 },
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
  });
  if (pref) await ctx.addInitScript((v) => localStorage.setItem('felt:showdownPref', v), pref);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !isFontNoise(m.text(), (m.location() || {}).url)) errs.push(m.text());
  });
  if (rename) {
    await page.route('**/' + fixture + '.json', async (route) => {
      const r = await route.fetch();
      let t = await r.text();
      for (const [from, to] of Object.entries(rename)) t = t.split('"' + from + '"').join('"' + to + '"');
      await route.fulfill({ response: r, body: t });
    });
  }
  await page.goto(`${BASE}/__dev/${pagePath}?fixture=${fixture}&embed=1${query}`);
  await page.locator(pagePath === 'preview.html' ? 'section.abar' : '.tbl').first().waitFor({ timeout: T });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await sleep(300);
  const done = async (label) => {
    if (label) await page.screenshot({ path: path.join(SHOTS, `e2e-00-${label}-${mobile ? 'mobile' + (width && width !== 390 ? width : '') : 'desktop'}.png`) });
    await ctx.close();
    assert(!errs.length, `${fixture}: page errors: ${errs.join(' | ')}`);
  };
  return { page, done, bar: page.locator('section.abar') };
}

async function wouldSend(page, type) {
  await until(`preview toast "would send ${type}"`, async () => (await page.locator('.toast').allInnerTexts()).some((t) => t.includes('would send ' + type)), 5000);
}

/** Every visible element matching `sel` lies inside [0, viewport width]. */
async function insideViewport(page, sel, what) {
  const out = await page.$$eval(sel, (els) =>
    els.filter((e) => e.offsetParent !== null).map((e) => {
      const r = e.getBoundingClientRect();
      return { t: e.innerText.slice(0, 30), l: r.left, r: r.right };
    }),
  );
  const w = await page.evaluate(() => window.innerWidth);
  for (const x of out) assert(x.l >= -0.5 && x.r <= w + 0.5, `${what}: "${x.t}" spans ${Math.round(x.l)}–${Math.round(x.r)} in a ${w}px viewport`);
  return out.length;
}

step('review: an away player still gets show-your-cards and reveal-the-runout after the hand', async () => {
  for (const mobile of [false, true]) {
    const { page, bar: b, done } = await preview('away-hand-complete', { mobile });
    await waitText({ name: 'preview' }, b, 'You’re away');
    await waitText({ name: 'preview' }, b, 'Show your hand?');
    await b.getByRole('button', { name: /^Reveal the runout/ }).waitFor();
    await b.getByRole('button', { name: 'I’m back' }).waitFor();
    await done(mobile ? 'away-complete' : null);
    const again = await preview('away-hand-complete', { mobile });
    await (mobile ? again.bar.getByRole('button', { name: 'Both' }).tap() : again.bar.getByRole('button', { name: 'Show both' }).click());
    await wouldSend(again.page, 'show');
    await again.done(mobile ? null : 'away-complete');
  }
});

step('review: a touch tablet in the desktop layout gets no keyboard hint; numpad navigation keys show nothing', async () => {
  // iPad landscape: wide enough for the desktop bar, but a coarse pointer — no "or press 1 2"
  const t = await preview('showdown-complete', { mobile: true, width: 1180, height: 820 });
  assert(await t.page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'coarse pointer');
  assert((await t.page.locator('.room-d').count()) === 1, 'desktop layout');
  await waitText({ name: 'preview' }, t.bar, 'Show your hand?');
  const sub = await t.bar.locator('.abar-sub').innerText();
  assert(!/press/.test(sub) && /Tap a card to pick one\.$/.test(sub.trim()), 'no keyboard hint on touch: ' + JSON.stringify(sub));
  await t.done();
  // a mouse desktop keeps the hint
  const d = await preview('showdown-complete');
  await waitText({ name: 'preview' }, d.bar, 'Show your hand?');
  const dsub = await d.bar.locator('.abar-sub').innerText();
  assert(/or press 1 2\.$/.test(dsub.replace(/\s+/g, ' ').trim()), 'desktop hint: ' + JSON.stringify(dsub));
  // NumLock off: Numpad1 / Numpad2 send End / ArrowDown — never a show
  for (const [key, code] of [['End', 'Numpad1'], ['ArrowDown', 'Numpad2']]) {
    await d.page.evaluate(([key, code]) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key, code, bubbles: true })), [key, code]);
  }
  await sleep(400);
  assert(!(await d.page.locator('.toast').allInnerTexts()).some((x) => x.includes('would send show')), 'a navigation key showed a card');
  await d.page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Numpad2', bubbles: true })));
  await wouldSend(d.page, 'show {"cards":[1]}');
  await d.done();
});

step('review: a joined player without a seat can reveal the runout', async () => {
  for (const mobile of [false, true]) {
    const { page, bar: b, done } = await preview('spectator-fold-ending', { mobile });
    const reveal = b.getByRole('button', { name: /^Reveal the runout/ });
    await reveal.waitFor();
    await (mobile ? reveal.tap() : reveal.click());
    await wouldSend(page, 'revealRunout');
    await done('spectator-reveal');
  }
});

step('review: a player the host removed is told so and never offered "Stay seated"', async () => {
  for (const mobile of [false, true]) {
    const { page, bar: b, done } = await preview('removed-by-host', { mobile, query: mobile ? '&dialog=menu' : '' });
    await waitText({ name: 'preview' }, b, 'The host removed you');
    if (mobile) await page.getByRole('dialog', { name: 'Menu' }).getByText('The host removed you').waitFor();
    else await page.locator('.side-session').getByText('The host removed you').waitFor();
    assert((await page.getByRole('button', { name: 'Stay seated' }).count()) === 0, '"Stay seated" must not be offered after a host removal');
    await done('removed-by-host');
    const d = await preview('removed-by-host', { mobile, query: '&dialog=leave' });
    const dlg = d.page.getByRole('dialog', { name: 'Leave your seat?' });
    await dlg.getByText('The host removed you').waitFor();
    assert((await dlg.getByRole('button', { name: 'Stay seated' }).count()) === 0, 'leave dialog: no "Stay seated"');
    await d.done(mobile ? null : 'removed-leave-dialog');
  }
});

step('review: the "At showdown, when I lose" preference (session box) drives the show prompt', async () => {
  // showdown-complete: hero lost the showdown with cards nobody has seen
  const ask = await preview('showdown-complete');
  await waitText({ name: 'preview' }, ask.bar, 'Show your hand?');
  const sel = ask.page.locator('.side-session').getByLabel('At showdown, when I lose');
  assert((await sel.inputValue()) === 'ask', 'default: ask me each time');
  await sel.selectOption('muck');
  await until('the prompt goes away once "Always muck" is picked', async () => !(await ask.bar.innerText()).includes('Show your hand?'), 5000);
  assert((await ask.page.evaluate(() => localStorage.getItem('felt:showdownPref'))) === 'muck', 'the preference is remembered');
  await ask.done('showdown-pref');
  const muck = await preview('showdown-complete', { mobile: true, pref: 'muck' });
  await waitText({ name: 'preview' }, muck.bar, 'wins');
  await sleep(500);
  assert(!(await muck.bar.innerText()).includes('Show your hand?'), '"Always muck": no prompt');
  await muck.done('showdown-muck');
  const show = await preview('showdown-complete', { pref: 'show' });
  await wouldSend(show.page, 'show');
  await show.done();
});

step('review: nothing spills past a 360px screen (reserved seat, seat tags, a 20-letter name)', async () => {
  const a = await preview('t-spectator-requested', { mobile: true, width: 360, height: 740, page: 'table-preview.html' });
  assert((await insideViewport(a.page, '.se-main', 'reserved seat label')) >= 1, 'the "Requested" seat is drawn');
  await noHorizontalScroll({ name: 'preview', page: a.page }, '360px');
  await a.done('360-requested');
  const long = 'W'.repeat(20);
  const b = await preview('host-with-requests', { mobile: true, width: 360, height: 740, rename: { Ari: long } });
  assert((await insideViewport(b.page, '.seat .tag', 'seat tags')) >= 3, 'seat tags are drawn');
  const who = await b.page.locator('.abar-who').boundingBox();
  const secs = await b.page.locator('.abar-secs').boundingBox();
  assert(who && secs && who.x + who.width <= secs.x + 0.5, `the acting name (${Math.round(who.x + who.width)}) runs into the clock (${Math.round(secs.x)})`);
  await insideViewport(b.page, '.abar-who', 'acting name');
  await b.done('360-long-name');
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

step('host removes Ben (watching, no seat) from the game: his spot and his name are free again', async () => {
  const dlg = await openHostTools();
  await dlg.getByRole('button', { name: 'Remove Ben from the game' }).click();
  const confirm = H.page.getByRole('dialog', { name: 'Remove Ben from the game?' });
  await confirm.getByText('frees their spot').waitFor();
  await act(H, confirm.getByRole('button', { name: 'Remove', exact: true }));
  await confirm.waitFor({ state: 'detached' });
  await until('Ben is gone from the host’s players table', async () => (await dlg.locator('.tbl-name', { hasText: /^Ben$/ }).count()) === 0);
  await closeTop(H);
  // realtime: Ben's token no longer works, so his page drops back to a visitor's view
  await until('Ben is a visitor now', async () => (await sessionOf(B)) === null);
  await waitText(B, bar(B), 'You’re watching');
  const v = await viewOf(H);
  assert(!v.players.some((x) => x.name === 'Ben'), 'Ben is not in the player list');
  assert(v.ledger.players.some((r) => r.name === 'Ben'), 'Ben’s ledger rows stay');
  // the name is free again: a new "Ben" can join
  const r = await fetch(BASE + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE, name: 'ben' }) });
  assert(r.status === 200, 'joining as "ben" after the removal → ' + r.status);
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

// ─── keyboard shortcuts and pre-actions: a second table ─────────────────────
// Real key presses on the desktops (Maya, Ben) and taps on Cleo's phone. Seats 1 / 3 / 5 again, so
// hand 1: button Maya, SB Ben, BB Cleo (Maya first preflop, Ben first after); hand 2: button Ben.

/** Moves this page sent from now on (non-tick /api/act bodies with a move). */
const movesSince = (p, n) => p.sent.slice(n).filter((b) => b.type === 'act').map((b) => b.move);
const isPressed = async (p, name) => (await btn(bar(p), name).getAttribute('aria-pressed').catch(() => null)) === 'true';
const pressedPre = async (p) => (await bar(p).locator('.pre-acts button[aria-pressed=true]').allInnerTexts()).map((t) => t.replace(/\s+[A-Z]$/, '').trim());

async function hotShot(name, p) {
  await sleep(450);
  await p.page.screenshot({ path: path.join(SHOTS, `hotkeys-${name}.png`) });
}

/** Press a key and wait for the /api/act POST of `type` it causes. → the request body */
async function keyAct(p, key, type = 'act') {
  const isIt = (r) => r.url() === BASE + '/api/act' && r.request().method() === 'POST' && (() => {
    try {
      return JSON.parse(r.request().postData() || '{}').type === type;
    } catch {
      return false;
    }
  })();
  const [res] = await Promise.all([p.page.waitForResponse(isIt, { timeout: T }), p.page.keyboard.press(key)]);
  assert(res.status() === 200, `${p.name}: key ${key} → ${res.status()} ${await res.text().catch(() => '')}`);
  return JSON.parse(res.request().postData());
}

/** Press a key and make sure nothing is sent. */
async function keyIdle(p, key, why) {
  const n = p.sent.length;
  await p.page.keyboard.press(key);
  await sleep(500);
  assert(p.sent.length === n, `${p.name}: ${why} — key ${key} sent ${JSON.stringify(p.sent.slice(n))}`);
}

async function toastSeen(p, text) {
  await until(`${p.name}: toast "${text}"`, async () => (await p.page.locator('.toast').allInnerTexts()).some((t) => t.includes(text)), 5000);
}

async function sitDown(p, seat, amount) {
  await press(p, p.page.getByRole('button', { name: 'Sit in seat ' + seat }));
  const d = dialog(p);
  await d.getByRole('heading', { name: 'Take seat ' + seat }).waitFor();
  await d.locator('#buyin-amt').fill(String(amount));
  await act(p, d.getByRole('button', { name: /^Sit down/ }));
  await d.waitFor({ state: 'detached' });
}

async function typedRaise(p, amount) {
  await p.page.keyboard.press('r');
  await until(`${p.name}: R focuses the amount`, async () => p.page.evaluate(() => document.activeElement && document.activeElement.classList.contains('raise-num')), 3000);
  const body = await (async () => {
    await p.page.keyboard.type(String(amount));
    const [res] = await Promise.all([
      p.page.waitForResponse((r) => r.url() === BASE + '/api/act' && /"move":"raise"/.test(r.request().postData() || '')),
      p.page.keyboard.press('Enter'),
    ]);
    assert(res.status() === 200, `${p.name}: typed raise → ${res.status()}`);
    return JSON.parse(res.request().postData());
  })();
  assert(body.to === amount, `${p.name}: raised to ${body.to}, typed ${amount}`);
}

step('keys: a second table — Maya creates it (no buy-in approval), pauses, all three sit down', async () => {
  const pg = H.page;
  await pg.goto(BASE + '/', { waitUntil: 'load' });
  await pg.getByPlaceholder('e.g. Maya').fill('Maya');
  await pg.getByPlaceholder('Friday Night Game').fill('E2E Keys');
  await pg.getByLabel('Seats', { exact: true }).selectOption('6');
  await pg.getByLabel('Action timer', { exact: true }).selectOption('120');
  await pg.getByRole('switch', { name: 'Host approves buy-ins' }).uncheck();
  await pg.getByRole('button', { name: 'Create table' }).click();
  await pg.waitForURL(/\?room=[A-Z]{3}-\d{4}$/, { timeout: T });
  CODE = new URL(pg.url()).searchParams.get('room');
  log('keys room', CODE);
  // paused, so nobody is dealt in until all three are seated
  const dlg = await openHostTools();
  await act(H, dlg.getByRole('button', { name: 'Pause', exact: true }));
  await closeTop(H);
  await sitDown(H, 1, 200);
  for (const p of [B, C]) {
    await p.page.goto(BASE + '/?room=' + CODE, { waitUntil: 'load' });
    const d = dialog(p);
    await d.getByRole('heading', { name: 'Join E2E Keys' }).waitFor();
    await d.getByPlaceholder('What should the table call you?').fill(p.name);
    await act(p, d.getByRole('button', { name: 'Join game' }), { route: '/api/join' });
    await d.waitFor({ state: 'detached' });
    await sitDown(p, p === B ? 3 : 5, 200);
  }
  await act(H, H.page.locator('.room-banner').getByRole('button', { name: 'Resume' }));
  await advance(3200);
  for (const p of [H, B, C]) await waitHand(p, 1);
  const v = await viewOf(H);
  assert(v.hand.players.length === 3 && v.hand.toAct === v.me.id, 'hand 1, 3-handed, Maya (button) first');
});

step('keys: preflop — Ben picks Call current (G), Cleo taps Call any; Maya: K is refused, R → 6 → Enter raises', async () => {
  await waitTurn(H);
  // Ben (small blind) is waiting: the pre-action row offers to call the 1 he owes
  const bPre = bar(B).locator('.pre-acts');
  await bPre.waitFor();
  await waitText(B, bPre, 'Call 1');
  assert((await pressedPre(B)).length === 0, 'nothing picked yet');
  await B.page.keyboard.press('g');
  await until('Ben: Call current picked', async () => isPressed(B, 'Call 1'));
  assert((await bPre.locator('.pre-btn.on').count()) === 1, 'the picked button is highlighted');
  await hotShot('waiting-desktop', B);
  // a keycap on each pre-action button (desktop), none on the phone
  assert((await bPre.locator('kbd.kc').count()) === 3, 'desktop pre-actions carry keycaps');
  // Cleo (big blind, phone) taps Call any
  const cPre = bar(C).locator('.pre-acts');
  await cPre.waitFor();
  assert((await cPre.locator('kbd').count()) === 0, 'no keycaps on the phone');
  await press(C, btn(bar(C), 'Call any'));
  await until('Cleo: Call any picked', async () => isPressed(C, 'Call any'));
  await hotShot('waiting-mobile', C);
  await noHorizontalScroll(C, 'pre-actions');
  // Maya: keycaps on the turn buttons; K can't check facing the big blind — a toast, nothing sent
  assert((await bar(H).locator('.act-fold kbd.kc').innerText()) === 'F', 'Fold shows F');
  assert((await bar(H).locator('.act-call kbd.kc').innerText()) === 'C', 'Call shows C');
  await keyIdle(H, 'k', 'K facing a bet');
  await toastSeen(H, 'Can’t check — 2 to call');
  await hotShot('turn-desktop', H);
  const nC = C.sent.length;
  await typedRaise(H, 6);
  // Ben's Call current is dropped: the bet changed (a toast tells him); C calls on his own turn
  await toastSeen(B, 'The bet changed — choose again');
  await waitTurn(B);
  const nB = B.sent.length;
  const call = await keyAct(B, 'c');
  assert(call.move === 'call', 'C calls: ' + JSON.stringify(call));
  assert(movesSince(B, nB).length === 1, 'Ben sent exactly one move');
  // Cleo's Call any fires on its own — once
  await until('Cleo’s Call any fires', async () => movesSince(C, nC).length >= 1);
  await until('the flop', async () => (await boardCount(H)) === 3);
  assert(JSON.stringify(movesSince(C, nC)) === '["call"]', 'Cleo called exactly once: ' + JSON.stringify(movesSince(C, nC)));
  const v = await viewOf(H);
  assert(v.hand.players.every((x) => x.committed === 6), 'everyone has 6 in: ' + v.hand.players.map((x) => x.committed).join('/'));
});

step('keys: flop — Maya cycles A → I → I (off) → G; Cleo taps Check/Fold; Ben checks with K; both picks check', async () => {
  await waitTurn(B);
  await bar(H).locator('.pre-acts').waitFor();
  await H.page.keyboard.press('a');
  await until('Maya: Call any', async () => JSON.stringify(await pressedPre(H)) === '["Call any"]');
  await H.page.keyboard.press('i');
  await until('Maya: switched to Check/Fold', async () => JSON.stringify(await pressedPre(H)) === '["Check/Fold"]');
  await H.page.keyboard.press('i');
  await until('Maya: pressing I again turns it off', async () => (await pressedPre(H)).length === 0);
  await H.page.keyboard.press('g');
  await until('Maya: Call current reads "Check" with nothing bet', async () => isPressed(H, 'Check'));
  await press(C, btn(bar(C), 'Check/Fold'));
  await until('Cleo: Check/Fold', async () => isPressed(C, 'Check/Fold'));
  const nH = H.sent.length;
  const nC = C.sent.length;
  const k = await keyAct(B, 'k');
  assert(k.move === 'check', 'K checks: ' + JSON.stringify(k));
  await until('the turn', async () => (await boardCount(H)) === 4);
  assert(JSON.stringify(movesSince(C, nC)) === '["check"]', 'Cleo’s Check/Fold checked: ' + JSON.stringify(movesSince(C, nC)));
  assert(JSON.stringify(movesSince(H, nH)) === '["check"]', 'Maya’s Call current checked: ' + JSON.stringify(movesSince(H, nH)));
});

step('keys: turn — Maya picks Call any; Ben bets 10 with R; Cleo taps Fold; Maya’s pick calls the bet', async () => {
  await waitTurn(B);
  await bar(H).locator('.pre-acts').waitFor();
  await H.page.keyboard.press('a');
  await until('Maya: Call any', async () => isPressed(H, 'Call any'));
  const nH = H.sent.length;
  await typedRaise(B, 10);
  await waitText(H, seatOf(H, 'Ben'), 'Bet 10');
  await waitTurn(C);
  assert(H.sent.length === nH, 'Maya’s pick waits for her turn');
  await act(C, btn(bar(C), 'Fold'));
  await until('the river', async () => (await boardCount(H)) === 5);
  assert(JSON.stringify(movesSince(H, nH)) === '["call"]', 'Maya’s Call any called once: ' + JSON.stringify(movesSince(H, nH)));
});

step('keys: river — Maya picks Check/Fold (I); Ben bets 20; it folds her; Ben wins', async () => {
  await waitTurn(B);
  await bar(H).locator('.pre-acts').waitFor();
  await H.page.keyboard.press('i');
  await until('Maya: Check/Fold', async () => isPressed(H, 'Check/Fold'));
  const nH = H.sent.length;
  // a tablet rotated to portrait: the phone layout mounts its own action bar — the pick survives it
  const size = H.page.viewportSize();
  await H.page.setViewportSize({ width: 820, height: 1180 });
  await H.page.locator('.room-m').waitFor();
  await until('Maya: Check/Fold still picked after the rotation', async () => isPressed(H, 'Check/Fold'));
  await typedRaise(B, 20);
  for (const p of [H, B]) await waitComplete(p);
  assert(JSON.stringify(movesSince(H, nH)) === '["fold"]', 'Check/Fold folded to the bet: ' + JSON.stringify(movesSince(H, nH)));
  await H.page.setViewportSize(size);
  await H.page.locator('.room-d').waitFor();
  const v = await viewOf(H);
  assert(v.hand.results.endedBy === 'fold' && v.hand.players.find((x) => x.name === 'Ben').isWinner, 'Ben wins without a showdown');
});

step('keys: after the hand — Ben shows his second card with 2; Maya shows one with 1, then the rest with S', async () => {
  await waitText(B, bar(B), 'You won');
  assert((await bar(B).locator('kbd.kc').filter({ hasText: 'S' }).count()) === 1, 'Show both carries an S keycap');
  const two = await keyAct(B, '2', 'show');
  assert(JSON.stringify(two.cards) === '[1]', '2 shows the second card: ' + JSON.stringify(two));
  await until('Maya sees one of Ben’s cards', async () => (await seatOf(H, 'Ben').locator('.seat-cards .card:not(.card-back)').count()) === 1);
  await keyIdle(B, '2', 'the second card is already shown');
  await waitText(H, bar(H), 'Show your hand?');
  await hotShot('show-desktop', H);
  // a slow network: 1, then S while the first show is still in flight — the second key isn't lost
  const nH = H.sent.length;
  const shows = () => H.sent.slice(nH).filter((b) => b.type === 'show').map((b) => JSON.stringify(b.cards));
  const slow = async (route) => {
    await sleep(400);
    await route.continue().catch(() => {});
  };
  await H.page.route(BASE + '/api/act', slow);
  await H.page.keyboard.press('1');
  await sleep(120);
  await H.page.keyboard.press('s');
  await until('Ben sees both of Maya’s cards', async () => (await seatOf(B, 'Maya').locator('.seat-cards .card:not(.card-back)').count()) === 2);
  await sleep(600);
  await H.page.unroute(BASE + '/api/act', slow);
  assert(JSON.stringify(shows()) === JSON.stringify(['[0]', '[1]']), '1 showed the first card, S the rest: ' + JSON.stringify(shows()));
  await keyIdle(H, 's', 'nothing left to show');
  const ben = (await viewOf(C)).hand.players.find((x) => x.name === 'Ben');
  assert(ben.shown.join() === 'false,true', 'Ben showed only his second card: ' + ben.shown.join());
});

step('keys: hand 2 — F does nothing before my turn; Ben folds with F; Maya (big blind) checks with C; "?" opens the cheat sheet', async () => {
  const v0 = await viewOf(H);
  await advance(v0.deadline - v0.serverNow + 400);
  for (const p of [H, B, C]) await waitHand(p, 2);
  await waitTurn(B);
  await keyIdle(H, 'f', 'F is never a pre-fold');
  await keyIdle(H, 'c', 'C waits for my turn');
  assert((await pressedPre(H)).length === 0, 'F / C pick nothing');
  const f = await keyAct(B, 'f');
  assert(f.move === 'fold', 'F folds');
  await waitText(H, seatOf(H, 'Ben'), 'Folded');
  await call(C);
  await waitTurn(H);
  assert((await bar(H).locator('.act-call kbd.kc').innerText()) === 'K', 'the Check button shows K');
  // she touches the raise slider, then changes her mind: a slider isn't typing, the keys still work
  await bar(H).locator('input.raise-range').click();
  assert((await H.page.evaluate(() => document.activeElement && document.activeElement.type)) === 'range', 'the slider has focus');
  const c = await keyAct(H, 'c');
  assert(c.move === 'check', 'C checks the big blind’s option: ' + JSON.stringify(c));
  await until('flop', async () => (await boardCount(H)) === 3);
  // the cheat sheet: "?" (Shift+/) and the header's keyboard button
  await H.page.keyboard.press('Shift+Slash');
  const sheet = H.page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await sheet.getByText('Before your turn').waitFor();
  for (const t of ['Fold', 'Call any', 'Call current', 'Check/Fold', 'Show all your cards']) await sheet.getByText(t, { exact: true }).first().waitFor();
  await hotShot('cheatsheet-desktop', H);
  await closeTop(H);
  await H.page.getByRole('button', { name: 'Keyboard shortcuts' }).click();
  await sheet.waitFor();
  await closeTop(H);
  // Cleo (small blind) acts first on the flop: shortcuts sleep while a sheet is open
  await waitTurn(C);
  await C.page.keyboard.press('Shift+Slash');
  const cs = C.page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await cs.getByText('After the hand').waitFor();
  await hotShot('cheatsheet-mobile', C);
  await keyIdle(C, 'f', 'a sheet is open');
  await closeTop(C);
  await check(C);
  // …and while typing: Maya writes "fold" in the chat on her turn — nothing is sent but the message
  await waitTurn(H);
  await H.page.getByRole('tab', { name: /^Chat/ }).click();
  const input = H.page.locator('.side').getByRole('textbox', { name: 'Message' });
  await input.click();
  const n = H.sent.length;
  await H.page.keyboard.type('fold');
  await sleep(300);
  assert(H.sent.length === n, 'typing in the chat sends no move: ' + JSON.stringify(H.sent.slice(n)));
  await input.fill('');
  await H.page.getByRole('tab', { name: 'Hand' }).click();
  await H.page.evaluate(() => document.activeElement && document.activeElement.blur());
  const k = await keyAct(H, 'k');
  assert(k.move === 'check', 'K checks');
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
