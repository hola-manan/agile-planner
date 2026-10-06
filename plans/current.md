# Plan: desktop — bigger center table + compact bottom action bar

## Goal (user-requested design change)
On the **desktop** room view (`.room-d`), make the center poker table **much bigger**, and make the
bottom panel (the ActionBar card) **compact** — a slim strip — while keeping ALL action controls and
every ActionBar state fully visible and usable. This is an intentional, user-approved deviation from the
`design/*.dc.html` mockups for this layout; implement the change as specified (do not treat the mockups as
blocking here). Reference screenshot: the waiting state ("<name> is thinking", timer, "You · <stack>",
and the "BEFORE YOUR TURN" pre-action row Check/Fold · Call any · Call <n>) sits in a tall rounded card
under the table — that card must become a slim strip and the table must grow into the reclaimed space.

## Current structure (for orientation)
- Desktop layout: `public/js/main.js` → `.room-main` (flex: `.room-play` | `.room-side`). `.room-play`
  is a column: `StatusBanner`, `Table`, then `.room-bottom` (grid: `ChatDock` | `.room-bottom-act` →
  `ActionBar`). Defined in `public/css/lobby.css` (`.room-main/.room-play/.room-bottom/...`, ~L610–659).
- Table size: `public/css/table.css` `.tbl-d .tbl-rail` (~L26): `aspect-ratio: 2.05/1;`
  `max-width: max(520px, calc((100vh - 470px) * 2.05));` — the `470px` is the height reserved for header +
  action bar. Table outer felt padding `.tbl-table` (~L17): `padding: 92px 104px 96px;`.
- ActionBar root: `public/js/actionbar.js` L834 renders `cx('abar', mobile ? 'abar-m' : 'abar-d panel', …)`
  — desktop bar is `.abar.abar-d.panel`. `.panel` chrome (bg/border/radius/padding) is in
  `public/css/base.css` (~L203). Inner spacing: `.abar-body { gap: 16px }` (table.css ~L1037),
  `.abar-top`, `.abar-icon {40px}`, `.presets`, `.abar-acts`, `.timer` (table.css ~L1052–1230).
- There are multiple `.abar-body` states (actionbar.js): your-turn (Fold/Call/Raise + raise slider),
  waiting/pre-action (the screenshot), buy-in/sit prompt, run-it vote, ended/result. All must keep working.

## Changes (CSS-only where possible; do NOT change game logic)
Edit only `public/css/table.css` and `public/css/lobby.css`. Touch `public/js/actionbar.js` ONLY if a
purely-visual markup tweak is unavoidable — and if so, change markup/classes only, never behavior, state,
or the hotkey wiring. Do NOT modify `lib/`, `api/`, engine, or any `.dc.html`.

1. **Enlarge the desktop table.** In `.tbl-d .tbl-rail`:
   - Reduce the reserved vertical space to reflect the now-compact bar: change the `470px` term to roughly
     **330–360px** (tune by testing — see verification).
   - Raise the minimum floor from `520px` to roughly **640px** so the table is clearly larger even on
     shorter windows.
   - Keep `aspect-ratio: 2.05/1` and `margin: 0 auto`. The table must stay fully visible (never clipped at
     top/bottom) and must not overlap the compact bar or the header at window heights 760 / 900 / 1080 px.
   - If the inner felt padding (`.tbl-table` `92px 104px 96px`) makes seats/cards feel cramped at the
     larger size, you may scale it up modestly so the table reads as genuinely bigger — optional, only if it
     looks better; do not break seat positioning.

2. **Compact the bottom ActionBar into a slim strip** (desktop `.abar-d` only; leave `.abar-m` mobile
   untouched):
   - Reduce the `.panel` padding for the bar by adding/here-overriding on `.abar-d` (e.g. a tighter
     `padding`), so the card is a slim horizontal strip rather than the tall card in the screenshot.
   - Reduce `.abar-body { gap: 16px }` to something tighter (e.g. ~8–10px) for the desktop bar.
   - Tighten the vertical rhythm of `.abar-top`, the timer row, `.presets`, and `.abar-sub`; shrink
     `.abar-icon` (40px) a little if it helps the strip read as slim. Prefer laying the waiting-state
     contents out horizontally on as few lines as possible.
   - **Do not crush the your-turn controls**: the Fold/Call/Raise buttons (`.abar-acts`) and the raise
     slider/number input must remain comfortably clickable (buttons keep a sensible min height ≈ 40px).
     The strip may be slightly taller in the your-turn state than in the waiting state — that's fine.
   - Keep all other states (buy-in/sit, run-it vote, ended/result) readable and un-clipped.

3. **Keep mobile unchanged.** Do not alter `.room-m*`, `.abar-m*`, `.room-m-dock`, or the mobile table
   sizing under `@media (max-width: 899px)`. Verify the mobile layout still looks identical.

## Verification (do NOT commit)
- Start the dev server and use the preview harness to eyeball both key states at desktop width:
  `npm run dev` then open `/__dev/table-preview.html` (and/or `/__dev/preview.html?fixture=<name>&w=desktop`)
  — there are table fixtures under `dev/fixtures-table`. Confirm with a real browser/screenshot if you can:
  (a) the table is visibly much larger than before, fully visible, not clipped;
  (b) the bottom bar is a slim strip in the waiting/pre-action state (matches the screenshot content but
      short), with the pre-action buttons and "You · <stack>" + timer still present;
  (c) the your-turn state still shows Fold/Call/Raise + the raise slider, all clickable.
- Check at window heights ~760px, ~900px, ~1080px that nothing is clipped or overlapping.
- `node --test test/*.test.js` must still pass (should be unaffected — CSS only).
- Report what you changed (selectors + before/after values) and the observed result.

## Constraints
- No new npm packages, no build step, plain CSS/ES modules. No destructured exports.
- Do NOT git commit, push, or deploy. Do NOT touch anything outside this project directory; if you find an
  out-of-repo need, list it at the end of your response.
