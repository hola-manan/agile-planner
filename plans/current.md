# Plan: production hosting shim for Render (git-push deploy)

## Goal
Make Felt deployable to **Render** as a single Node web service (git-push auto-deploy), WITHOUT
changing any app logic. Today the only production host is Hatchable (`import { db, events } from 'hatchable'`).
`dev/server.mjs` is already a full stand-in for that host but is explicitly "never deployed" and carries
dev-only extras. This task adds a **deployed** production server under a new `server/` directory that
reproduces exactly the two platform capabilities the app uses — the `hatchable` SDK (`db`, `events`) and
the browser realtime shim at `/__hatchable/events.js` — and a `render.yaml` so Render builds and runs it.

First deploy is **in-memory** (zero npm dependencies, matches the project's no-deps rule). Durable Postgres
is explicitly OUT OF SCOPE for this task (it would require adding the `pg` package — a deliberate future
exception). Realtime events are in-process, so the service runs as a **single instance**; this is fine for
private home games and is enforced at the Render layer, not in code.

## Hard constraints (read before writing anything)
- **Only ADD files under a new `server/` directory, plus `render.yaml` and `.node-version` at the repo
  root, and ADD one line (`"start"`) to `package.json`'s `scripts`.** Do NOT modify any existing file
  except `package.json`. In particular do NOT touch `dev/`, `lib/`, `api/`, `public/`, `test/`, `SPEC.md`.
- **No npm packages, no build step.** Plain ES modules only. Node >= 22 built-ins only (`node:http`,
  `node:fs`, `node:crypto`, etc.). Do NOT add a `pg`/Postgres client or any dependency.
- **No destructured exports** (`export const { a } = x`). One `export const name = …` per name.
- The production `hatchable` SDK must honor the SPEC §9 contract EXACTLY as the dev fake does: the same
  three SQL statements, the same JSONB semantics, the same events contract (`publish`, `grant`). When in
  doubt, mirror `dev/fake-hatchable.mjs` behavior precisely — it is the reference.
- Do NOT git commit, push, or deploy. Do NOT touch anything outside this project directory. If you discover
  an out-of-repo need, list it at the END of your response instead of doing it.
- The dev workflow (`npm run dev`, `node --test test/*.test.js`, `node test/e2e.mjs`) must keep working
  unchanged. You are adding a parallel production path, not replacing the dev one.

## Files to create

### 1. `server/hatchable.mjs` — production platform SDK (in-memory)
A self-contained production implementation of the `hatchable` module. It is the deployed analogue of
`dev/fake-hatchable.mjs`; reproduce that file's behavior, keeping it standalone (do not import from `dev/`).
Export exactly:
- `export const db` — `{ async query(sql, params = []) }` implementing EXACTLY the three SPEC §9 statements
  over an in-memory `Map` (code → `{ state: <json text>, version, created_at, updated_at }`) with the same
  JSONB semantics as the fake (store canonical JSON text; return fresh deep clones; `yieldTick()` before
  each query so concurrent requests interleave and exercise the optimistic-retry path). Accept the
  migration `CREATE TABLE IF NOT EXISTS rooms …` as a no-op. Duplicate-key INSERT throws a pg-shaped error
  with `code === '23505'` and the `rooms_pkey` message. Mismatched-version UPDATE returns `rowCount: 0`.
  Any other SQL throws (only SPEC §9 statements are supported).
- `export const events` — `{ async publish(channel, event, payload), async grant(channels) }` identical in
  behavior to the fake: per-channel contiguous integer ids as strings, bounded history for replay
  (200/channel), 64KB payload cap, name validation regex `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`, in-process
  delivery to subscribers, grant tokens with a 120s TTL.
- `export const server` — the server-side helpers the HTTP layer needs (named `server`, NOT `__dev`):
  `verifyGrant(token, channel)`, `subscribe(channel, fn) → unsubscribe`, and
  `since(channel, lastId) → { events, gap }` — same semantics as the fake's `__dev.verifyGrant/subscribe/since`.
- **Optional file persistence (no new deps):** if `process.env.FELT_DB_FILE` is set, load rooms from that
  JSON file on boot and debounce-save on writes (same mechanism as the fake's `FELT_DEV_DB`). Default off
  (pure in-memory). This is only to support a future Render persistent disk; do not wire anything else to it.

### 2. `server/events-shim.js` — browser realtime shim (served at `/__hatchable/events.js`)
A production copy of the browser shim. Behavior MUST match `dev/events-shim.js` exactly (same
`window.hatchable.events.connect({ authUrl })` contract, EventSource-per-channel, Last-Event-ID replay,
`$reset` handling, token refetch + backoff reconnect). The ONLY change: the SSE endpoint URL constant is
`'/__events/sse'` (not `'/__dev/sse'`). `DEFAULT_AUTH_URL` stays `'/api/events-token'`. Mark it with a
distinct sentinel (e.g. a `__prod: true` style marker) rather than `__dev`.

### 3. `server/loader.mjs` — module resolve hook (production)
A `module.register()` resolve hook that maps the Hatchable bare specifiers for the DEPLOYED server:
- `'hatchable'` → `server/hatchable.mjs`
- `'lib/<path>'` → `<repo-root>/lib/<path>`
- relative imports from inside `lib/` resolve normally.
No stub-engine fallback (that was a dev bootstrap aid). Model it on `dev/loader.mjs` minus the stub logic.

### 4. `server/register.mjs`
`import { register } from 'node:module'; register('./loader.mjs', import.meta.url);` — the production analogue
of `dev/register.mjs`.

### 5. `server/index.mjs` — production HTTP server
A `node:http` server. Reuse the proven request/response plumbing from `dev/server.mjs` (MIME map,
`safeJoin`, `fileIfExists`, `streamFile`, `serveStatic` with SPA fallback, `readBody` with a 1MB cap,
`parseQuery`, `parseBody`, the Express-shaped `makeRes`, and the `/api` routing in `serveApi` incl. the
`access`/`methods` guards). Routes, in order:
- `GET/HEAD /__hatchable/events.js` → serve `server/events-shim.js` as `text/javascript; charset=utf-8`.
- `/__events/sse` → SSE endpoint: read `channel` + `token` query params, reject with 401 if
  `server.verifyGrant(token, channel)` is false, else stream events (same framing as `dev/server.mjs`'s
  `serveSse`: `retry:`, `id:`/`data:` lines, Last-Event-ID replay via `server.since` with `$reset` on gap,
  20s `: ping`, subscribe via `server.subscribe`, clean up on `req.on('close')`).
- `/api/<path>` → `serveApi` against the repo `api/` dir (all Felt routes export `access = 'public'`;
  keep the same behavior as dev: non-public → 401, bad method → 405, missing route → 404).
- everything else → static from `public/` with SPA fallback (extension-less misses → `public/index.html`).
- DROP all dev-only routes: `/__dev/*`, `/__dev/sse`, `/__dev/time`, `/__design/*`, the stub fallback, and
  the request logger unless `FELT_QUIET` is unset (keep logging cheap; honor `FELT_QUIET=1` to silence).
- Bind `HOST = process.env.HOST || '0.0.0.0'` and `PORT = process.env.PORT ? Number(process.env.PORT) : 8787`
  (Render injects `PORT`). Log the listening URL on boot.
- Handle `SIGINT`/`SIGTERM` gracefully (close connections, exit), as `dev/server.mjs` does.
- Import the platform helpers via `import { server as hatch } from 'hatchable';` (resolved by the loader).

### 6. `render.yaml` — Render blueprint (repo root)
```yaml
services:
  - type: web
    name: felt
    runtime: node
    plan: free
    buildCommand: npm install --omit=dev
    startCommand: node --import ./server/register.mjs server/index.mjs
    healthCheckPath: /
    autoDeploy: true
    envVars:
      - key: HOST
        value: 0.0.0.0
      - key: FELT_QUIET
        value: "1"
```
(There are no runtime dependencies, so `npm install` is a near-no-op but keeps Render's Node detection happy.
Render supplies `PORT` automatically — do NOT hard-code it.)

### 7. `.node-version` — pin Node for Render
A single line: `22`.

### 8. `package.json` — add a start script
Add to `scripts` (do not remove or change the existing `dev`, `dev:watch`, `test`):
```json
"start": "node --import ./server/register.mjs server/index.mjs"
```

## Self-check before finishing (do NOT commit)
1. `node --check` every new `.mjs`/`.js` file you create.
2. Boot smoke test: start the prod server on an ephemeral port and confirm the full happy path, e.g.
   ```
   PORT=8910 HOST=127.0.0.1 FELT_QUIET=1 node --import ./server/register.mjs server/index.mjs &
   ```
   then: `GET /` returns 200 HTML; `GET /__hatchable/events.js` returns 200 JS; a `POST /api/create`
   with `{"hostName":"Ann"}` returns a JSON body containing `code`, `pid`, `token`, `view`; and
   `GET /api/events-token?code=<that code>` returns a JSON `{ token, channels: ["room:<code>"] }`.
   Kill the server afterward. Report the observed outputs.
3. Confirm you did NOT modify any file other than `package.json` and the new files listed above
   (`git status` should show only additions + the one-line package.json edit).

## Out of scope (do NOT do — Claude handles these outside the repo)
- Durable Postgres / the `pg` dependency.
- `git commit` / `git push`.
- Creating the Render service / connecting the GitHub repo (browser step).
