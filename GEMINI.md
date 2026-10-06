# Felt — home-game poker web app

Felt is a private, real-time poker site for playing with friends (No-Limit Hold'em and Pot-Limit Omaha,
2–9 seats): buy-in requests, host chip adjustments, a ledger with settle-up, run-it-twice/thrice, optional
showing of cards, runout reveal after a fold, all-in win odds, away mode, keyboard shortcuts. It is hosted on
Hatchable (V8 isolates + Postgres + realtime events). `SPEC.md` is the binding contract for every part.

## Standing rules for the implementing agent
- Implement the plan in `plans/current.md` exactly. Do not deviate or add unrequested features.
- Never touch anything outside this project directory (no global installs, no config outside the repo, no
  sibling folders). If you discover an out-of-repo need, list it at the end of your response instead.
- Do not git commit, push or deploy.
- No build step and no npm packages: plain ES modules, React 18 UMD + htm (no JSX, `class=` not `className`).
- Never write destructured exports (`export const { a } = x`) — Hatchable's deploy parser rejects them.
  One `export const name = …` per name.
- `public/js` modules import each other with relative paths (`./ui.js`). `lib/` files are pure (no clock,
  no randomness, no `hatchable` import) except `lib/store.js`.
- Never add polling loops (`setInterval`/`setTimeout` fetches) in `public/js`; realtime comes from events.

## Layout
```
SPEC.md                    contract: state, engine rules, HTTP API, view JSON, frontend modules, design tokens
design/*.dc.html           approved visual mockups (desktop + phone) — reference only, not deployed
lib/                       server logic: cards, evaluator, equity, engine (state machine), view, ledger,
                           ratelimit, store (DB + realtime publish)
api/*.js                   HTTP routes: create, join, state, act, events-token
public/index.html          SPA shell (loads vendor React/htm, css, /js/main.js)
public/js/                 h.js (htm/React bindings), api.js, room.js (data hook), ui.js (primitives),
                           main.js (App + room layout), lobby.js, table.js, actionbar.js (+ keyboard
                           shortcuts), hotkeys.js (pure shortcut decisions), side.js (side panel Hand/Players, hand log,
                           ChatDock bottom-left on desktop, ChatFab on phones, players, session box), host.js, ledger.js, dialogs.js, csv.js
public/css/                base.css (tokens/primitives), lobby.css (lobby + room shell), table.css, panels.css
dev/                       local dev server, fakes, preview harness + fixtures (not deployed)
server/                    DEPLOYED production host shim for Render: hatchable.mjs (in-memory db+events SDK),
                           events-shim.js (browser realtime, /__events/sse), loader/register, index.mjs (HTTP server)
render.yaml                Render blueprint (web service, node, free plan; git-push auto-deploy)
test/                      node:test suites, e2e.mjs (3 browsers), live-smoke.mjs (deployed site)
plans/                     implementation plans (current.md)
```

## Commands
- Production server (what Render runs): `npm start` → `node --import ./server/register.mjs server/index.mjs`
  (binds HOST 0.0.0.0 + PORT from env; in-memory store, optional FELT_DB_FILE JSON persistence)
- Unit tests: `node --test test/*.test.js`
- End-to-end (3 Playwright browsers on a local dev server it starts itself): `node test/e2e.mjs`
- Dev server: `npm run dev` → http://127.0.0.1:8787 (`FELT_DEV_TIME=1` enables POST /__dev/time {advance})
- Preview harness with engine-generated fixtures: `/__dev/preview.html?fixture=<name>&w=mobile`

## Conventions
- Design tokens: charcoal background #262626, panels #303030, brass accent #E6B85C, felt #3DAA6E→#1F8549,
  fonts Bricolage Grotesque (UI) + JetBrains Mono (numbers). Desktop ≥ 900px, phone < 900px (`useIsMobile`).
- Accessibility: real buttons, aria-labels on icon buttons, 44px touch targets on phones.
- Keyboard shortcuts are decided in `public/js/hotkeys.js` (pure, unit-tested) and wired by the single
  document listener `useHotkeys` in `public/js/actionbar.js`; the cheat sheet lists `HOTKEYS`.
