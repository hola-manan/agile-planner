// dev/design-shots.mjs — render the design mockups (design/*.dc.html) to PNG for side-by-side review.
//   node dev/design-shots.mjs [Name …]     (default: every mockup)
// Serves design/ itself (no dev server needed); support.js is replaced by dev/design-shim.js.
// Writes dev/shots/design-<Name>.png at each mockup's $preview size. Dev only, not deployed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/node22/lib/node_modules/playwright');
}
const DEV = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV, '..');
const DESIGN = path.join(ROOT, 'design');
const OUT = path.join(DEV, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const names = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(DESIGN).filter((f) => f.endsWith('.dc.html')).map((f) => f.replace(/\.dc\.html$/, ''));

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/support.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    return res.end(fs.readFileSync(path.join(DEV, 'design-shim.js')));
  }
  const file = path.join(DESIGN, path.basename(p));
  if (!fs.existsSync(file)) {
    res.writeHead(404);
    return res.end('nope');
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy;
const args = ['--ignore-certificate-errors'];
if (proxyUrl) {
  const u = new URL(proxyUrl);
  args.push('--proxy-server=' + u.protocol + '//' + u.host, '--proxy-bypass-list=127.0.0.1;localhost');
}
const browser = await pw.chromium
  .launch({ args, executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' })
  .catch(() => pw.chromium.launch({ args }));

for (const name of names) {
  const src = fs.readFileSync(path.join(DESIGN, name + '.dc.html'), 'utf8');
  const m = /"\$preview":\{"width":(\d+),"height":(\d+)\}/.exec(src);
  const vp = m ? { width: Number(m[1]), height: Number(m[2]) } : { width: 1440, height: 1000 };
  const mobile = vp.width < 900;
  const ctx = await browser.newContext({ viewport: vp, ignoreHTTPSErrors: true, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(name, 'pageerror', e.message));
  await page.goto(base + name + '.dc.html', { waitUntil: 'load' });
  await page.waitForSelector('html[data-design-ready]', { timeout: 10000 }).catch(() => console.log(name, 'not ready'));
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.waitForTimeout(300);
  const file = path.join(OUT, 'design-' + name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  console.log('wrote', path.relative(ROOT, file), vp.width + '×' + vp.height);
  await ctx.close();
}
await browser.close();
server.close();
