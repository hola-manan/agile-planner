# Plan: table transitions (deal, bets, pot, stacks, turn, action bar)

## Goal
Right now the table snaps instantly between states: cards appear with no motion, bets pop in fast (0.25s),
the pot and stacks change number with no feedback, the acting-player highlight jumps, and the action bar
swaps content abruptly. Add smooth, tasteful transitions so the game reads like a dealer is dealing.
**Client-side only.** Do NOT change server/engine pacing (`lib/`, `api/`, `server/`), game logic, state
shape, or hotkeys. Applies to desktop and phone.

## Feel / timing guidelines
- Motion should be noticeable but never slow play down: individual animations 0.25s–0.5s, staggers
  ~120–150ms per card, easing `cubic-bezier(0.2, 0.7, 0.3, 1)` (the existing card-flip curve) unless noted.
- Animations must never block input: no `pointer-events` tricks, no JS timers delaying state, no awaiting
  animations before rendering. Pure CSS animations/transitions triggered by mount (React keys) or class/
  style changes.
- Use `animation-fill-mode: backwards` (or `both`) for delayed mount animations so a card is hidden during
  its stagger delay instead of flashing in first.
- Animate only `transform` and `opacity` (and `box-shadow`/`border-color`/`background-color` for
  highlights). Do not animate layout properties (width/height/top/left). Keyframes must use `transform`
  (not the individual `rotate`/`translate` properties), because hero cards set inline `rotate` and
  `.card-lift` uses `translate` — those compose with `transform` and must keep working.

## Changes

### 1. Board (community) cards deal in — `public/js/table.js` (~L480–490) + CSS
- Board cards render as `<Card key={'c'+i} …>` (dealt), `'g'+i` (ghost, already `flip`), `'s'+i` (empty
  slot). When a street is dealt the slot element is replaced by a new `'c'+i` element, so a mount animation
  fires exactly once per newly dealt card. Add a `card-deal` class to dealt board cards (`'c'+i` only;
  NOT ghosts, NOT empty slots).
- Stagger the flop: for i < 3 set an inline `animationDelay` of `i * 140ms` (via the `style` prop, or a
  CSS custom property `--deal-delay` consumed by `.card-deal`). Turn (i=3) and river (i=4) get 0 delay.
  (Delays on already-mounted cards are harmless — keyed elements don't re-run mount animations.)
- New keyframes `card-deal` (put next to `card-flip` in `public/css/base.css`): from
  `opacity: 0; transform: translateY(-18px) scale(0.85) rotate(-4deg)` to
  `opacity: 1; transform: none`, ~0.45s, the card-flip easing, fill `backwards`.
- Multi-run boards (run it twice/thrice, `.run` rows ~L545) reuse the same slot rendering — the same
  behavior should apply there automatically; make sure it does and looks fine.

### 2. Hole cards deal in — `public/js/table.js`
- Seat face-down backs (`<Card key={'b'+i} faceDown …>` ~L261) and the hero's own cards (~L430–442,
  wrapped in `.hero-card` with `key={i}`): add the `card-deal` class with stagger `i * 120ms`.
- **Re-key per hand** so each new hand re-triggers the animation even if the previous hand's cards were
  still mounted: key these by the hand number plus index, e.g. `key={hand.no + '-' + i}` (the view's
  `hand.no` exists — see `actionbar.js` usages). Only change the `key`, not what is rendered.
- Do NOT add `card-deal` to face-up showdown cards that already use `flip` (`'f'+i` ~L253–257) — they keep
  the existing flip reveal. Do not change the spread/rotation of the mini card backs (`spread` ~L244)
  beyond adding the class if it looks good; skip them if it looks noisy.

### 3. Bets — `public/css/table.css` `bet-in` (~L221, ~L239, ~L1004)
- Slow `bet-in` from 0.25s/0.3s to ~0.4s and make it a slightly more physical motion (fade + scale from
  ~0.6 + small translate), same easing. Keep the existing element/keys.

### 4. Pot bump on change — `public/js/table.js` + CSS
- Where the pot amount is rendered, wrap/key the amount on its value (e.g. `key={'pot-' + amount}`) so it
  remounts when the pot changes, with a `num-bump` animation: scale 1 → 1.12 → 1 plus a brief brass
  color/glow, ~0.4s. No bump on first render is fine either way.

### 5. Stack change feedback — `public/js/table.js` (seat stack number) + CSS
- Key the seat's stack number element on its value so it remounts on change, with the same `num-bump`
  animation. If you can cheaply tell an increase (winnings) from a decrease, use a gold glow for increases
  and a neutral bump for decreases; otherwise one neutral bump is fine. Apply to the hero's stack display
  in the action bar too (`.abar-me` in `public/js/actionbar.js`) if it's a simple key change.

