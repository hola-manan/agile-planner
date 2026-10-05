// public/js/ui.js — shared UI primitives (SPEC §11–§12). Pure presentation: no API calls.
import { html, useState, useEffect, useRef, useCallback, createPortal } from './h.js';

// ─── tiny helpers ────────────────────────────────────────────────────────────

export function cx(...classes) {
  const out = [];
  for (const c of classes) {
    if (!c) continue;
    if (typeof c === 'string') out.push(c);
    else if (Array.isArray(c)) {
      const s = cx(...c);
      if (s) out.push(s);
    } else if (typeof c === 'object') {
      for (const k in c) if (c[k]) out.push(k);
    }
  }
  return out.join(' ');
}

const MINUS = '−';

/** 1234 → '1,234'; -24 → '−24' (typographic minus). Non-numbers → '—'. */
export function fmt(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return '—';
  const s = Math.abs(Math.round(v)).toLocaleString('en-US');
  return v < 0 ? MINUS + s : s;
}

/** Signed: +212 / −24 / 0. */
export function fmtSigned(n) {
  const v = Number(n) || 0;
  return v > 0 ? '+' + fmt(v) : fmt(v);
}

/** Client-side navigation inside the SPA (App listens to popstate). */
export function navigate(url, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function inviteUrl(code) {
  return location.origin + '/?room=' + encodeURIComponent(code);
}

/** Copy to the clipboard; resolves true on success. Falls back to execCommand for non-secure origins. */
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ─── buttons, pills, form bits ───────────────────────────────────────────────

export function Button({ kind = 'default', size = 'md', class: klass, className, type = 'button', children, ...props }) {
  const cls = cx(
    'btn',
    kind !== 'default' && 'btn-' + kind,
    size !== 'md' && 'btn-' + size,
    klass,
    className,
  );
  return html`<button type=${type} class=${cls} ...${props}>${children}</button>`;
}

export function Pill({ tone = 'default', class: klass, className, children, ...props }) {
  return html`<span class=${cx('pill', tone !== 'default' && 'pill-' + tone, klass, className)} ...${props}>${children}</span>`;
}

/** Checkbox toggle styled as a switch. onChange receives the new boolean. */
export function Switch({ checked, onChange, label, disabled, id, class: klass }) {
  return html`<input
    type="checkbox"
    role="switch"
    class=${cx('switch', klass)}
    id=${id}
    aria-label=${label}
    checked=${!!checked}
    disabled=${disabled}
    onChange=${(e) => onChange && onChange(e.target.checked)}
  />`;
}

/** Segmented control. options: [{ value, label, disabled? }] */
export function Seg({ options, value, onChange, label, class: klass, small }) {
  return html`<div class=${cx('seg', small && 'seg-sm', klass)} role="group" aria-label=${label}>
    ${options.map(
      (o) => html`<button
        key=${String(o.value)}
        type="button"
        class=${o.value === value ? 'on' : ''}
        aria-pressed=${o.value === value}
        disabled=${o.disabled}
        onClick=${() => onChange && onChange(o.value)}
      >${o.label}</button>`,
    )}
  </div>`;
}

// ─── avatar ──────────────────────────────────────────────────────────────────

export const AVATAR_HUES = ['#E9B872', '#E8A3A3', '#C9A7E0', '#8FD0CF', '#F2D9A0', '#9CC5A1', '#A7B8E8', '#D9C79A', '#B5D69A'];

export function hueFor(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return AVATAR_HUES[Math.abs(Math.trunc(seed)) % AVATAR_HUES.length];
  const s = String(seed ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return AVATAR_HUES[(h >>> 0) % AVATAR_HUES.length];
}

/** 'Priya' → 'PR'; 'Mary Jane' → 'MJ'; '' → '?' */
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const chars = (w) => Array.from(w);
  if (words.length === 1) return chars(words[0]).slice(0, 2).join('').toUpperCase();
  return (chars(words[0])[0] + chars(words[1])[0]).toUpperCase();
}

export function Avatar({ name, seed, size = 38, class: klass, style, ...props }) {
  const st = {
    width: size + 'px',
    height: size + 'px',
    fontSize: Math.round(size * 0.37) + 'px',
    background: hueFor(seed ?? name),
    ...(style || {}),
  };
  return html`<div class=${cx('avatar', klass)} style=${st} aria-hidden="true" ...${props}>${initials(name)}</div>`;
}

// ─── cards ───────────────────────────────────────────────────────────────────

// U+FE0E (text presentation selector) keeps iOS from drawing ♥/♦ as emoji.
export const SUIT_GLYPH = { s: '\u2660\uFE0E', h: '\u2665\uFE0E', d: '\u2666\uFE0E', c: '\u2663\uFE0E' };
const SUIT_NAME = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' };
const RANK_NAME = { A: 'Ace', K: 'King', Q: 'Queen', J: 'Jack', T: 'Ten', 9: 'Nine', 8: 'Eight', 7: 'Seven', 6: 'Six', 5: 'Five', 4: 'Four', 3: 'Three', 2: 'Two' };

/** 'Td' → '10' ; 'As' → 'A' */
export function rankLabel(card) {
  const r = String(card || '')[0];
  return r === 'T' ? '10' : r || '';
}

/** 'Td' → '10♦' — for inline text (hand log, labels). */
export function cardText(card) {
  if (!card) return '';
  return rankLabel(card) + (SUIT_GLYPH[card[1]] || '');
}

export function cardName(card) {
  if (!card || card.length < 2) return 'Card';
  return (RANK_NAME[card[0]] || card[0]) + ' of ' + (SUIT_NAME[card[1]] || card[1]);
}

/**
 * <Card card="As" size="lg" />. size: xs | sm | md | lg | xl.
 *   faceDown → striped back; card null/undefined (and not faceDown) → empty dashed slot.
 *   dim / lift → showdown emphasis; ghost → "would have come" runout card; flip → reveal animation.
 */
export function Card({ card, size = 'md', dim, lift, ghost, flip, faceDown, class: klass, className, style, ...props }) {
  const base = cx('card', 'card-' + size, dim && 'card-dim', lift && 'card-lift', flip && 'card-flip', klass, className);
  if (faceDown) return html`<div class=${cx(base, 'card-back')} style=${style} role="img" aria-label="Face-down card" ...${props}></div>`;
  if (!card) return html`<div class=${cx(base, 'card-slot')} style=${style} aria-hidden="true" ...${props}></div>`;
  const suit = card[1];
  return html`<div
    class=${cx(base, 'suit-' + suit, ghost && 'card-ghost')}
    style=${style}
    role="img"
    aria-label=${cardName(card) + (ghost ? ' (would have come)' : '')}
    ...${props}
  ><span class="card-rank" aria-hidden="true">${rankLabel(card)}</span><span class="card-suit" aria-hidden="true">${SUIT_GLYPH[suit] || '?'}</span></div>`;
}

// Four-colour deck preference: a class on <html> drives the CSS suit colours, so Card itself
// needs no hook and every card on screen switches at once.
const FOUR_KEY = 'felt:fourColor';
let fourColor = (() => {
  try {
    const v = localStorage.getItem(FOUR_KEY);
    return v == null ? true : v !== 'false';
  } catch {
    return true;
  }
})();
const fourSubs = new Set();
function applyFourColor() {
  document.documentElement.classList.toggle('two-color', !fourColor);
}
applyFourColor();

export function useFourColor() {
  const [v, setV] = useState(fourColor);
  useEffect(() => {
    fourSubs.add(setV);
    setV(fourColor);
    return () => fourSubs.delete(setV);
  }, []);
  const set = useCallback((next) => {
    fourColor = typeof next === 'function' ? !!next(fourColor) : !!next;
    try {
      localStorage.setItem(FOUR_KEY, String(fourColor));
    } catch {
      /* ignore */
    }
    applyFourColor();
    fourSubs.forEach((fn) => fn(fourColor));
  }, []);
  return [v, set];
}

// ─── responsive ──────────────────────────────────────────────────────────────

const MOBILE_Q = '(max-width: 899px)';

export function useIsMobile() {
  const [m, setM] = useState(() => window.matchMedia(MOBILE_Q).matches);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_Q);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return m;
}

