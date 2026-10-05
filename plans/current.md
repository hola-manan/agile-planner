# Plan: move chat to the bottom-left + `M` shortcut

## Goal (owner's words)
"chat doesnt show up on the right like this, it shows up on bottom left. with a m as a message shortcut key."
Reference look: PokerNow — chat box in the bottom-left corner under the table, action buttons bottom-right.

## Rules for this run
- Implement exactly this plan. Do not touch anything outside the project directory; if you discover an
  out-of-repo need, list it at the end of your response instead of doing it. Do not commit, push or deploy.
- No destructured exports anywhere (Hatchable's deploy parser rejects `export const { a } = x`).
- Reuse the existing `Chat` component (public/js/side.js) and existing `.chat*` styles — don't fork it.
- Keep every existing test passing; update tests that relied on the Chat tab (listed below).

## 1. Desktop (≥ 900px): chat dock bottom-left, action bar bottom-right

### public/js/main.js — RoomLayout desktop branch
Today `.room-play` renders `<Table/>` then `<ActionBar/>` stacked. Change the non-ended branch to:
```
<Table onSit=.../>
<div class="room-bottom">
  <${ChatDock} />
  <div class="room-bottom-act"><${ActionBar} onBuyIn=... onLeave=... onSit=... /></div>
</div>
```
- Import `ChatDock` from './side.js' (new export, below).
- The ended branch (EndedBanner + Ledger) is unchanged and shows no chat dock.
- Update the `<aside class="room-side" aria-label=…>` label to "Hand log, players and your session".
- `effectivePanel` logic: on desktop 'chat' is still mapped to null (no modal); keep it.

### public/js/side.js
1. Remove the `chat` entry from `TABS` (desktop side panel becomes tabs **Hand / Players** only), remove the
   unread-chat state/dot logic from `SidePanel`, and if `store.get('felt:sideTab')` returns 'chat' fall back
   to 'hand' (the existing `TABS.some(...)` check already does this — keep it).
2. `Chat` gets an optional `inputRef` prop (a React ref object). Pass it to the `<input>` as `ref=${inputRef}`.
   Also give the input `data-chat-input="1"`. Add an `onKeyDown` on the input: Escape → `e.currentTarget.blur()`
   (and `e.stopPropagation()` so a surrounding Modal doesn't also close when on desktop; on mobile inside the
   sheet let Escape behave as today, i.e. do NOT stop propagation when `inModal` prop is true — simplest:
   add prop `escBlurs` default false; ChatDock passes `escBlurs=${true}`).
   Change the placeholder to "Message the table (M)" only when a new optional prop `hint` is true (ChatDock
   passes it; desktop only).
3. New export `ChatDock()`:
   - Markup: `<section class="panel chat-dock" aria-label="Chat">` with a compact header row
     (`<div class="chat-dock-head">` → chat Icon + "Chat" title + muted count "N messages" on the right)
     and the existing `<Chat inputRef=${ref} escBlurs=${true} hint=${true} />` below.
   - It registers the focus function for the `M` key: `const room = useRoom();` and in an effect set
     `room.registerChatFocus && room.registerChatFocus(() => { ref.current && ref.current.focus(); })`,
     unregistering (passing null) on unmount.
   - Unread: none needed on desktop (the dock is always visible).
4. Keep `HandLog`, `PlayersList`, `SessionBox`, `Chat` exports unchanged otherwise (test/static.test.js checks
   `['SidePanel', 'HandLog', 'Chat', 'PlayersList', 'SessionBox']`; add `'ChatDock'` to that list).

### Layout CSS (public/css/lobby.css — room shell section, next to `.room-play`)
```
.room-bottom { display: grid; grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); gap: 18px; align-items: stretch; }
.room-bottom-act { min-width: 0; display: flex; flex-direction: column; }
.room-bottom-act > * { flex: 1; }          /* the action bar fills the right cell's height */
@media (max-width: 1099px) { .room-bottom { grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); } }
```
### Chat dock CSS (public/css/panels.css, in the chat section)
```
.chat-dock { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; height: 260px; min-height: 0; }
.chat-dock-head { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; }
.chat-dock-head .muted { margin-left: auto; font-weight: 500; font-size: 12px; }
.chat-dock .chat { gap: 8px; }
.chat-dock .chat-msg { padding-top: 6px; }
.chat-dock .chat-msg.is-cont { padding-top: 2px; }
.chat-dock .chat-text { font-size: 13px; padding: 5px 10px; }
.chat-dock .chat-form .field { height: 38px; }
.chat-dock .side-empty { padding: 8px 0; }   /* keep the empty state compact */
```
The dock must not make the page taller than today at 1440×1000: the table area above it keeps its size;
the action bar on the right keeps its existing look. Check with screenshots (section 5) and adjust the
dock height (between 220 and 280px) so nothing overflows.

## 2. Phone (< 900px): floating chat button bottom-left

There is no room for a second bottom panel, so:
- In the mobile branch of `RoomLayout` (main.js), add inside `.room-m-table`, after `<Table/>`:
  `<${ChatFab} onOpen=${() => openPanel('chat')} />` (new export from side.js), unless `view.ended`.
- `ChatFab({ onOpen })`: a round 44×44 button, `class="chat-fab"`, `aria-label="Chat"` (plus
  ", N unread" when unread), chat Icon, and a brass dot `<span class="chat-fab-dot">` when there are unread
  messages. Unread = messages from others with id greater than the last id seen while the chat sheet was
  open. Track "seen" in module-level state shared with the sheet: when the mobile chat sheet is open
  (`panel === 'chat'`), mark seen = last id. Simplest: ChatFab reads `useRoom()`; RoomLayout passes
  `chatOpen=${effectivePanel === 'chat'}` to ChatFab; ChatFab keeps `seen` in state and sets it to the last
  id whenever `chatOpen` is true (effect on [chatOpen, lastId]).
- CSS (panels.css): `.room-m-table { position: relative; }` (if not already) and
  `.chat-fab { position: absolute; left: 12px; bottom: 12px; z-index: 5; width: 44px; height: 44px; border-radius: 50%; background: var(--panel); border: 1px solid var(--btn-border); color: var(--text); display: grid; place-items: center; box-shadow: 0 6px 16px rgba(0,0,0,.45); }`
  `.chat-fab-dot { position: absolute; top: 6px; right: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--brass); border: 2px solid var(--panel); }`
  Make sure it doesn't cover the hero's cards or seats at 390×844 and 360×740 — the hero cards are bottom
  center; bottom-left corner of the table area should be free. Verify with screenshots and nudge
  `bottom`/`left` if needed.
- The mobile menu sheet keeps its existing "Chat" item (unchanged).
- When the chat sheet opens on mobile via the FAB, the input should be focused: pass
  `autoFocus=${true}` to `<Chat/>` in the `effectivePanel === 'chat'` panelBody (main.js) — Chat already
  supports `autoFocus`.

## 3. `M` shortcut

### public/js/main.js
- Add a ref `chatFocusRef = useRef(null)` in RoomLayout and a stable callback
  `registerChatFocus = useCallback((fn) => { chatFocusRef.current = fn; }, [])`.
- Add `openChat = useCallback(() => { if (chatFocusRef.current) chatFocusRef.current(); else setPanel('chat'); }, [])`.
  (Desktop: the dock registered its focus fn → focus the input. Mobile: no dock → open the chat sheet.)
- Add `registerChatFocus` and `openChat` to the RoomContext `value` object (and its deps array).

### public/js/actionbar.js — `useHotkeys`
- Pass `openChat: room && room.openChat` in the `useHotkeys({...})` call.
- In `onKey`, right after the `'?'` branch and BEFORE the `view.me` check, add:
  ```
  if (key === 'm') {
    if (L.openChat && L.view && L.view.me && !L.view.ended) { e.preventDefault(); L.openChat(); }
    return;
  }
  ```
  `preventDefault` stops the "m" being typed into the input that just got focus.
- `ignoreKeyEvent` already ignores keys while typing and while a modal is open, so `M` typed inside the chat
  input is just a letter, and Esc (blur) returns to the poker shortcuts.

### public/js/hotkeys.js
- In `HOTKEYS`, group "Anywhere", add before '?': `{ keys: ['M'], label: 'Message the table', note: 'Esc to leave the chat box' }`.
- `decideTurnKey('m', view)` must keep returning null (it does — don't add 'm' anywhere else).

### Keycap hint
- Desktop only: in the ChatDock header, after the title, add the existing keycap element style used by the
  action bar hints (find the keycap class used for "F"/"C" in actionbar.js, e.g. `kc`) showing `M`, hidden
  on touch like the other keycaps.

## 4. SPEC.md
- §11 desktop room: replace "right side panel (tabs Hand / Chat / Players …)" with: side panel tabs
  Hand / Players + session box; chat dock bottom-left under the table beside the action bar (bottom-right).
- §11 mobile: chat via the menu sheet or the floating chat button (bottom-left of the table, unread dot).
- §11 keyboard shortcuts: add `M` = focus the chat box (desktop) / open the chat sheet (phone); Esc leaves it.
- §12: side.js exports add `ChatDock`, `ChatFab`; RoomContext adds `openChat`, `registerChatFocus`.

## 5. Tests

### test/static.test.js
- Add `'ChatDock'` and `'ChatFab'` to the side.js expected exports.

### test/hotkeys.test.js
- Add `'M'` to the list of keys asserted present in `HOTKEYS` (line ~473).
- Add a test: `decideTurnKey('m', v)` is null on my turn (a real engine view, like neighbouring tests).

### test/e2e.mjs (these steps used the removed Chat tab)
- Step "chat between the three players (realtime)" (~line 637): Ben (desktop) now types in the dock:
  `B.page.locator('.chat-dock').getByRole('textbox', { name: 'Message' })`, send with the dock's Send button;
  assert with `B.page.locator('.chat-dock .chat-list')`. Cleo (phone) opens chat via the floating button
  `C.page.getByRole('button', { name: /^Chat/ })` inside `.room-m-table` (instead of the menu) — keep one
  assertion that the menu "Chat" item still works too, OR leave the menu path and add a separate assertion
  that the FAB shows an unread dot (`.chat-fab-dot`) after Ben's message and opens the sheet. Maya (desktop):
  replace the old "unread dot on the Chat tab, then click the tab" with: her dock shows the message
  (`H.page.locator('.chat-dock .chat-list')`).
- Step around line 1491 ("…and while typing: Maya writes 'fold' in the chat"): remove the tab clicks; use
  `H.page.locator('.chat-dock').getByRole('textbox', { name: 'Message' })`. Then add: press Escape → the input
  is blurred (`document.activeElement` is not the input), then press `m` → the chat input is focused and its
  value is still '' (the "m" wasn't typed), then Escape again before `keyAct(H, 'k')`.
- Add to the cheat-sheet check (search for `'After the hand'` in the keys steps) that the sheet lists
  "Message the table".
- Any other `getByRole('tab', { name: /^Chat/ })` uses → replace with the dock equivalents
  (`grep -n "Chat" test/e2e.mjs`).

### Screenshots (do these and look at them)
Use the dev preview harness (`npm run dev`, then `/__dev/preview.html?fixture=<name>` and `&w=mobile`) with
Playwright (global module; on this machine use the default `chromium.launch()`), and save to `dev/shots/chat-*.png`:
`my-turn-facing-bet` and `seated-waiting` and `showdown-complete` at 1440×1000 and 1180×820; the same three
with `&w=mobile` at 390×844 and 360×740. Check: chat dock bottom-left, action bar bottom-right, nothing
overlaps or overflows, no horizontal scroll, the FAB doesn't cover the hero cards or a seat.

## 6. Done when
- `node --test test/*.test.js` passes.
- `node test/e2e.mjs` passes (run it twice).
- `grep -rnE "^export (const|let|var) [\{\[]" public/js lib api` finds nothing.
- Report: files changed, test results, and anything you could not do.