### 6. Acting-player highlight transitions smoothly — CSS
- The seat that is currently acting gets a highlight (ring/border/glow — find the "acting"/turn classes in
  `public/css/table.css`). Add `transition` on the relevant properties (`box-shadow`, `border-color`,
  `background-color`, `opacity`, `transform`) ~0.3s so the highlight glides from player to player instead
  of jumping. Also give folded seats a short opacity transition if folded seats are dimmed.

### 7. Action tags + action bar state changes fade in — CSS (+ keys only if needed)
- Seat action tags (`Tag` elements keyed `act`, `fold`, `win`, `hn` … ~L306–415) should fade/slide in
  (~0.25s) when they appear. If a tag's text changes but its key stays the same (e.g. key `act` going from
  "Bet 60" to "Call 60"), it's acceptable to key it on its text so it re-animates.
- The ActionBar (`public/js/actionbar.js`, root ~L834 `.abar`) swaps between states (waiting/pre-action,
  your turn, run-it vote, buy-in prompt, …). Make the inner `.abar-body` fade + slide up ~6px over ~0.25s
  when the state changes — e.g. key the body on the state kind so it remounts, with an `abar-in` animation.
  Do not change any behavior, handlers, focus logic, or hotkeys.

### 8. Reduced motion
- Extend the existing `@media (prefers-reduced-motion: reduce)` blocks (`public/css/base.css` ~L1072,
  `public/css/table.css` ~L1949) so ALL new animations/transitions are disabled (or reduced to a plain
  short fade) for users who prefer reduced motion.

## Constraints
- Files: `public/css/base.css`, `public/css/table.css`, `public/js/table.js`, `public/js/actionbar.js`, and
  `public/js/ui.js` only if the `Card` component needs to forward a style/class it currently drops (check:
  `Card` already accepts `class`, `style`, `flip`).
- Markup changes limited to: adding classes, inline animation-delay/custom properties, and `key` changes.
  No logic, no new state, no timers, no new hooks unless strictly needed for a key.
- Keep the existing a11y (aria labels, roles) intact. No new npm packages. No destructured exports.
- Don't regress the desktop layout work from the previous change (bigger table, compact action bar).
- Do NOT git commit, push, or deploy. Do not touch anything outside this project directory; list any
  out-of-repo needs at the end of your response.

## Verification (do NOT commit)
- `node --test test/*.test.js` must pass.
- `node test/e2e.mjs` if it runs in this environment (it drives 3 browsers against a dev server it starts) —
  report the result; if it can't run here, say so.
- `npm run dev` and open the preview harness to eyeball states, e.g.
  `/__dev/preview.html?fixture=my-turn-preflop`, `my-turn-facing-bet`, `runout-2-boards`,
  `showdown-complete`, and `&w=mobile` variants. Confirm nothing is permanently invisible (fill-mode bugs)
  and cards still end up in their normal positions/rotations.
- Report every selector/keyframe added and every key/class change in JS.

## Fixes (round 2) — apply exactly, change nothing else
Review found these problems in round 1. Fix only these:

F1. **Opponents' hole cards don't animate (plan error).** During a hand, other seats render the `Backs`
    component (`public/js/table.js` ~L240–246, the mini face-down cards mapped from `spread` with
    `key={i}` and inline `style={{ rotate: r + 'deg' }}`), NOT `SeatCards`. Add the deal animation THERE:
    give each mini back `Card` `class` including `'card-deal'` (keep the existing `c-mback` class on mobile)
    and merge the stagger into its style: `style={{ rotate: r + 'deg', animationDelay: i * 120 + 'ms' }}`.
    `Backs` already unmounts between hands, so `key={i}` can stay.

F2. **Revert the `SeatCards` change.** `SeatCards` only renders at showdown when a player has revealed
    a card; animating its face-down cards makes them "re-deal" at showdown. Restore the face-down card
    exactly as before round 1: `key={'b' + i}`, class `mobile ? 'c-mseat' : 'c-seat'`, no `card-deal`, no
    style. Remove the now-unused `handNo` prop from `SeatCards` and from its call site in `Seat`.

F3. **Hero cards re-deal when the hand completes.** In `Hero`, when `canPick` becomes true at hand end
    the wrapper switches `<div>` ↔ `<button>` with the same key, React remounts it, and the `card-deal`
    animation replays. Only apply the deal animation while the hand is NOT complete: add `'card-deal'` to
    `klass` only when `!complete`, and only include `animationDelay` in the style when `!complete` (keep
    `rotate` always). Keep the per-hand keys (`handNo + '-' + i`).

F4. **`num-bump` overrides the element's own color.** In `public/css/table.css` `@keyframes num-bump`,
    remove `color` and `text-shadow` from the `0%` and `100%` keyframes (keep only `transform: scale(1)`
    there) so the element's own color (e.g. brass) is used at the ends; keep the `30%` keyframe as is
    (`scale(1.12)`, brass color, glow).

Then: `node --check` the changed JS files, run `node --test test/*.test.js`, and report the exact diff of
these four fixes. Do NOT commit/push/deploy.
