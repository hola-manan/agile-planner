// public/js/hotkeys.js — keyboard shortcuts and pre-actions: the pure decisions (SPEC §11).
//
// No imports and no DOM at module level, so node:test imports this file directly
// (test/hotkeys.test.js feeds it real viewFor() views). actionbar.js wires it to the page.
//
//   decideTurnKey(key, view)    → { move } | { focus: 'raise' } | { toast } | null      (my turn only)
//   togglePreAction(pre, kind, view) → the next pre-action (null = none)              (before my turn)
//   decidePreAction(pre, view)  → { fire: { move } } | { cancel: reason } | null
//   showKey(key, view)          → card indices to show | null                          (after the hand)
//
// A pre-action is { kind: 'checkFold' | 'callAny' | 'callCurrent', bet, at } — `bet` is
// hand.currentBet when it was picked, `at` the hand number + street it belongs to.

/** Keys that pick a pre-action while someone else is acting. */
export const PRE_KEYS = { i: 'checkFold', a: 'callAny', g: 'callCurrent' };
export const PRE_KINDS = ['checkFold', 'callAny', 'callCurrent'];

/** The cheat sheet (Shift+/): every key, grouped by when it works. */
export const HOTKEYS = [
  {
    title: 'Your turn',
    keys: [
      { keys: ['F'], label: 'Fold' },
      { keys: ['C'], label: 'Call', note: 'checks when there’s nothing to call' },
      { keys: ['K'], label: 'Check', note: 'only when checking is allowed' },
      { keys: ['R'], label: 'Raise', note: 'jumps to the amount — type it, then Enter' },
      { keys: ['A', 'G'], label: 'Call', note: 'or check if it’s free' },
      { keys: ['I'], label: 'Check if free, otherwise fold' },
    ],
  },
  {
    title: 'Before your turn',
    note: 'Acts for you the moment it’s your turn. Press the key again to cancel.',
    keys: [
      { keys: ['I'], label: 'Check/Fold', note: 'check if free, otherwise fold' },
      { keys: ['A'], label: 'Call any', note: 'call whatever it costs, even all-in' },
      { keys: ['G'], label: 'Call current', note: 'cancelled if the bet changes' },
    ],
  },
  {
    title: 'After the hand',
    keys: [
      { keys: ['S'], label: 'Show all your cards' },
      { keys: ['1', '2'], label: 'Show your first / second card', note: 'Omaha: 1–4' },
    ],
  },
  {
    title: 'Anywhere',
    keys: [
      { keys: ['?'], label: 'This list' },
      { keys: ['Esc'], label: 'Close a dialog' },
    ],
  },
];

const fmtN = (n) => Math.abs(Math.round(Number(n) || 0)).toLocaleString('en-US');

// ─── reading the view ────────────────────────────────────────────────────────

/** My row in hand.players, or null. */
export function myHandPlayer(view) {
  const me = view && view.me;
  const hand = view && view.hand;
  if (!me || !hand || !Array.isArray(hand.players)) return null;
  return hand.players.find((p) => p.pid === me.id) || null;
}

/** It is my turn to bet (the action bar shows Fold / Call / Raise). */
export function isMyTurn(view) {
  const hand = view && view.hand;
  return !!(view && view.me && hand && hand.phase === 'betting' && hand.toAct === view.me.id && hand.legal);
}

/** I'm in this betting round and someone else is deciding: pre-actions are on offer. */
export function canPreAct(view) {
  const me = view && view.me;
  const hand = view && view.hand;
  if (!me || me.seat == null || me.away || !hand || hand.phase !== 'betting') return false;
  if (!hand.toAct || hand.toAct === me.id) return false;
  const hp = myHandPlayer(view);
  return !!(hp && !hp.folded && !hp.allIn);
}

/** Chips I'd put in to call right now (capped by my stack). */
export function toCallOf(view) {
  const hand = view && view.hand;
  const hp = myHandPlayer(view);
  if (!hand || !hp) return 0;
  const stack = view.me && Number.isFinite(view.me.stack) ? view.me.stack : Infinity;
  return Math.max(0, Math.min(hand.currentBet - hp.bet, stack));
}

/** The betting round a pre-action belongs to. */
export function preContext(view) {
  const hand = view && view.hand;
  return hand ? hand.no + ':' + hand.street : '';
}

