# Felt — home-game poker: build spec

This file is the single contract every part of the app is built against. If code and this
spec disagree, the spec wins. Design reference (exact look): `design/*.dc.html` (HTML mockups —
read them for colors, spacing, layout; ignore the `<x-dc>`/`{{hole}}` template mechanics).

## 0. Platform (Hatchable) rules that shape everything

- Hosting: Hatchable. No npm install, no build step. Server code runs in V8 isolates.
- `api/**.js` → HTTP endpoints. Each MUST `export const access = 'public'` and `export const methods = [...]`,
  and `export default async function (req, res)`. `req.body` is parsed JSON; `req.query`; `req.headers` (lowercase).
  `res.status(n).json(obj)`.
- Shared server code lives in root `lib/`. Inside `lib/`, files import each other with RELATIVE paths
  (`./cards.js`) so Node can run them locally. `api/` files import `lib/...` with the bare
  namespace `'lib/engine.js'` and the SDK with `import { db, events } from 'hatchable'`.
- `lib/cards.js`, `lib/evaluator.js`, `lib/equity.js`, `lib/engine.js`, `lib/view.js`, `lib/ledger.js`,
  `lib/ratelimit.js` are PURE (no `hatchable` import, no Date.now / Math.random inside — time and randomness are passed in).
  Only `lib/store.js` and `api/*` touch the SDK.
- Realtime: server `events.publish('room:' + code, 'update', { v: version })` after every committed change.
  The platform limits publishes PER PROJECT (burst ~60 per 10 s, shared by every room): a publish refused with
  `err.code === 'rate_limited'` is retried after `retryAfter` (capped, 3 tries), and cheap repeatable player
  actions are rate limited per player and per room (§9) so one client can't use the budget up.
  Browser: `<script src="/__hatchable/events.js">` then
  `hatchable.events.connect({ authUrl: '/api/events-token?code=' + code }).channel('room:' + code).on('update', ev => ...)`
  and `.on('$reset', ...)`. On any event with `ev.data.v > localVersion`, refetch `/api/state`.
  NEVER poll with setInterval. The only timers allowed client-side: (a) UI countdown rendering (no network),
  (b) ONE timeout armed for `view.deadline` (+ 150–900 ms jitter) that POSTs `{type:'tick'}` — the server
  advances time-based transitions lazily (action timeouts, run-it vote close, runout steps, next hand).
- Frontend: React 18 UMD + htm (vendored in `public/vendor/`), loaded as classic scripts → globals
  `React`, `ReactDOM`, `htm`. App code is own-origin ES modules under `public/js/` (`<script type="module" src="/js/main.js">`).
  No JSX. htm: `class=` not `className`, components `<${Comp} prop=${x} />`, close with `<//>`.
- Project starts private on Hatchable; the owner flips it public in console settings.

## 1. Files

```
SPEC.md
design/*.dc.html                visual reference (not deployed)
migrations/001_rooms.sql        CREATE TABLE rooms (single statement)
lib/cards.js                    deck, card helpers, rng shuffle
lib/evaluator.js                hand evaluation (Hold'em 7-card best-of, Omaha 2+3)
lib/equity.js                   win-probability (exact enumeration / Monte Carlo)
lib/engine.js                   game state machine (pure)
lib/ledger.js                   ledger summary + settlement (pure)
lib/ratelimit.js                per-player / per-room token buckets for cheap actions (pure)
lib/view.js                     per-viewer redacted view (pure)
lib/store.js                    DB load/save w/ optimistic version, auth, publish
api/create.js                   POST create room
api/join.js                     POST join room
api/state.js                    GET view
api/act.js                      POST every action (player, host, tick)
api/events-token.js             GET realtime subscribe token
public/index.html               SPA shell
public/vendor/{react,react-dom,htm}.js
public/css/*.css                styles
public/js/*.js                  ES modules
dev/                            local dev server + fakes (not deployed)
test/                           node:test suites (not deployed)
```

## 2. Cards

- A card is a 2-char string: rank `23456789TJQKA` + suit `shdc` → `'As'`, `'Td'`, `'9h'`, `'2c'`.
- UI shows rank `T` as `10`. Suit glyphs ♠ ♥ ♦ ♣ (use `font-variant-emoji: text`).
- `lib/cards.js` exports:
  - `RANKS`, `SUITS`, `fullDeck(): string[]` (52)
  - `shuffle(arr, rng)` — Fisher–Yates using `rng()` ∈ [0,1); returns new array
  - `rankOf(card): number` 2..14, `suitOf(card): 's'|'h'|'d'|'c'`
  - `cryptoRng(): () => number` — uses `crypto.getRandomValues` (global WebCrypto, available in isolate and Node ≥19)

## 3. Evaluator (`lib/evaluator.js`)

- `evaluate(cards: string[]): { score: number, category: number, name: string, best: string[] }`
  for 5–7 cards — best 5-card hand. Higher `score` wins; equal score = tie. `category` 0..8
  (0 High card, 1 Pair, 2 Two pair, 3 Three of a kind, 4 Straight, 5 Flush, 6 Full house, 7 Four of a kind, 8 Straight flush).
  Wheel A-2-3-4-5 straight is valid (5-high). `best` = the 5 cards used.
  `name` human text e.g. `"Pair of Kings"`, `"Two pair, Aces and Nines"`, `"Three Queens"`, `"Straight, Ten high"`,
  `"Flush, Ace high"`, `"Full house, Kings full of Fours"`, `"Four Sevens"`, `"Straight flush, Nine high"`,
  `"Royal flush"`, `"Ace high"`.
- `evaluateHoldem(hole: string[2], board: string[3..5])` → same shape (all 5–7 cards).
- `evaluateOmaha(hole: string[4], board: string[3..5])` → best using EXACTLY 2 hole + 3 board.
- `evaluateFor(variant: 'NLH'|'PLO', hole, board)` dispatcher.
- Must be fast: ≥ 300k 7-card evaluations/sec in Node. No lookup tables > 1 MB.

## 4. Equity (`lib/equity.js`)

