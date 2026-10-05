// dev/panels-shoot.mjs — screenshots of the side panel / host tools / ledger via dev/panels-preview.html.
//   http-server /home/user/agile-planner -p 8792 -c-1   then   node dev/panels-shoot.mjs [job names…]
// Writes dev/shots/panels-<job>-<desktop|mobile>.png (1440×1000 and 390×844).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node22/lib/node_modules/playwright');
}
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'shots');
const BASE = process.env.BASE || 'http://127.0.0.1:8792/dev/panels-preview.html';

const clickText = (t) => async (page) => {
  await page.getByText(t, { exact: true }).first().click();
  await page.waitForTimeout(300);
};

// name → { q: query, act?: async (page, kind) => {}, only?: 'desktop'|'mobile', full?: bool }
const JOBS = {
  'side-hand': { q: 'fixture=p-host-busy', only: 'desktop' },
  'side-lasthand': { q: 'fixture=showdown-complete', only: 'desktop' },
  'side-chat': { q: 'fixture=p-player-chat', only: 'desktop', act: async (p) => p.click('[data-tab=chat]') },
  'side-players': { q: 'fixture=p-host-busy', only: 'desktop', act: async (p) => p.click('[data-tab=players]') },
  'side-away': { q: 'fixture=away', only: 'desktop', act: async (p) => p.click('[data-tab=hand]') },
  'side-leaving': { q: 'fixture=p-leaving', only: 'desktop', act: async (p) => p.click('[data-tab=hand]') },
  'side-spectator': { q: 'fixture=spectator', only: 'desktop' },
  host: { q: 'fixture=p-host-busy&open=host', full: true },
  'host-adjust': {
    q: 'fixture=p-host-busy&open=host',
    full: true,
    act: async (page, kind) => {
      if (kind === 'desktop') await page.getByRole('button', { name: 'Adjust chips' }).first().click();
      else await page.locator('button.prow').first().click();
      await page.waitForTimeout(250);
      await page.getByLabel('Amount', { exact: true }).fill('50');
      await page.waitForTimeout(200);
    },
  },
  'host-rules': { q: 'fixture=p-host-busy&open=host', only: 'desktop', full: true, act: clickText('Edit rules (applies next hand)') },
  ledger: { q: 'fixture=p-host-busy&open=ledger', full: true },
  'ledger-ended': { q: 'fixture=ended', full: true },
  'ledger-session': { q: 'fixture=ledger-after-session&open=ledger', full: true },
  'm-chat': { q: 'fixture=p-player-chat&open=chat', only: 'mobile' },
  'm-log': { q: 'fixture=showdown-complete&open=log', only: 'mobile' },
  'm-players': { q: 'fixture=p-host-busy&open=players', only: 'mobile' },
  'm-menu': { q: 'fixture=p-player-chat&dialog=menu', only: 'mobile' },
  'dlg-buyin': { q: 'fixture=busted&dialog=buyin' },
  'dlg-rebuy': { q: 'fixture=seated-waiting&dialog=buyin' },
  'dlg-join': { q: 'fixture=visitor' },
  'dlg-leave': { q: 'fixture=seated-waiting&dialog=leave' },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(JOBS);
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const chromeArgs = ['--ignore-certificate-errors'];
if (proxyUrl) {
  const u = new URL(proxyUrl);
  chromeArgs.push('--proxy-server=' + u.protocol + '//' + u.host, '--proxy-bypass-list=127.0.0.1;localhost');
}
const browser = await pw.chromium
  .launch({ args: chromeArgs, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  .catch(() => pw.chromium.launch({ args: chromeArgs }));
const errors = [];
for (const name of names) {
  const job = JOBS[name];
  if (!job) {
    console.log('unknown job', name);
    continue;
  }
  for (const [kind, vp] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    if (job.only && job.only !== kind) continue;
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: vp, deviceScaleFactor: 1, hasTouch: kind === 'mobile', isMobile: kind === 'mobile' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}/${kind}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name}/${kind} console ${m.type()}: ${m.text()}`);
    });
    await page.goto(BASE + '?' + job.q + '&embed=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    try {
      if (job.act) await job.act(page, kind);
    } catch (e) {
      errors.push(`${name}/${kind} act: ${e.message.split('\n')[0]}`);
    }
    await page.waitForTimeout(400);
    const file = path.join(OUT, `panels-${name}-${kind}.png`);
    // Modal content scrolls inside the dialog; for full shots expand the scroller.
    if (job.full) {
      await page.evaluate(() => {
        const b = document.querySelector('.modal-backdrop .modal-body');
        const m = document.querySelector('.modal-backdrop .modal, .modal-backdrop .sheet');
        if (b && m) {
          const extra = b.scrollHeight - b.clientHeight;
          if (extra > 0) {
            document.documentElement.classList.remove('modal-open');
            document.documentElement.style.height = 'auto';
            const bd = document.querySelector('.modal-backdrop');
            bd.style.position = 'absolute';
            bd.style.minHeight = window.innerHeight + extra + 60 + 'px';
            bd.style.height = 'auto';
            m.style.maxHeight = 'none';
            m.style.height = m.getBoundingClientRect().height + extra + 'px';
          }
        }
      });
      await page.waitForTimeout(200);
    }
    await page.screenshot({ path: file, fullPage: !!job.full });
    console.log('wrote', path.relative(process.cwd(), file));
    await ctx.close();
  }
}
await browser.close();
if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
