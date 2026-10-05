// dev/server.mjs — local stand-in for Hatchable hosting (never deployed).
//
//   npm run dev            (= node --import ./dev/register.mjs dev/server.mjs)
//   PORT=9000 npm run dev
//
//   /                       public/ (static, correct MIME types; extension-less paths → index.html)
//   /api/<path>             api/<path>.js default export, Express-shaped req/res, `methods` → 405
//   /__hatchable/events.js  browser realtime shim (dev/events-shim.js) — same API as the platform lib
//   /__dev/sse              Server-Sent Events stream for one channel (used by the shim)
//   /__dev/**               files under dev/
//   /__design/              design mockups (design/*.dc.html), with an index
//   POST /__dev/time        { advance: ms } — shift the server clock (only when FELT_DEV_TIME=1; tests)
//
// Env: PORT (default 8787; 0 = random), HOST (default 127.0.0.1), FELT_DEV_DB (persist rooms to a
// JSON file), FELT_DEV_TIME=1 (enable /__dev/time), FELT_QUIET=1 (no request log),
// FELT_NO_STUB=1 (never fall back to dev/stub-engine).

import http from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { __dev as hatch } from 'hatchable';

const DEV_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DEV_DIR, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');
const DESIGN_DIR = path.join(ROOT, 'design');
const PORT = process.env.PORT === undefined ? 8787 : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const QUIET = !!process.env.FELT_QUIET;
const TIME_CONTROL = process.env.FELT_DEV_TIME === '1';
const MAX_BODY = 1024 * 1024;

