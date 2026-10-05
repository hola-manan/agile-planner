// test/static.test.js — platform rules that are easy to break and cheap to check (SPEC §0, §1, §12).
//
//   - api/ and lib/ import only 'hatchable', 'lib/<file>.js' (api only) and relative paths;
//     the pure lib modules import nothing from the platform and read no clock / randomness
//   - every api/*.js exports `access = 'public'`, `methods = [...]` and a default async function
//   - public/js: no JSX, no bare/remote module imports, no network polling timers
//     (the only timer allowed to touch the network is the single deadline tick in room.js)
//   - public/index.html loads only own-origin scripts; the only remote URL is Google Fonts CSS
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const list = (dir, ext = '.js') =>
  fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => dir + '/' + f);

/** Every module specifier in a source file (static imports, re-exports, dynamic imports). */
function specifiers(src) {
  const out = [];
  const re = /(?:^|[;\s])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[;\s])import\s*['"]([^'"]+)['"]/gms;
  for (const m of src.matchAll(re)) out.push(m[1] || m[2] || m[3]);
  return out;
}

/** Strip comments (good enough for our own sources: no regex literals containing comment markers). */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** The source text of the first argument (a function) of each call to `name(` — balanced braces/parens. */
function callbacks(src, name) {
  const out = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(name + '(', i);
    if (at < 0) break;
    let depth = 0;
    let j = at + name.length;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(at, j + 1));
    i = j;
  }
  return out;
}

const PURE = ['lib/cards.js', 'lib/evaluator.js', 'lib/equity.js', 'lib/engine.js', 'lib/view.js', 'lib/ledger.js'];

test('api/ and lib/ import only hatchable, lib/… (api) and relative modules', () => {
  for (const f of [...list('api'), ...list('lib')]) {
    const inApi = f.startsWith('api/');
    for (const s of specifiers(read(f))) {
      const ok = s === 'hatchable' || (inApi && /^lib\/[\w-]+\.js$/.test(s)) || (!inApi && /^\.\/[\w-]+\.js$/.test(s));
      assert.ok(ok, `${f} imports '${s}'`);
    }
  }
});

test('the pure lib modules touch no platform API, clock or randomness', () => {
  for (const f of PURE) {
    const src = code(read(f));
    assert.ok(!specifiers(src).includes('hatchable'), f + ' imports hatchable');
    for (const bad of ['Date.now', 'Math.random', 'new Date(', 'performance.now', 'setTimeout', 'setInterval', 'fetch(']) {
      assert.ok(!src.includes(bad), `${f} uses ${bad}`);
    }
  }
});

test('every api/*.js exports access = public, methods and a default async function', () => {
  const files = list('api');
  assert.ok(files.length >= 5, 'api routes present');
  for (const f of files) {
    const src = read(f);
    assert.match(src, /^export const access = 'public';?$/m, f + ': access');
    assert.match(src, /^export const methods = \[[^\]]+\];?$/m, f + ': methods');
    assert.match(src, /^export default async function\b/m, f + ': default export');
  }
});

test('public/js: htm only (no JSX), own-origin relative imports only', () => {
  for (const f of list('public/js')) {
    const src = code(read(f));
    assert.ok(!/className=/.test(src), f + ' uses className= (htm wants class=)');
    // JSX would be a tag outside an html`` template; htm components are written <${Comp}>.
    assert.ok(!/return\s*\(\s*<[A-Za-z]/.test(src) && !/=\s*<[A-Z][A-Za-z]*[\s/>]/.test(src), f + ' looks like JSX');
    for (const s of specifiers(src)) assert.match(s, /^\.\/[\w-]+\.js$/, `${f} imports '${s}'`);
    assert.ok(!/https?:\/\//.test(src.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, '')), f + ' references a remote URL');
  }
});

test('public/js: no polling — only the deadline tick (and a one-shot lag retry) touch the network from a timer', () => {
  const NET = /\b(fetch|apiState|apiAct|apiJoin|apiCreate|refresh|act)\s*\(/;
  for (const f of list('public/js')) {
    const src = code(read(f));
    for (const cb of callbacks(src, 'setInterval')) {
      assert.ok(!NET.test(cb.slice('setInterval('.length)), `${f}: a setInterval touches the network:\n${cb}`);
    }
    for (const cb of callbacks(src, 'setTimeout')) {
      const body = cb.slice('setTimeout('.length);
      if (!NET.test(body)) continue;
      const deadlineTick = f === 'public/js/room.js' && /act\('tick'/.test(body);
      const lagRetry = f === 'public/js/room.js' && /^\(\)\s*=>\s*aliveRef\.current\s*&&\s*refresh\(\)/.test(body);
      assert.ok(deadlineTick || lagRetry, `${f}: a setTimeout touches the network:\n${cb}`);
    }
  }
  // exactly one deadline tick timer
  const room = code(read('public/js/room.js'));
  assert.equal((room.match(/act\('tick'/g) || []).length, 1, 'one tick call site');
});

test('index.html: own-origin scripts in the SPEC order; only Google Fonts is remote', () => {
  const html = read('public/index.html');
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  const srcs = scripts.map((a) => (/src="([^"]+)"/.exec(a) || [])[1]);
  assert.deepEqual(srcs, ['/vendor/react.js', '/vendor/react-dom.js', '/vendor/htm.js', '/__hatchable/events.js', '/js/main.js']);
  assert.match(scripts[4], /type="module"/);
  const remote = [...html.matchAll(/(?:href|src)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const u of remote) assert.match(u, /^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/, 'remote URL ' + u);
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(sheets.slice(1), ['/css/base.css', '/css/table.css', '/css/panels.css', '/css/lobby.css']);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(html, /<div id="root"><\/div>/);
  for (const v of ['react', 'react-dom', 'htm']) assert.ok(fs.existsSync(path.join(ROOT, 'public/vendor', v + '.js')), 'vendor ' + v);
});

test('the SPEC §12 module exports exist', async () => {
  const want = {
    'h.js': ['html'],
    'api.js': ['ApiError', 'getSession', 'setSession', 'clearSession', 'apiCreate', 'apiJoin', 'apiState', 'apiAct'],
    'room.js': ['RoomContext', 'useRoomData', 'useRoom', 'useClock'],
    'ui.js': ['cx', 'fmt', 'Button', 'Pill', 'Avatar', 'Card', 'useFourColor', 'Modal', 'Sheet', 'useIsMobile', 'toast', 'Toasts', 'Countdown', 'Icon'],
    'lobby.js': ['Lobby'],
    'dialogs.js': ['BuyInDialog', 'LeaveDialog', 'JoinPrompt', 'ConfirmDialog'],
    'table.js': ['Table'],
    'actionbar.js': ['ActionBar'],
    'side.js': ['SidePanel', 'HandLog', 'Chat', 'PlayersList', 'SessionBox'],
    'host.js': ['HostTools'],
    'ledger.js': ['Ledger'],
    'main.js': ['App'],
  };
  for (const [file, names] of Object.entries(want)) {
    const src = read('public/js/' + file);
    for (const n of names) {
      const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let)\\s+${n}\\b|export\\s+const\\s*\\{[^}]*\\b${n}\\b|export\\s*\\{[^}]*\\b${n}\\b`);
      assert.match(src, re, `${file} exports ${n}`);
    }
  }
});
