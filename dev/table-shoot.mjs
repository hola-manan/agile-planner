// dev/table-shoot.mjs — screenshots of the table + action bar through the preview harness.
//   node dev/table-shoot.mjs [base=http://127.0.0.1:8791/dev/preview.html] fixture[,fixture…] [--only=desktop|mobile]
// Writes dev/shots/table-<fixture>-desktop.png (1440×1000) and -mobile.png (390×844); prints page errors.
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
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const rest = args.filter((a) => !a.startsWith('--'));
const base = rest[0] && rest[0].startsWith('http') ? rest.shift() : 'http://127.0.0.1:8791/dev/table-preview.html';
const jobs = rest.flatMap((a) => a.split(',')).filter(Boolean);

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
for (const job of jobs) {
  const query = job.includes('=') ? job : 'fixture=' + job;
  const name = query.replace(/fixture=/g, '').replace(/[&=]/g, '-');
  const kinds = [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]].filter(([k]) => !only || k === only);
  for (const [kind, vp] of kinds) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: vp, deviceScaleFactor: kind === 'mobile' ? 2 : 1, hasTouch: kind === 'mobile', isMobile: kind === 'mobile' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${name}/${kind}: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') errors.push(`${name}/${kind} console.${m.type()}: ${m.text()}`);
    });
    await page.goto(base + '?' + query + '&embed=1', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    const file = path.join(OUT, `table-${name}-${kind}.png`);
    await page.screenshot({ path: file });
    console.log('wrote', path.relative(process.cwd(), file));
    await ctx.close();
  }
}
await browser.close();
if (errors.length) console.log('ERRORS:\n' + [...new Set(errors)].join('\n'));