// ─── optional clock control (tests) ──────────────────────────────────────────
let clockOffset = 0;
if (TIME_CONTROL) {
  const realNow = Date.now.bind(Date);
  Date.now = () => realNow() + clockOffset;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

const mimeFor = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

/** Resolve `rel` inside `baseDir`; null if it escapes the directory. */
function safeJoin(baseDir, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const full = path.resolve(baseDir, '.' + path.posix.normalize('/' + decoded));
  return full === baseDir || full.startsWith(baseDir + path.sep) ? full : null;
}

async function fileIfExists(p) {
  if (!p) return null;
  try {
    const s = await stat(p);
    if (s.isFile()) return { path: p, size: s.size };
    if (s.isDirectory()) {
      const idx = path.join(p, 'index.html');
      const si = await stat(idx).catch(() => null);
      if (si && si.isFile()) return { path: idx, size: si.size };
    }
  } catch {}
  return null;
}

function streamFile(req, res, file, extraHeaders = {}) {
  res.writeHead(200, {
    'content-type': mimeFor(file.path),
    'content-length': file.size,
    'cache-control': 'no-cache',
    ...extraHeaders,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file.path).pipe(res);
}

/** Static from `dir`. With `spaFallback`, extension-less misses serve dir/index.html. */
async function serveStatic(req, res, dir, rel, { spaFallback = false } = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method Not Allowed');
  const target = safeJoin(dir, rel);
  if (!target) return sendText(res, 400, 'Bad path');
  const file = await fileIfExists(target);
  if (file) return streamFile(req, res, file);
  if (spaFallback && !path.extname(rel)) {
    const index = await fileIfExists(path.join(dir, 'index.html'));
    if (index) return streamFile(req, res, index);
  }
  return sendText(res, 404, 'Not found: ' + rel);
}

async function serveDesign(req, res, rel) {
  if (rel === '' || rel === '/') {
    const files = (await readdir(DESIGN_DIR).catch(() => [])).filter((f) => f.endsWith('.html')).sort();
    const items = files.map((f) => `<li><a href="/__design/${encodeURIComponent(f)}">${f}</a></li>`).join('');
    return sendText(
      res,
      200,
      `<!doctype html><meta charset="utf-8"><title>Felt design mockups</title>` +
        `<body style="font:15px system-ui;background:#262626;color:#ECE8DF;padding:24px">` +
        `<h1 style="font-size:20px">Design mockups</h1><ul style="line-height:1.9">${items}</ul>` +
        `<style>a{color:#E6B85C}</style>`,
      'text/html; charset=utf-8',
    );
  }
  return serveStatic(req, res, DESIGN_DIR, rel);
}

// ─── realtime: SSE ───────────────────────────────────────────────────────────

function serveSse(req, res, url) {
  const channel = url.searchParams.get('channel') || '';
  const token = url.searchParams.get('token') || '';
  if (!hatch.verifyGrant(token, channel)) {
    return sendJson(res, 401, { error: 'Invalid or expired events token for channel ' + channel, code: 'unauthorized' });
  }
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');

  const write = (ev) => {
    res.write((ev.id != null ? `id: ${ev.id}\n` : '') + `data: ${JSON.stringify(ev)}\n\n`);
  };
  const lastId = req.headers['last-event-id'] ?? url.searchParams.get('lastEventId');
  if (lastId != null && lastId !== '') {
    const { events, gap } = hatch.since(channel, lastId);
    if (gap) write({ id: null, channel, event: '$reset', data: null });
    events.forEach(write);
  }
  const unsubscribe = hatch.subscribe(channel, write);
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  const done = () => {
    clearInterval(ping);
    unsubscribe();
  };
  req.on('close', done);
  res.on('error', done);
}

// ─── API routes ──────────────────────────────────────────────────────────────

const ROUTE_SEGMENT = /^[A-Za-z0-9_-]+$/;

async function findApiModule(rel) {
  const segs = rel.split('/').filter(Boolean);
  if (segs.length === 0 || !segs.every((s) => ROUTE_SEGMENT.test(s))) return null;
  for (const candidate of [path.join(API_DIR, ...segs) + '.js', path.join(API_DIR, ...segs, 'index.js')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseQuery(searchParams) {
  const q = {};
  for (const key of new Set(searchParams.keys())) {
    const all = searchParams.getAll(key);
    q[key] = all.length === 1 ? all[0] : all;
  }
  return q;
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded')) return parseQuery(new URLSearchParams(raw));
  if (ct.includes('json') || /^\s*[[{]/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
    }
  }
  return raw;
}

/** Express-shaped response wrapper over node's ServerResponse. */
function makeRes(nodeRes) {
  let statusCode = 200;
  const res = {
    headersSent: false,
    get statusCode() {
      return statusCode;
    },
    status(n) {
      statusCode = n;
      return res;
    },
    setHeader(name, value) {
      if (!res.headersSent) nodeRes.setHeader(name, value);
      return res;
    },
    json(obj) {
      if (!nodeRes.hasHeader('content-type')) nodeRes.setHeader('content-type', 'application/json; charset=utf-8');
      return res.send(JSON.stringify(obj === undefined ? null : obj));
    },
    send(body) {
      if (res.headersSent) throw new Error('Response already sent');
      res.headersSent = true;
      if (body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
        if (!nodeRes.hasHeader('content-type')) nodeRes.setHeader('content-type', 'application/json; charset=utf-8');
        body = JSON.stringify(body);
      }
      if (typeof body === 'string' && !nodeRes.hasHeader('content-type')) {
        nodeRes.setHeader('content-type', 'text/html; charset=utf-8');
      }
      nodeRes.statusCode = statusCode;
      nodeRes.end(body == null ? undefined : body);
      return res;
    },
    redirect(url, code = 302) {
      if (typeof url === 'number') [url, code] = [code, url];
      nodeRes.setHeader('location', url);
      statusCode = code;
      return res.send('');
    },
    end(body) {
      return res.send(body ?? '');
    },
  };
  return res;
}

async function serveApi(req, nodeRes, url, rel) {
  const file = await findApiModule(rel);
  if (!file) return sendJson(nodeRes, 404, { error: 'No such API route: /api/' + rel, code: 'not_found' });

  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    console.error(`[dev] failed to load api/${rel}.js:\n`, err);
    return sendJson(nodeRes, 500, { error: 'Failed to load route module: ' + err.message, code: 'internal' });
  }
  if (typeof mod.default !== 'function') {
    return sendJson(nodeRes, 500, { error: 'Function module must export a default function (req, res).', code: 'internal' });
  }
  const ACCESS = ['public', 'user', 'member', 'admin', 'scheduler'];
  if (!ACCESS.includes(mod.access)) {
    return sendJson(nodeRes, 500, {
      error: `api/${rel}.js must export const access = 'public' | 'user' | 'member' | 'admin' | 'scheduler' (deploy would fail)`,
      code: 'internal',
    });
  }
  if (mod.access !== 'public') {
    return sendJson(nodeRes, 401, { error: 'login_required (dev server only serves public routes)', code: 'login_required' });
  }
  if (Array.isArray(mod.methods) && !mod.methods.map((m) => String(m).toUpperCase()).includes(req.method)) {
    nodeRes.setHeader('allow', mod.methods.join(', '));
    return sendJson(nodeRes, 405, { error: 'Method Not Allowed', code: 'method_not_allowed' });
  }

  let rawBody = '';
  let body = {};
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      rawBody = await readBody(req);
      body = parseBody(rawBody, req.headers['content-type']);
    }
  } catch (err) {
    return sendJson(nodeRes, err.status || 400, { error: err.message, code: 'bad_request' });
  }

  const ereq = {
    method: req.method,
    url: req.url,
    path: url.pathname,
    headers: req.headers, // node lowercases header names
    query: parseQuery(url.searchParams),
    body,
    rawBody: rawBody || null,
    params: {},
    ip: req.socket.remoteAddress,
  };
  const res = makeRes(nodeRes);
  try {
    await mod.default(ereq, res);
    if (!res.headersSent) {
      console.warn(`[dev] api/${rel} returned without sending a response`);
      res.status(204).send('');
    }
  } catch (err) {
    console.error(`[dev] api/${rel} threw:\n`, err);
    if (!res.headersSent) sendJson(nodeRes, 500, { error: 'Internal error: ' + err.message, code: 'internal' });
  }
}

// ─── router ──────────────────────────────────────────────────────────────────

const SHIM_PATH = path.join(DEV_DIR, 'events-shim.js');

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p.startsWith('/api/')) return serveApi(req, res, url, p.slice(5));

  if (p === '/__hatchable/events.js') {
    return sendText(res, 200, readFileSync(SHIM_PATH, 'utf8'), 'text/javascript; charset=utf-8');
  }

  if (p === '/__dev/sse') return serveSse(req, res, url);

  if (p === '/__dev/time') {
    if (!TIME_CONTROL) return sendJson(res, 404, { error: 'Start the server with FELT_DEV_TIME=1 to enable clock control' });
    if (req.method === 'POST') {
      const body = parseBody(await readBody(req), 'application/json');
      const ms = Number(body.advance);
      if (!Number.isFinite(ms)) return sendJson(res, 400, { error: 'advance must be a number of ms' });
      clockOffset += ms;
    }
    return sendJson(res, 200, { now: Date.now(), offset: clockOffset });
  }

  if (p === '/__dev' || p.startsWith('/__dev/')) return serveStatic(req, res, DEV_DIR, p.slice('/__dev'.length) || '/');

  if (p === '/__design') return res.writeHead(301, { location: '/__design/' }).end();
  if (p.startsWith('/__design/')) return serveDesign(req, res, p.slice('/__design/'.length));

  return serveStatic(req, res, PUBLIC_DIR, p, { spaFallback: true });
}

const server = http.createServer((req, res) => {
  const t0 = performance.now();
  if (!QUIET && req.url.startsWith('/api/')) {
    res.on('finish', () => {
      const ms = (performance.now() - t0).toFixed(1);
      console.log(`${req.method} ${req.url} → ${res.statusCode} (${ms} ms)`);
    });
  }
  handle(req, res).catch((err) => {
    console.error('[dev] request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Dev server error: ' + err.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`Felt dev server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
  if (!QUIET) {
    console.log(`  app      http://localhost:${port}/`);
    console.log(`  designs  http://localhost:${port}/__design/`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
