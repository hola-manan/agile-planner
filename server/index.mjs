import http from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { server as hatch } from 'hatchable';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SERVER_DIR, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const API_DIR = path.join(ROOT, 'api');
const PORT = process.env.PORT ? Number(process.env.PORT) : 8787;
const HOST = process.env.HOST || '0.0.0.0';
const QUIET = !!process.env.FELT_QUIET;
const MAX_BODY = 1024 * 1024;

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
    console.error(`[server] failed to load api/${rel}.js:\n`, err);
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
    return sendJson(nodeRes, 401, { error: 'login_required', code: 'login_required' });
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
    headers: req.headers, 
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
      console.warn(`[server] api/${rel} returned without sending a response`);
      res.status(204).send('');
    }
  } catch (err) {
    console.error(`[server] api/${rel} threw:\n`, err);
    if (!res.headersSent) sendJson(nodeRes, 500, { error: 'Internal error: ' + err.message, code: 'internal' });
  }
}

const SHIM_PATH = path.join(SERVER_DIR, 'events-shim.js');

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/__hatchable/events.js') {
    return sendText(res, 200, readFileSync(SHIM_PATH, 'utf8'), 'text/javascript; charset=utf-8');
  }

  if (p === '/__events/sse') return serveSse(req, res, url);

  if (p.startsWith('/api/')) return serveApi(req, res, url, p.slice(5));

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
    console.error('[server] request failed:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Server error: ' + err.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`Felt production server listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