/** Button text for a pre-action. Call current follows the amount: "Call 60", or "Check". */
export function preLabel(kind, view) {
  if (kind === 'checkFold') return 'Check/Fold';
  if (kind === 'callAny') return 'Call any';
  const c = toCallOf(view);
  return c > 0 ? 'Call ' + fmtN(c) : 'Check';
}

// ─── keys ────────────────────────────────────────────────────────────────────

/**
 * The key a shortcut reads: digits from e.code (Digit1 / Numpad1, any layout or Shift), else e.key
 * lower-cased. The code only counts when the key typed a character — with NumLock off the numpad
 * sends End / ArrowDown / … on Numpad1 / Numpad2, and those must never show a card.
 */
export function normKey(e) {
  if (!e) return '';
  const key = String(e.key || '');
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(e.code || '');
  if (m && key.length === 1) return m[1];
  return key.toLowerCase();
}

// Inputs that take no typing: a focused slider, checkbox or button leaves the shortcuts on.
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image']);

/** Typing in a field (text-like input, textarea, select, or an editable element): shortcuts stay out of the way. */
export function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has(String(el.type || 'text').toLowerCase());
  return tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
}

/** True when a keydown must not trigger a shortcut. `modalOpen`: a dialog or sheet is up. */
export function ignoreKeyEvent(e, modalOpen) {
  if (!e || e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return true;
  if (e.isComposing) return true;
  return !!modalOpen || isTypingTarget(e.target);
}

// ─── decisions ───────────────────────────────────────────────────────────────

const CHECK = { move: 'check' };
const CALL = { move: 'call' };
const FOLD = { move: 'fold' };

/**
 * A key on my turn. → { move } to send, { focus: 'raise' }, { toast } to explain, or null
 * (not my turn / not a turn key — f, c, k and r never act early).
 */
export function decideTurnKey(key, view) {
  if (!isMyTurn(view)) return null;
  const legal = view.hand.legal;
  switch (key) {
    case 'f':
      return FOLD;
    case 'c':
    case 'a':
    case 'g':
      return legal.check ? CHECK : CALL;
    case 'k':
      return legal.check ? CHECK : { toast: 'Can’t check — ' + fmtN(legal.call) + ' to call' };
    case 'i':
      return legal.check ? CHECK : FOLD;
    case 'r':
      return legal.raise && legal.maxTo > 0 ? { focus: 'raise' } : { toast: 'You can’t raise here — call or fold' };
    default:
      return null;
  }
}

/**
 * Press (key or button) a pre-action while waiting: the same one again turns it off, another one
 * replaces it. Outside a betting round I'm waiting in, nothing changes.
 */
export function togglePreAction(pre, kind, view) {
  if (!PRE_KINDS.includes(kind) || !canPreAct(view)) return pre || null;
  const at = preContext(view);
  if (pre && pre.kind === kind && pre.at === at) return null;
  return { kind, bet: view.hand.currentBet, at };
}

/**
 * What a pending pre-action does with this view:
 *   { cancel: 'street' }   the hand or street moved on (silently dropped)
 *   { cancel: 'gone' }     I folded / went all-in / went away / the hand completed
 *   { cancel: 'changed' }  Call current, but the bet changed (tell me)
 *   { fire: { move } }     it's my turn — send this
 *   null                   keep waiting
 */
export function decidePreAction(pre, view) {
  if (!pre) return null;
  if (!view || !view.hand || pre.at !== preContext(view)) return { cancel: 'street' };
  const mine = isMyTurn(view);
  if (!mine && !canPreAct(view)) return { cancel: 'gone' };
  if (pre.kind === 'callCurrent' && view.hand.currentBet !== pre.bet) return { cancel: 'changed' };
  if (!mine) return null;
  const legal = view.hand.legal;
  if (pre.kind === 'checkFold') return { fire: legal.check ? CHECK : FOLD };
  return { fire: legal.check ? CHECK : CALL };
}

/** After the hand: s → all my unshown cards, 1–4 → that card if it isn't shown yet. Else null. */
export function showKey(key, view) {
  const hand = view && view.hand;
  if (!hand || hand.phase !== 'complete' || !hand.canShow) return null;
  const hp = myHandPlayer(view);
  const hole = (view.me && view.me.hole) || [];
  if (!hp || !hole.length) return null;
  const shown = hp.shown || [];
  const unshown = hole.map((_, i) => i).filter((i) => !shown[i]);
  if (key === 's') return unshown.length ? unshown : null;
  if (/^[1-4]$/.test(key)) {
    const i = Number(key) - 1;
    return unshown.includes(i) ? [i] : null;
  }
  return null;
}