- `equity({ variant, hands: { [pid]: string[] }, board: string[], dead: string[], rng, iterations? }) → { [pid]: number }`
  Returns win share 0..100 (ties split, e.g. two-way tie adds 0.5 to each). Exact enumeration when
  cards-to-come ≤ 2; Monte Carlo (`iterations` default 4000 Hold'em / 1500 Omaha) when 3–5 to come.
  Values are rounded to integers by the caller (engine) for display; result sums ≈ 100.
  Must finish < 400 ms for 9 Hold'em hands preflop, < 600 ms for 4 Omaha hands preflop.

## 5. Game state (persisted JSON in `rooms.state`)

Everything below is server-only; clients only ever see `view.js` output.

```js
state = {
  schema: 1,
  code: 'RVR-4821',              // [A-Z]{3}-[0-9]{4}
  name: 'Friday Night Game',
  createdAt: ms,
  hostId: pid,
  settings: {
    variant: 'NLH' | 'PLO',       // NLH = no-limit hold'em (2 hole), PLO = pot-limit omaha (4 hole)
    sb: 1, bb: 2,                 // integers, sb>=1, bb>=sb
    seats: 8,                     // 2..9
    minBuyIn: 100, maxBuyIn: 400, // integers, 1 <= min <= max
    approveBuyIns: true,          // false = auto-approve every buy-in request
    maxRuns: 2,                   // 1 = run once only, 2 or 3 = all-in players may vote to run it N times
    revealRunout: 'anyone',       // 'anyone' | 'winner' | 'host' | 'off'
    showdownLosers: 'choose',     // 'choose' | 'show'  (whether losing hands at a showdown are auto-shown)
    actionTime: 25,               // seconds per decision (10..120)
    nextHandDelay: 8,             // seconds between hand end and next deal (3..30)
    autoAwayTimeouts: 2,          // consecutive timeouts before auto-away (0 = never)
  },
  players: {
    [pid]: {
      id, name,                   // name 1..20 chars, trimmed
      tokenHash,                  // sha256 hex of the player's secret token (NEVER in views)
      seat: null | 0..seats-1,
      stack: 0,                   // chips behind (not counting chips committed in current hand)
      away: false, awayBy: null | 'self' | 'host' | 'timeout',
      waitForBB: false,           // when returning: only dealt in when they would post the big blind
      timeouts: 0,                // consecutive action timeouts
      leaveAfterHand: false,      // stand up + cash out when current hand ends
      awayAfterHand: false,       // go away when current hand ends
      pendingChips: 0,            // approved chips waiting for current hand to end
      joinedAt: ms,
      leaveBy: null | pid,        // host pid when the HOST removed them (deferred leave the player can't cancel)
      kicked?: true,              // host removed this unseated player from the game: tokenHash null, not listed,
                                  // not counted toward the 30-player cap, name free again (kept only while the
                                  // ledger / hand / last hand / payments still mention them; otherwise deleted)
    }
  },
  requests: [ { id, pid, kind: 'sit'|'rebuy', amount, seat: null|n, createdAt } ],
  pendingAdjust: [ { pid, mode: 'add'|'remove'|'set', amount, reason, countAsBuyIn, by } ],  // applied at hand end
  ledger: [ { id, t, type: 'buyin'|'cashout'|'adjust', pid, name, amount /*signed for adjust*/, countAsBuyIn, reason, by /*pid*/ } ],
  paid: { [settlementKey]: true },          // legacy ticks (rooms created before `payments`)
  payments: [ { id, key /*from>to:amount#id*/, from, fromName, to, toName, amount, t, by } ],  // ticked settle-ups
  rate: { room: {n,t}, players: { [pid]: {n,t} } },   // rate-limit buckets (lib/ratelimit.js), server-only
  chat: [ { id, t, pid, name, text } ],     // keep last 60, text 1..280 chars
  handNo: 0,
  button: null | seat,
  paused: false,                // host paused: no new hands start
  pauseAfterHand: false,        // host asked to pause when the current hand ends
  ended: false,                 // host ended the game: everyone cashed out, read-only ledger remains
  hand: null | Hand,
  lastHand: null | { no, log, results, boards },
  deadline: null | ms,          // the single next time-based transition
  deadlineKind: null | 'action' | 'ritVote' | 'runout' | 'nextHand',
  seq: 0,                       // monotonically increasing id source for requests/ledger/chat
}

Hand = {
  no, startedAt, variant, sb, bb,              // blinds snapshot at hand start
  button, sbSeat, bbSeat,
  deck: string[],                              // remaining undealt cards, in deal order (SECRET)
  order: pid[],                                // dealt-in players clockwise starting left of button
  ps: { [pid]: {
      pid, seat, hole: string[],               // SECRET unless shown
      startStack, bet /*this street*/, committed /*whole hand incl. bet*/,
      folded, allIn, acted /*since last full raise*/, lastAction: null|{type,amount},
      shown: boolean[],                        // per hole card, visible to everyone
      won: 0, handName: null,
  } },
  board: string[],                             // shared board dealt so far (0,3,4,5)
  street: 'preflop'|'flop'|'turn'|'river'|'showdown',
  phase: 'betting'|'ritVote'|'runout'|'complete',
  toAct: null | pid,
  currentBet,                                  // highest `bet` this street
  minRaise,                                    // size of the last full raise this street (>= bb)
  lastAggressor: null | pid,                   // last player to bet/raise (any street); null if none
  log: [ { street, pid, text, amount } ],      // human-readable, e.g. {pid, text:'raises to', amount:6}
  ritVotes: { [pid]: 1|2|3 }, ritVoters: pid[],
  runs: 1,                                     // decided number of runs
  runBoards: string[][],                       // one full board per run as dealt so far (runout phase)
  currentRun: 0,
  runResults: [ { winners: pid[], handName } ],
  equity: null | { run: n, by: { [pid]: int } },
  results: null | {
    endedBy: 'fold'|'showdown',
    pots: [ { amount, eligible: pid[], winnersByRun: pid[][] } ],
    awards: { [pid]: amount },                 // chips pushed to each player (incl. uncalled returns)
    runs: [ { board: string[], winners: pid[], handName } ],
  },
  runout: null | { cards: string[], by: pid }, // "would have come" cards revealed after a fold ending
  completedAt: null | ms,
}
```

## 6. Engine (`lib/engine.js`) — pure functions, mutate `state` in place

All take `ctx = { now: ms, rng: () => number }`. All throw `EngineError(message, code)` (exported class,
`err.code` one of `'bad_request'|'forbidden'|'not_your_turn'|'conflict'|'not_found'`) on invalid input;
never partially mutate on error (validate first).

```js
export function createRoom({ code, name, hostName, hostId, hostTokenHash, settings }, ctx) → state
export function addPlayer(state, { id, name, tokenHash }, ctx) → player
export function apply(state, pid, action, ctx) → void   // action = { type, ...args } (§8); pid may be null only for 'tick'
export function tick(state, ctx) → boolean               // process all elapsed deadlines; true if changed
export function sanitizeSettings(partial, base) → settings  // clamps/validates; throws EngineError on nonsense
```

`apply` must call `tick` first (so stale deadlines are processed before the action), then the action,
then `advance` (auto-actions for away players / all-in skips, scheduling the next deadline).

### 6.1 Starting a hand (`nextHand` deadline fires, or game becomes startable)

- Eligible = seated, `stack > 0`, `!away`, `!leaveAfterHand`; players with `waitForBB` are eligible only when
  they would be the big blind this hand (compute positions including them; if they are not BB, exclude them).
- Need ≥ 2 eligible and `!paused && !ended`. Otherwise `hand = null`, no deadline.
- When no hand is running and a hand becomes startable (someone sits, returns, gets chips, host unpauses),
  schedule `deadline = now + 3000, kind 'nextHand'` (if not already scheduled).
- Button: first hand → lowest eligible seat; then next eligible seat clockwise after the previous button.
- Heads-up (2 players): button posts SB and acts first preflop; the other posts BB and acts first postflop.
- 3+: SB = next eligible clockwise after button, BB = next after SB. Preflop first to act = after BB.
  Postflop first to act = first non-folded, non-all-in player clockwise after the button.
- Short stacks post what they have (all-in). If BB is all-in for less than bb, `currentBet` = max posted
  but the opening `minRaise` stays `bb`.
- Deck: `shuffle(fullDeck(), rng)`. Deal hole cards (2 NLH / 4 PLO) one at a time round-robin from `order`.
  Board cards are taken from the front of the remaining deck (no burns).
- `deadline = now + actionTime*1000`, kind `'action'`, `toAct` = first to act.
- Snapshot `sb`, `bb`, `variant` into the hand. Increment `state.handNo`. Clear `lastAction`s.

### 6.2 Betting

Action `{ type:'act', move:'fold'|'check'|'call'|'raise', to? }` — `to` = total bet for this street after the move.
- `fold` always legal on your turn. `check` legal iff `bet == currentBet`.
- `call` legal iff `bet < currentBet`; puts in `min(currentBet - bet, stack)` (all-in if short).
- `raise` (also used for an opening bet): `to` integer. Let `maxTo = bet + stack` (all-in).
  - NLH: legal `to` ∈ [`minTo`, `maxTo`] where `minTo = currentBet + minRaise` (opening bet: `max(bb, …)` → minTo = bb when currentBet = 0).
    If `maxTo < minTo`, the only legal raise is all-in `to = maxTo` (only if `maxTo > currentBet`).
  - PLO: `potTo = currentBet + (potTotal + (currentBet - bet))` where `potTotal` = all chips committed this hand
    by everyone (including current street bets). Legal `to` ∈ [`minTo`, `min(potTo, maxTo)`], all-in-for-less rule as above.
  - A raise whose increment (`to - currentBet`) ≥ `minRaise` is a FULL raise: `minRaise = to - currentBet`,
    every other non-folded non-all-in player gets `acted = false`.
    A short all-in raise does not change `minRaise` and does NOT reopen raising for players who already acted:
    they must act again (call/fold) but may not raise. Track with `acted`: players with `acted=true` facing a
    short all-in raise get `mayRaise=false` for the rest of the street (store per player `raiseLocked`).
    Exception (TDA rule, as implemented and tested): if the short raises made since a player last acted add
    up to a full raise (`currentBet − what they had matched ≥ minRaise`), raising is open to them again.
  - `raise` illegal if no other player can still act (everyone else all-in/folded) — then only call/fold/check.
- Every voluntary action: `timeouts = 0`, `acted = true`, `lastAction = {type, amount}` where type is
  `'fold'|'check'|'call'|'bet'|'raise'|'allin'` (bet = raise when currentBet was 0; allin when stack reaches 0),
  append to `log`.
- Street ends when every non-folded, non-all-in player has `acted` and `bet == currentBet` (or ≤1 such player
  remains and they have matched). Then: move bets into committed (bets already counted in committed), reset
  `bet=0, acted=false, raiseLocked=false, currentBet=0, minRaise=bb`, deal next street, set `toAct`.
- Everyone but one folds → hand ends immediately (`endedBy:'fold'`), winner gets the pot (uncalled bet returned
  is just part of the pot math — the winner gets everything). Nobody's cards are shown.
- Betting closed with board < 5 and ≥ 2 players still in (all-in situations: at most one non-all-in player
  remaining and they have matched the highest commitment) → **all-in runout**:
  1. All non-folded hole cards become `shown` (mandatory).
  2. If `settings.maxRuns > 1`: `phase = 'ritVote'`, `ritVoters` = non-folded pids, `deadline = now + 12000`,
     kind `'ritVote'`, compute `equity` for current board (run index 0). Votes via `{type:'vote', runs:1..maxRuns}`.
     When every voter has voted or the deadline passes: if all votes present and identical → `runs = vote`, else `runs = 1`.
     Else (maxRuns = 1) `runs = 1` directly.
  3. `phase = 'runout'`: `runBoards = [board.slice()]` per run as they start; each runout STEP deals ONE street
     (flop = 3 cards, turn 1, river 1) to the current run; after each step recompute `equity` for that run
     (dead cards = all cards on other runs' boards); `deadline = now + 1800`, kind `'runout'`.
     When a run's board reaches 5 cards, record `runResults[r]` (best hand among non-folded), then start the next
     run from a copy of the shared board (cards continue from the deck), until all runs done → showdown settlement.
- River betting completes with ≥ 2 players → showdown settlement (runs = 1, `runBoards = [board]`).

### 6.3 Settlement (showdown and fold endings)

- Build pots from `committed` of ALL dealt players (folded players' chips are dead money in the pots they reached):
  sort distinct commitment levels of non-folded players; each layer's amount = Σ over all players of
  `min(committed, level) - min(committed, prevLevel)`; eligible = non-folded players with committed ≥ level.
  Chips committed by folded players above the top non-folded level go to the top pot. A pot with exactly one
  eligible player (always the top one) goes to that player: the part of their own bet in that layer that nobody
  else matched is an uncalled bet RETURNED (`pot.uncalled`, log `gets back an uncalled bet`); the rest — chips
  folded players put into that layer — is WON (log `wins the side pot`, the player is in `results.winners`;
  no mandatory show, nobody contested it). `pot.returned` is true only when the whole pot was returned.
- Each pot is split into `runs` equal parts (`floor(amount / runs)`; remainder to run 0). For each run, winners =
  eligible players with the highest score on that run's board; the run-part is split equally; odd chips go to the
  winner(s) closest clockwise to the LEFT of the button, one chip at a time.
- `awards[pid]` = total chips received; `stack += awards`. `won` on each `ps`.
- `handName` (on `ps` and `runResults`) from the evaluator for players whose cards are visible at the end.
- Showdown reveal rules (mandatory, sets `shown`): every winner of any run; the `lastAggressor` if still in the hand
  (else the first non-folded player clockwise from the button); if `settings.showdownLosers === 'show'`, every
  non-folded player. All-in runouts already revealed everyone.
- After settlement: `phase = 'complete'`, `completedAt = now`, `toAct = null`, `results` filled,
  `deadline = now + nextHandDelay*1000` (+ 1500 per extra run), kind `'nextHand'`.
- When the `nextHand` deadline fires: finish the hand →
  1. apply `pendingChips` → stack, `pendingAdjust` (in order; `set` uses the stack at that moment; never below 0),
  2. process `leaveAfterHand` (ledger `cashout` of stack, seat=null, stack=0) and `awayAfterHand` (away=true, awayBy='self'),
  3. `lastHand = { no, log, results, boards }`, `hand = null`,
  4. if `pauseAfterHand`: `paused = true`, `pauseAfterHand=false`,
  5. try to start the next hand (§6.1).
- Chip conservation invariant (test it!): Σ stacks + Σ committed in current hand + Σ pendingChips
  == Σ ledger buy-ins (incl. counted adjustments) + Σ uncounted adjustments − Σ cashouts.

### 6.4 Timeouts and away

- `action` deadline fires for `toAct`: auto `check` if legal else `fold`; `timeouts += 1`; if
  `autoAwayTimeouts > 0 && timeouts >= autoAwayTimeouts` → `away = true, awayBy = 'timeout'` (takes effect: they
  are not dealt next hand; in the current hand they will be auto-acted instantly).
- Away players who are still in the current hand are auto-acted IMMEDIATELY when action reaches them
  (check if legal else fold), no timer. All-in players are skipped.
- `{type:'away', on:true, afterHand?:bool}`: `afterHand` → `awayAfterHand = true` (cleared by `on:false`);
  else `away = true, awayBy = 'self'`.
- `{type:'away', on:false, waitForBB?:bool}`: `away=false, awayBy=null, timeouts=0, waitForBB=!!waitForBB, awayAfterHand=false`.
- Away has NO time limit. Only the host removes an away player (`remove`).
- Host `{type:'setAway', pid, on}`: on → `away=true, awayBy='host'`; off → `away=false, awayBy=null, timeouts=0`.

### 6.5 Seats, buy-ins, leaving

- `{type:'sit', seat, amount}` (unseated player): seat must be free and not reserved by another pending request;
  `minBuyIn ≤ amount ≤ maxBuyIn`; one pending request per player. Creates request kind `'sit'`.
- `{type:'buyin', amount}` (seated player): `1 ≤ amount`, `stack + pendingChips + amount ≤ maxBuyIn` unless
  `stack + pendingChips == 0` (busted: then `minBuyIn ≤ amount ≤ maxBuyIn`). Creates request kind `'rebuy'`.
- A request is auto-approved immediately when `!settings.approveBuyIns` or the requester is the host.
- `{type:'cancelRequest', id}` by its owner. Host `{type:'approve', id, amount?}` (amount override any integer ≥ 1) /
  `{type:'deny', id}`.
- Approve: ledger `buyin` entry; `sit` → take the seat (if it got taken, take the lowest free seat; if none,
  throw conflict), stack = amount, away=false. `rebuy` → if the player was dealt into the current hand
  (`hand && hand.ps[pid]`) → `pendingChips += amount`, else `stack += amount`. Then maybe schedule next hand.
- `{type:'leave', afterHand?:bool}`: if dealt into a running hand and not folded: `afterHand` true or player
  is all-in → `leaveAfterHand = true`; otherwise (now) fold them first if it's legal at any time (folding out of
  turn is allowed for leaving: mark folded, then re-evaluate street end/turn), then cash out. Not in a hand → cash out now:
  ledger `cashout` (amount = stack + pendingChips), seat = null, stack = 0, pendingChips = 0, away=false,
  cancel their pending requests. `{type:'cancelLeave'}` clears `leaveAfterHand`.
- Host `{type:'remove', pid}`: for a seated player, same as leave-now for that player (deferred to hand end if they
  are all-in / betting has closed; `leaveBy = host`, so their own `cancelLeave` is refused). For a joined player
  WITHOUT a seat (spectator, pending seat request): remove them from the game — drop their requests, then delete
  the player, or (if the ledger / hand / last hand / payments mention them) keep a `kicked` tombstone with
  `tokenHash = null`. Their token stops working; the slot and the name are free. The host can't remove themselves.

### 6.6 Host tools

- Only `hostId` may call: `approve`, `deny`, `adjust`, `setAway`, `remove`, `settings`, `pause`, `markPaid`, `endGame`, `transferHost`.
- `{type:'adjust', pid, mode:'add'|'remove'|'set', amount, reason, countAsBuyIn}`: amount integer ≥ 0
  (`set` may be 0), reason ≤ 40 chars. If the player is dealt into the running hand → push to `pendingAdjust`;
  else apply now: delta = add: +amount, remove: −min(amount, stack), set: amount − stack. Ledger entry
  type `'adjust'`, `amount = delta` (signed), `countAsBuyIn`, `reason`, `by = hostId`. Player must be seated
  (or have a seat) — unseated players can't be adjusted.
- `{type:'settings', patch}`: `sanitizeSettings(patch, current)`. `seats` cannot drop below (highest occupied seat + 1).
  `variant`, blinds, etc. take effect from the next hand (hand keeps its snapshot).
- `{type:'pause', on}`: on → if a hand is running `pauseAfterHand = true` else `paused = true`; off → both false,
  maybe schedule next hand.
- `{type:'markPaid', key, paid}`: `paid` true with an outstanding settlement key (`from>to:amount`) RECORDS the
  payment in `state.payments` (conflict if the key isn't on the current list); `paid` false with a recorded key
  (`from>to:amount#id`) removes it (a legacy `state.paid` key is deleted). `{type:'transferHost', pid}` (pid must
  be a joined player).
- `{type:'endGame'}`: if a hand is running → finish it immediately is NOT allowed; instead set `pauseAfterHand`
  and `endAfterHand` (`state.endAfterHand = true`); at hand end (or immediately if no hand) cash out every
  seated player (ledger cashouts), `ended = true`, `paused = true`. Ended rooms reject all actions except `chat`
  and `markPaid`.

### 6.7 Showing cards and revealing the runout

- `{type:'show', cards:[indices]}` — allowed only when `hand.phase === 'complete'` and the player was dealt in.
  Sets `shown[i] = true` for listed indices (any player: winner, loser, folded preflop — anyone). Idempotent.
  Log `'shows'` with the cards.
- `{type:'revealRunout'}` — allowed when `hand.phase === 'complete'`, `results.endedBy === 'fold'`, board < 5,
  `runout == null`, and permission: `'anyone'` → any joined player; `'winner'` → the winner; `'host'` → host;
  `'off'` → nobody. Sets `runout = { cards: deck.slice(0, 5 - board.length), by: pid }` (exactly the cards that
  would have been dealt next). Log it.

### 6.8 Chat

`{type:'chat', text}` — any joined player (including spectators). Trim, 1..280 chars. Keep last 60.
Rate limited per player and per room (§9).

## 7. Ledger (`lib/ledger.js`)

`summarize(state) → { entries, players, totals, settlement }`:
- per player (everyone who ever appears in the ledger or is seated):
  `buyIns` = Σ buyin + Σ adjust where countAsBuyIn; `buyInCount` = number of buyin entries (+ counted positive adjusts);
  `cashOuts` = Σ cashout; `stack` = current stack + chips committed in the running hand + pendingChips (0 if unseated);
  `net = cashOuts + stack − buyIns`.
- totals: `{ buyIns, chipsOnTable (Σ stack as above), cashedOut, uncountedAdjust (Σ adjust where !countAsBuyIn), balanced, diff }`
  where `diff = chipsOnTable + cashedOut − buyIns` and `balanced = diff === uncountedAdjust`... i.e. report `diff`
  and `balanced = (diff === 0)`.
- settlement: first every recorded payment (`state.payments`, `paid: true`, key `from>to:amount#id`), then what is
  still owed AFTER those payments (net + paid out − received) as minimal-ish payments — repeatedly match the
  largest debtor with the largest creditor: `[{ key: from+'>'+to+':'+amount, from, fromName, to, toName, amount,
  paid: !!state.paid[key] }]`. A tick therefore survives later hands and is never routed again.
  Players with nothing left to settle excluded. If Σ net ≠ 0 (unbalanced), settle what can be settled and stop.
- entries returned newest-first, last 200.

## 8. Action list (POST /api/act body `{ code, type, ...args }`)

| type | who | args |
|---|---|---|
| `tick` | anyone (even anonymous) | — |
| `sit` | joined, unseated | `seat, amount` |
| `buyin` | seated | `amount` |
| `cancelRequest` | request owner | `id` |
| `act` | `toAct` | `move: 'fold'|'check'|'call'|'raise', to?` |
| `vote` | ritVoter | `runs: 1..maxRuns` |
| `show` | dealt-in player, hand complete | `cards: number[]` |
| `revealRunout` | per setting | — |
| `away` | seated | `on: bool, afterHand?: bool, waitForBB?: bool` |
| `leave` | seated | `afterHand?: bool` |
| `cancelLeave` | seated | — |
| `chat` | joined | `text` |
| `approve` / `deny` | host | `id, amount?` |
| `adjust` | host | `pid, mode, amount, reason, countAsBuyIn` |
| `setAway` | host | `pid, on` |
| `remove` | host | `pid` (seated: stand up; unseated: remove from the game) |
| `settings` | host | `patch` |
| `pause` | host | `on` |
| `markPaid` | host | `key, paid` |
| `transferHost` | host | `pid` |
| `endGame` | host | — |

## 9. HTTP API

All JSON. Auth: header `x-felt-token: <token>` (secret returned at create/join; client stores it in
`localStorage['felt:' + code] = JSON.stringify({ pid, token })`). Errors: `{ error: 'Human message', code }`
with status 400 (bad_request), 403 (forbidden), 404 (not_found), 409 (conflict / not_your_turn),
429 (rate_limited).

Rate limits (`lib/ratelimit.js`, buckets in `state.rate`): the actions `chat, away, leave, cancelLeave, sit, buyin,
cancelRequest, show, revealRunout` cost one token from the player's bucket (burst 10, +1 per 1.5 s) and the room's
bucket (burst 30, +1 per 0.4 s) when they change the room; new joins cost a room token. An empty bucket → 429
`{ code: 'rate_limited' }`. Game moves (`act`, `vote`), `tick` and host tools are not limited.

Names (player and game): control / format / invisible characters (zero-width joiners, bidi, word joiner, soft
hyphen, Hangul fillers, braille blank, variation selectors) are stripped, whitespace collapsed; something visible
must remain. Player names can't be "You" (the UI's label for the viewer). Join compares names by
`NFKC + lower case`, so lookalikes of a taken name are refused.

- `POST /api/create` `{ hostName, gameName, settings }` → `{ code, pid, token, view }`
- `POST /api/join` `{ code, name }` → `{ pid, token, view }` (if the header token is valid for this room,
  returns that existing player instead of creating a new one). Max 30 players per room (players the host removed
  from the game don't count).
- `GET /api/state?code=XXX` (token optional) → `{ view }`. Also runs `tick` (and saves+publishes if it changed).
- `POST /api/act` `{ code, type, ... }` → `{ view }`
- `GET /api/events-token?code=XXX` → `events.grant(['room:' + code])` result (404 if room missing).

`lib/store.js`:
```js
export async function loadRoom(code)                      // → { state, version } | null
export async function insertRoom(state)                   // INSERT (retry new code on PK conflict handled by caller)
export async function mutateRoom(code, fn)                 // load → fn(state) → UPDATE ... WHERE version = $v; retry ≤ 6 on conflict;
                                                           //   returns { state, version, changed }; publishes 'update' {v} if changed
export async function sha256Hex(text)
export function newToken()                                // 32 random bytes base64url
export function newPid()                                  // 12-char base64url
export async function resolvePlayer(state, req)            // → pid | null from x-felt-token
export function sendError(res, err)                        // EngineError → status map; other → 500
```
SQL used (exact, the dev fake matches these by regex):
- `SELECT state, version FROM rooms WHERE code = $1`
- `INSERT INTO rooms (code, state, version) VALUES ($1, $2::jsonb, 1)`
- `UPDATE rooms SET state = $2::jsonb, version = version + 1, updated_at = now() WHERE code = $1 AND version = $3`
  (success iff rowCount === 1)

`migrations/001_rooms.sql`:
`CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, state JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`

## 10. View (`lib/view.js`): `viewFor(state, pid|null, version, now) → View`

Never include: `tokenHash`, `deck`, any hole card not visible to this viewer, other players' pending requests (unless host).

```js
View = {
  code, name, version, serverNow: now,
  hostId, isHost: bool,
  settings,
  paused, pauseAfterHand, ended, endAfterHand,
  handNo, button,
  deadline, deadlineKind,                       // for the client tick timer + countdowns
  me: null | {
    id, name, seat, stack, pendingChips, away, awayBy, waitForBB, awayAfterHand, leaveAfterHand, timeouts,
    removedByHost,                              // leaveAfterHand was set by the host (no "Stay seated")
    status: 'spectator'|'seated', inHand: bool, busted: bool,
    hole: string[] | null,                      // my cards in the current hand (also after I fold)
    handName: string | null,                    // my best hand with the current board (board ≥ 3), else null
    request: null | Request,                    // my pending request
  },
  players: [ PublicPlayer ],                    // every joined player (not ones the host removed from the game)
  seats: [ { seat, pid: pid|null, reservedBy: pid|null } ],   // length = settings.seats
  PublicPlayer = { id, name, seat, stack, pendingChips, status, away, awayBy, isHost, inHand, busted, leaveAfterHand },
  hand: null | {
    no, phase, street, variant, sb, bb, button, sbSeat, bbSeat,
    board: string[],                            // shared board
    runs, currentRun, runBoards: string[][],    // empty until an all-in runout starts (then each run's board so far)
                                                // or a river showdown settles (then [board], per §6.2)
    runResults: [ { winners, handName } ],
    potTotal,                                   // Σ committed incl. current bets
    potCenter,                                  // Σ committed − Σ current-street bets (chips already in the middle)
    currentBet, minRaise, toAct,
    players: [ {                                // in seat order, dealt-in players only
      pid, seat, bet, committed, stack, folded, allIn, lastAction,
      cards: (string|null)[],                   // length 2/4; null = face down (not visible to this viewer)
      shown: boolean[],                         // which cards are public
      equity: int | null,                       // during ritVote/runout only
      won: int,                                 // complete only
      handName: string | null,                  // only when all of this player's cards are visible to this viewer and board ≥ 3
      isWinner: bool,
    } ],
    legal: null | { fold, check, call /*chips to call, 0 if none*/, raise /*bool*/, minTo, maxTo, potTo /*PLO cap or pot-size raise for NLH presets*/ },
    ritVote: null | { voters: pid[], votes: { [pid]: n|null /*others' votes visible*/ }, maxRuns, deadline },
    results: null | { endedBy, awards, runs: [ { board, winners, handName } ], pots: [ { amount, eligible } ] },
    runout: null | { cards, by },
    canShow: bool,                              // me: hand complete, I was dealt in, some of my cards not shown
    canRevealRunout: bool,
    log: [ { street, pid, name, text, amount } ],
  },
  lastHand: null | { no, log, results, boards },
  requests: [ Request ],                        // host: all; others: only their own
  Request = { id, pid, name, kind, amount, seat, createdAt },
  ledger: <lib/ledger.js summarize() output>,
  chat: [ { id, t, pid, name, text } ],
}
```

Additive fields the UI relies on (all derived from public information, never secret):
`hand.players[].name`; `hand.results.runs[].{amount, awards}`, `hand.results.pots[].{winnersByRun, returned}`,
`hand.results.winners`; `hand.runout.name` and `lastHand.runout` (who revealed it); `lastHand.players[]`
(`{ pid, name, seat, cards /*only cards that were shown*/, folded, won, handName }`); log entries may carry
`cards` (public cards only: board / shown / runout), `run` and `handName`. `ledger.entries[].byName`,
`ledger.players[].{seat, seated, adjustments}` and `ledger.totals.{buyInCount, players, hands, biggestWinner}`
come from `summarize()`; adjust entries also carry `mode` and `target` (the amount the host typed).

## 11. Frontend

Design tokens (from the approved canvas, `design/*.dc.html`):

```
--bg #262626        --panel #303030     --panel-border #3D3D3D   --btn #383838   --btn-border #4A4A4A
--input #1F1F1F     --line #3A3A3A      --text #ECE8DF           --muted #ABABAB --pill #3A3A3A --pill-border #4D4D4D
--brass #E6B85C     --brass-hi #F4D28E  --brass-ink #1A1408      --brass-tint #3A3528 --brass-tint-border #6A5A30
--danger-bg #3A2726 --danger-border #6E3A36 --danger-text #F2A096 --leave #E0705F
--pos #8FE0AF       --pos-bar #5BC98A   --neg-bar #E0705F
--felt-hi #3DAA6E   --felt-lo #1F8549   --rail #1C1C1C
--card #F6F2E9      --card-back #D9534F (stripes rgba(255,255,255,.22) 45deg 3px/7px, 2px #F6F2E9 border)
suits (4-color): ♠ #17191B  ♥ #C42B38  ♦ #1E5BC6  ♣ #1B7F45   (2-color: ♥♦ #C42B38, ♠♣ #17191B)
ghost card (runout reveal): background rgba(246,242,233,.16), 2px dashed rgba(230,184,92,.85); ghost suit colors ♠ #ECE8DF ♥ #FF9AA2 ♦ #9DBBFF ♣ #8FE0AF
fonts: 'Bricolage Grotesque' (UI), 'JetBrains Mono' (numbers, tabular-nums) — Google Fonts link in index.html
avatar hues: #E9B872 #E8A3A3 #C9A7E0 #8FD0CF #F2D9A0 #9CC5A1 #A7B8E8 #D9C79A #B5D69A (by seat or pid hash), initials dark #14110C
radii: panels 18px, buttons 12px, pills 999px, cards 9px
```

Screens (one SPA, `public/index.html`):
- `/` (no `?room=`) → **Lobby**: create game (your name, game name, variant, SB/BB, seats, min/max buy-in,
  approve buy-ins, run it more than once (max runs 1/2/3), reveal runout who, losing hands at showdown) and
  join by code. Mobile layout per `design/LobbyMobile.dc.html`.
- `/?room=CODE` → **Table**. If no stored token for CODE → join prompt (name) over a spectator view of the table.
  - Desktop ≥ 900px wide: header (logo "Felt", game name, variant · blinds · hand #, room code pill + copy invite link,
    Ledger, Host tools (host only, badge = pending requests), 4-color toggle), landscape oval table, action bar under the
    table, right side panel (tabs Hand / Chat / Players + "your session": bought in, net, at-showdown pref, Request a
    buy-in, Away, Leave seat).
  - Mobile < 900px: compact header, portrait oval, bottom sheet action bar; Ledger/Host/Chat/Log via a menu → full-screen sheets.
    As in design/Mobile.dc.html, other seats show their street amount in their tag (`Bet 60`, `BB · 2`) instead
    of chips on the felt (only my own bet is drawn as a chip); short phones (height ≤ 740px) use a compact
    table, and a phone on its side scrolls with the action bar pinned.
  - Seats: empty seats show "Sit" (opens buy-in dialog with seat). Seat pods show avatar initials, name, stack,
    status tags (Folded, Check, Bet 60, Call 60, All-in, Away, Sitting out/Busted, SB/BB, "Rebuy pending", "Leaving"),
    D button chip, face-down card backs for players in the hand, face-up (flip animation, slightly larger) when shown,
    the acting player's ring + countdown, win% under all-in players (number only, no hand descriptions),
    winner gold ring + "+amount" tag, run labels.
  - Center: pot, board — or stacked boards when running it N times (each labelled with its winner when done),
    cards that make the winning hand lifted/others dimmed at complete; ghost "would have come" cards after a
    revealed runout (dashed outline, translucent), "Revealed by NAME".
  - Bottom bar states: your turn (Fold / Check|Call N / Raise slider + presets Min, ½ pot, ¾ pot, Pot, All-in;
    PLO caps at pot), waiting (pre-action toggles — see Keyboard shortcuts below), run-it vote (Once/Twice/3× + others' votes + countdown),
    hand complete (Show your hand: per-card toggle + Show both / Keep hidden; Reveal runout button when allowed;
    next hand countdown — also for AWAY players who were dealt in, with a "You're away · I'm back" notice on top),
    away banner ("You're away" + I'm back + wait for big blind checkbox + Leave seat),
    spectator (pick a seat; + Reveal runout when `canRevealRunout`, e.g. a host running the game without a seat),
    busted (Request a buy-in). A leave the host set (`me.removedByHost`) shows "The host removed you" and never a
    "Stay seated" button (bar, session box, leave dialog).
  - "At showdown, when I lose" (session box select, per browser `localStorage['felt:showdownPref']`): Ask me each
    time (prompt) / Always muck (no prompt) / Always show (sends `show` for my unshown cards once) — applies when a
    showdown I was in (not folded) completes and I didn't win.
  - Host tools (panel / sheet): requests (approve/edit amount/deny, auto-approve toggle = settings.approveBuyIns
    inverse), players table (status, bought in, stack, net, Adjust chips, Set away/Bring back, Remove; spectators:
    Remove from the game), adjust-chips
    form (Add/Remove/Set to, amount, before→after preview, reason chips: Cash rebuy, Miscount fix, Move from player,
    Bounty, + "Count as a buy-in on the ledger", note when hand in progress), table rules editor, pause after hand,
    copy invite link, end game, transfer host.
  - Ledger (panel / sheet): tiles (Total bought in, Chips on table + Balanced/Off by N, Biggest winner, hands played),
    players table with net bars, settle-up list (host can tick paid), activity feed, Export CSV, Copy summary.
    CSV text cells starting with `= + - @`, tab or CR get a leading `'` (no spreadsheet formulas from names /
    reasons); `public/js/csv.js` holds the export (no React, unit-tested).
  - Dialogs: buy-in (amount within range, slider + presets min/max), leave seat (cash out summary + After this hand /
    Right now), confirm end game.
- Keyboard shortcuts (`public/js/hotkeys.js` holds the pure decisions — no imports, unit-tested in node with real
  `viewFor()` views; `actionbar.js` owns the one document `keydown` listener). Keys read `e.key` lower-cased (Shift
  doesn't matter); digits also come from `e.code` (`Digit1` / `Numpad1`). Every shortcut is ignored while typing in an
  input / textarea / select / contenteditable, while any modal or sheet is open (`<html class="modal-open">`), with
  Ctrl / Meta / Alt held, and on key repeat.
  - My turn (`hand.phase 'betting'`, `hand.toAct === me.id`, `hand.legal`): `f` fold · `c` call (check when there is
    nothing to call) · `k` check — only when `legal.check`, otherwise nothing is sent and a toast says
    "Can’t check — 60 to call" · `r` focus + select the raise amount (typing a number and Enter raises; with only an
    all-in raise left it focuses the raise button; no raise possible → a toast) · `a` / `g` call (check if free) ·
    `i` check if free, else fold. `f c k r` do nothing when it isn't my turn (no pre-fold).
  - Pre-actions, before my turn (I'm dealt in, not folded, not all-in, not away, phase `betting`, someone else to act):
    `i` **Check/Fold** (check if free, else fold — survives raises) · `a` **Call any** (check if free, else call any
    amount incl. all-in — survives raises) · `g` **Call current** (remembers `hand.currentBet` when picked; calls —
    or checks when there's nothing to call — if it is unchanged; as soon as it changes the pick is cancelled with a
    toast "The bet changed — choose again"). One at a time: the same key again turns it off, another key switches.
    The waiting bar shows them as toggle buttons on desktop and phone ("Check/Fold", "Call any", "Call 60" / "Check" —
    the label follows the current amount to call), the picked one brass with `aria-pressed`. A pick belongs to one
    betting round (hand no + street) and is dropped when the street or hand changes, I fold, go all-in, go away, or the
    hand completes. It fires exactly once (each pick has an id; repeated renders, realtime refetches and a request still
    in flight can't send it twice), immediately when the view shows it is my turn; refused by the server → dropped
    (the API error toast explains).
  - After the hand (`hand.phase 'complete'` and `hand.canShow`): `s` shows all my not-yet-shown cards, `1` / `2` my
    first / second card (PLO `1`–`4`) — only cards not shown yet, otherwise nothing.
  - `?` (Shift+/) opens the "Keyboard shortcuts" cheat sheet (a Modal listing every key, `HOTKEYS` in hotkeys.js); the
    desktop header has a keyboard icon button that opens it too.
  - Desktop shows tiny keycap hints (`<kbd class="kc">`, JetBrains Mono, muted, small rounded box, `aria-hidden` so the
    button names stay "Fold" / "Call 60") on Fold F, Call C / Check K, Raise R, Check/Fold I, Call any A, Call current G,
    Show both S (+ "or press 1 2" in the show prompt). No keycaps on the phone (nor on any coarse pointer).
- Toasts for errors from the API (`error` message).
- Sounds: none. Animations: card flip on reveal (0.55s rotateY), chips slide optional, acting ring pulse.
- Accessibility: real buttons, aria-labels on icon buttons, focus-visible rings, 44px touch targets.

## 12. Frontend module contract (`public/js/`, ES modules, React via globals)

```
public/index.html      loads: Google Fonts, css/base.css, css/table.css, css/panels.css, css/lobby.css,
                       vendor/react.js, vendor/react-dom.js, vendor/htm.js (classic, in order),
                       /__hatchable/events.js (classic), then <script type="module" src="/js/main.js">.
                       <div id="root">. <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
js/h.js                export const html = htm.bind(React.createElement);
                       export const { useState, useEffect, useRef, useMemo, useCallback, useContext, createContext, Fragment } = React;
js/api.js              export class ApiError extends Error { code; status }
                       export function getSession(code) → {pid, token}|null ; setSession(code, s) ; clearSession(code)
                       export async function apiCreate({hostName, gameName, settings}) → {code,pid,token,view}  (stores session)
                       export async function apiJoin(code, name) → {pid,token,view}                         (stores session)
                       export async function apiState(code) → {view}
                       export async function apiAct(code, type, args={}) → {view}
js/room.js             export const RoomContext = createContext(null)
                       export function useRoomData(code) → { view, error, loading, act, refresh, joined, join(name) }
                         - fetches state, subscribes realtime (hatchable.events), refetch on update with v > version,
                           arms ONE deadline timer → act('tick') (ignore errors), toasts API errors, keeps the latest view.
                         - act(type, args) → Promise<view|null>; sets view from response; on ApiError shows toast & resolves null.
                       export function useRoom() → useContext(RoomContext)   // { view, act, ... } inside the room page
                       export function useClock(view) → now (ms, corrected by serverNow offset; re-renders every 250ms ONLY
                         while a deadline is in the future)
js/ui.js               export function cx(...classes) → string
                       export function fmt(n) → '1,234'
                       export function Button({ kind:'default'|'primary'|'danger'|'ghost', size:'sm'|'md'|'lg', ...props, children })
                       export function Pill({ tone:'default'|'brass'|'gold'|'pos'|'danger', children })
                       export function Avatar({ name, seed, size=38 })      // initials on hue from SPEC palette, hue = hash(seed)
                       export function Card({ card, size:'xs'|'sm'|'md'|'lg'|'xl', dim, lift, ghost, flip, faceDown })
                         // face: rank (T→10) top-left, big suit bottom-right, colors per four-color pref; faceDown → striped back
                       export function useFourColor() → [bool, setBool]    // persisted localStorage 'felt:fourColor', default true
                       export function Modal({ open, onClose, title, children, wide })   // centered dialog ≥900px, bottom sheet <900px
                       export function Sheet = Modal (alias)
                       export function useIsMobile() → bool                // matchMedia('(max-width: 899px)')
                       export function toast(message, tone='danger')       // global toast queue
                       export function Toasts()                             // render once in main
                       export function Countdown({ deadline, now }) → '14s' text
                       export function Icon({ name, size=18 })              // inline stroke SVGs: spade(logo), ledger, crown, gear,
                                                                            // clock, leave, close, copy, menu, back, eye, check, chat, users, history,
                                                                            // keyboard (cheat-sheet button)
js/lobby.js            export function Lobby()                              // create + join; navigates to /?room=CODE
js/dialogs.js          export function BuyInDialog({ open, onClose, seat|null })   // sit or rebuy (decides by me.seat)
                       export function LeaveDialog({ open, onClose })
                       export function JoinPrompt()                         // name entry for a visitor with no session
                       export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onClose })
                       export function ShortcutsDialog({ open, onClose })   // the keyboard cheat sheet (§11)
js/table.js            export function Table()                              // oval, seats, center (pot/boards/runout), dealer btn,
                                                                            // bet chips, hero cards; desktop landscape / mobile portrait
js/actionbar.js        export function ActionBar()                          // every bottom-bar state from §11 + the keyboard
                                                                            // shortcuts listener and the pre-action state
js/hotkeys.js          (pure, no imports) decideTurnKey(key, view) → {move}|{focus:'raise'}|{toast}|null,
                       togglePreAction(pre, kind, view), decidePreAction(pre, view) → {fire:{move}}|{cancel:reason}|null,
                       showKey(key, view) → number[]|null, canPreAct, preLabel, normKey, ignoreKeyEvent, HOTKEYS
js/side.js             export function SidePanel()                          // tabs Hand log / Chat / Players + session box
                       export function HandLog(), Chat(), PlayersList(), SessionBox()   // reused in mobile sheets
js/host.js             export function HostTools()                          // full host panel content
js/ledger.js           export function Ledger()                             // full ledger content
js/csv.js              export function csvCell(v), ledgerCsv(view, now?)    // CSV export (pure)
js/main.js             App: router (lobby vs room), RoomPage layout (desktop grid: header / table+actionbar / side panel;
                       mobile: header + table + action sheet + menu sheets), mounts Toasts, dialogs state.
                       Header buttons open Ledger / Host tools in a Modal(wide) on desktop, full sheets on mobile.
                       Adds openShortcuts() to RoomContext (the cheat sheet; desktop header keyboard button, "?" key).
css/base.css           tokens (§11) as CSS vars, reset, body bg, buttons, pills, panels, inputs, switches, cards, modal/sheet, toasts
css/table.css          table, seats, boards, chips, action bar, keycaps / pre-actions / cheat sheet
css/panels.css         side panel, host tools, ledger, dialogs content
css/lobby.css          lobby
```

Shared class names (base.css owns them): `.btn .btn-primary .btn-danger .btn-ghost .btn-sm .btn-lg`, `.pill .pill-brass .pill-gold .pill-pos .pill-danger`,
`.panel`, `.muted`, `.mono`, `.label` (uppercase small), `.field` (input/select), `.switch` (checkbox toggle), `.seg` (segmented control:
`<div class="seg"><button class="on">`), `.card .card-xs/.card-sm/.card-md/.card-lg/.card-xl .card-back .card-ghost .card-dim .card-lift .card-flip`,
`.avatar`, `.modal-backdrop .modal .sheet`, `.toast`.
