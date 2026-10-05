// dev/shoot.mjs — screenshot the preview harness with Playwright (dev only).
//   node dev/shoot.mjs [base=http://127.0.0.1:8790/dev/preview.html] [names...]
// Writes dev/shots/<name>-desktop.png (1440×1000) and <name>-mobile.png (390×844).
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
const args = process.argv.slice(2);
const base = args[0] && args[0].startsWith('http') ? args.shift() : 'http://127.0.0.1:8790/dev/preview.html';
const jobs = args.length ? args : ['lobby'];

// Google Fonts go through the environment's HTTPS proxy when there is one (local URLs bypass it).
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const chromeArgs = ['--ignore-certificate-errors'];
if (proxyUrl) {
  const u = new URL(proxyUrl);
  chromeArgs.push('--proxy-server=' + u.protocol + '//' + u.host, '--proxy-bypass-list=127.0.0.1;localhost');
}
const opts = { args: chromeArgs };
const browser = await pw.chromium
  .launch({ ...opts, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  .catch(() => pw.chromium.launch(opts));
const errors = [];
for (const job of jobs) {
  // job: "<query>" e.g. "fixture=allin-vote" or "lobby=1" or "fixture=x&open=ledger"; name derived
  const query = job.includes('=') ? job : 'fixture=' + job;
  const name = query.replace(/fixture=|lobby=1/g, (m) => (m === 'lobby=1' ? 'lobby' : '')).replace(/[&=]/g, '-').replace(/^-+/, '');
  for (const [kind, vp] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: vp, deviceScaleFactor: 1, hasTouch: kind === 'mobile', isMobile: kind === 'mobile' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}/${kind}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`${name}/${kind} console: ${m.text()}`);
    });
    await page.goto(base + '?' + query + '&embed=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const file = path.join(OUT, `${name}-${kind}.png`);
    await page.screenshot({ path: file, fullPage: kind === 'desktop' || query.includes('lobby') });
    console.log('wrote', path.relative(process.cwd(), file));
    await ctx.close();
  }
}
await browser.close();
if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