// ─── modal / sheet ───────────────────────────────────────────────────────────

const modalStack = [];
let scrollLocks = 0;

function lockScroll() {
  if (scrollLocks++ === 0) document.documentElement.classList.add('modal-open');
}
function unlockScroll() {
  if (--scrollLocks <= 0) {
    scrollLocks = 0;
    document.documentElement.classList.remove('modal-open');
  }
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Centered dialog at ≥ 900px, bottom sheet below. `wide` → large dialog on desktop and a
 * full-screen sheet (with a back button) on mobile. Without `title` no header is drawn and the
 * children provide their own. Extra props: subtitle, actions (header-right nodes), label
 * (aria-label when title isn't a string), class.
 */
export function Modal({ open, onClose, title, subtitle, actions, children, wide, label, class: klass, className }) {
  const mobile = useIsMobile();
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const token = {};
    modalStack.push(token);
    lockScroll();
    const prevFocus = document.activeElement;
    const el = ref.current;
    // Focus the first form field if there is one, else the dialog itself.
    const t = setTimeout(() => {
      if (!el || !el.isConnected) return;
      const field = el.querySelector('[data-autofocus], input:not([type=hidden]):not([type=range]):not([type=checkbox]):not([type=radio]), textarea');
      (field && !mobile ? field : el).focus({ preventScroll: true });
    }, 30);
    const onKey = (e) => {
      if (modalStack[modalStack.length - 1] !== token) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeRef.current && closeRef.current();
      } else if (e.key === 'Tab' && el) {
        const items = Array.from(el.querySelectorAll(FOCUSABLE)).filter((n) => n.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      const i = modalStack.indexOf(token);
      if (i >= 0) modalStack.splice(i, 1);
      unlockScroll();
      if (prevFocus && typeof prevFocus.focus === 'function' && prevFocus.isConnected) prevFocus.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  const full = mobile && wide;
  const close = () => onClose && onClose();
  const aria = typeof title === 'string' ? title : label;

  let head = null;
  if (full) {
    head = html`<div class="sheet-head">
      <button type="button" class="btn btn-icon" aria-label="Back to table" onClick=${close}><${Icon} name="back" /></button>
      <div class="sheet-title">
        ${title && html`<h1>${title}</h1>`}
        ${subtitle && html`<div class="muted sheet-sub">${subtitle}</div>`}
      </div>
      ${actions}
    </div>`;
  } else if (title) {
    head = html`<div class="modal-head">
      <div class="modal-title">
        <h2>${title}</h2>
        ${subtitle && html`<div class="muted modal-sub">${subtitle}</div>`}
      </div>
      ${actions}
      ${!mobile && html`<button type="button" class="btn btn-icon btn-sm modal-x" aria-label="Close" onClick=${close}><${Icon} name="close" size=${16} /></button>`}
    </div>`;
  }

  const panelCls = cx(
    mobile ? 'sheet' : 'modal',
    wide && (mobile ? 'sheet-full' : 'modal-wide'),
    klass,
    className,
  );

  return createPortal(
    html`<div
      class=${cx('modal-backdrop', mobile && 'is-sheet', full && 'is-full')}
      onMouseDown=${(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div ref=${ref} class=${panelCls} role="dialog" aria-modal="true" aria-label=${aria} tabindex="-1">
        ${mobile && !full && html`<button type="button" class="sheet-handle" aria-label="Close" onClick=${close}></button>`}
        ${head}
        <div class="modal-body">${children}</div>
      </div>
    </div>`,
    document.body,
  );
}

export const Sheet = Modal;

// ─── toasts ──────────────────────────────────────────────────────────────────

let toastList = [];
let toastSeq = 0;
const toastSubs = new Set();
const toastTimers = new Map();

function emitToasts() {
  toastSubs.forEach((fn) => fn(toastList));
}

export function dismissToast(id) {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toastList = toastList.filter((t) => t.id !== id);
  emitToasts();
}

/** Show a toast. tone: 'danger' (default) | 'pos' | 'default' | 'brass'. Same message → timer refresh. */
export function toast(message, tone = 'danger', ms) {
  if (!message) return;
  const text = String(message);
  const dur = ms ?? (tone === 'danger' ? 5200 : 3200);
  let t = toastList.find((x) => x.text === text && x.tone === tone);
  if (t) {
    t = { ...t, n: t.n + 1 };
    toastList = toastList.map((x) => (x.id === t.id ? t : x));
  } else {
    t = { id: ++toastSeq, text, tone, n: 1 };
    toastList = [...toastList, t].slice(-4);
  }
  clearTimeout(toastTimers.get(t.id));
  const id = t.id;
  toastTimers.set(id, setTimeout(() => dismissToast(id), dur));
  emitToasts();
}

export function Toasts() {
  const [list, setList] = useState(toastList);
  useEffect(() => {
    toastSubs.add(setList);
    setList(toastList);
    return () => toastSubs.delete(setList);
  }, []);
  return createPortal(
    html`<div class="toasts" role="status" aria-live="polite">
      ${list.map(
        (t) => html`<button type="button" key=${t.id} class=${cx('toast', 'toast-' + t.tone)} onClick=${() => dismissToast(t.id)}>
          <${Icon} name=${t.tone === 'danger' ? 'alert' : t.tone === 'pos' ? 'check' : 'info'} size=${18} />
          <span>${t.text}</span>
        </button>`,
      )}
    </div>`,
    document.body,
  );
}

// ─── countdown ───────────────────────────────────────────────────────────────

/** Seconds left as text: '14s', '1:05'. Empty string without a deadline. */
export function countdownText(deadline, now) {
  if (!deadline) return '';
  const s = Math.max(0, Math.ceil((deadline - now) / 1000));
  if (s >= 60) return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  return s + 's';
}

export function Countdown({ deadline, now }) {
  return countdownText(deadline, now ?? Date.now());
}

// ─── icons ───────────────────────────────────────────────────────────────────

const P = (d) => html`<path d=${d} />`;
const ICONS = {
  spade: P('M12 3c3 3.2 7 5.6 7 9.2a3.6 3.6 0 0 1-6.2 2.5L13.5 19h-3l.7-4.3A3.6 3.6 0 0 1 5 12.2C5 8.6 9 6.2 12 3z'),
  ledger: html`${P('M5 4h11l3 3v13H5z')}${P('M8 10h8M8 14h8M8 18h5')}`,
  crown: P('M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z'),
  gear: html`<circle cx="12" cy="12" r="3" />${P('M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1')}`,
  clock: html`<circle cx="12" cy="12" r="9" />${P('M12 7v5l3 2')}`,
  leave: P('M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10'),
  close: P('M6 6l12 12M18 6L6 18'),
  copy: html`<rect x="8" y="8" width="12" height="12" rx="2" />${P('M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3')}`,
  menu: P('M4 7h16M4 12h16M4 17h16'),
  back: P('M15 5l-7 7 7 7'),
  eye: html`${P('M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z')}<circle cx="12" cy="12" r="3" />`,
  check: P('M5 12l5 5 9-10'),
  chat: P('M4 5h16v11H9l-5 4z'),
  users: html`<circle cx="9" cy="8" r="3.5" />${P('M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5')}${P('M15.5 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .8 3.2 2.5 3.5 5.2')}`,
  history: html`${P('M3.5 12a8.5 8.5 0 1 0 2.6-6.1')}${P('M3 4v5h5')}${P('M12 8v4.5l3 2')}`,
  plus: P('M12 5v14M5 12h14'),
  minus: P('M5 12h14'),
  chevron: P('M9 5l7 7-7 7'),
  down: P('M6 9l6 6 6-6'),
  link: html`${P('M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1')}${P('M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1')}`,
  pause: P('M8 5v14M16 5v14'),
  play: P('M7 5l12 7-12 7z'),
  info: html`<circle cx="12" cy="12" r="9" />${P('M12 11v6M12 7.5v.5')}`,
  alert: html`<circle cx="12" cy="12" r="9" />${P('M12 7v6M12 16.5v.5')}`,
  share: P('M12 15V3M7 8l5-5 5 5M5 14v6h14v-6'),
  download: P('M12 3v12M7 10l5 5 5-5M5 20h14'),
  arrow: P('M5 12h14M13 6l6 6-6 6'),
  chips: html`<ellipse cx="12" cy="7" rx="7" ry="3" />${P('M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7')}${P('M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5')}`,
  seat: html`${P('M7 4h10v8H7z')}${P('M5 12h14v3H5zM7 15v5M17 15v5')}`,
  home: P('M4 11l8-7 8 7v9h-5v-6H9v6H4z'),
  user: html`<circle cx="12" cy="8" r="4" />${P('M4 21c.8-4.2 4-6.5 8-6.5s7.2 2.3 8 6.5')}`,
  suits: P('M12 3c3 3.2 7 5.6 7 9.2a3.6 3.6 0 0 1-6.2 2.5L13.5 19h-3l.7-4.3A3.6 3.6 0 0 1 5 12.2C5 8.6 9 6.2 12 3z'),
};

export function Icon({ name, size = 18, stroke, class: klass, style, title }) {
  const body = ICONS[name] || ICONS.info;
  const sw = stroke ?? (name === 'spade' || name === 'ledger' || name === 'crown' || name === 'gear' ? 1.8 : 2);
  return html`<svg
    class=${cx('icon', klass)}
    width=${size}
    height=${size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth=${sw}
    strokeLinecap="round"
    strokeLinejoin="round"
    style=${style}
    aria-hidden=${title ? undefined : 'true'}
    role=${title ? 'img' : undefined}
  >${title && html`<title>${title}</title>`}${body}</svg>`;
}

/** The brand mark: spade outline + "Felt" wordmark. */
export function Logo({ size = 28, word = true }) {
  return html`<span class="logo">
    <${Icon} name="spade" size=${size} class="logo-mark" />
    ${word && html`<span class="logo-word">Felt</span>`}
  </span>`;
}
