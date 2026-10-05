// public/js/side.js — the desktop side panel (tabs Hand / Chat / Players + "your session") and its
// parts, which the mobile menu sheets reuse (SPEC §11, §12; design/Main.dc.html, design/Away.dc.html).
//
//   SidePanel({ onBuyIn, onLeave })   tabs + SessionBox
//   HandLog()                         current hand grouped by street (+ the previous hand)
//   Chat()                            messages, input, auto-scroll
//   PlayersList()                     seat, avatar, name, stack, status, host crown
//   SessionBox({ onBuyIn, onLeave })  bought in / net / buy-in / away / leave
//
// Also exports small helpers used by host.js and ledger.js (seedOf, clockTime, ordinal, playerStatus).
import { html, useState, useEffect, useRef, useLayoutEffect, useMemo, useCallback, Fragment } from './h.js';
import { useRoom } from './room.js';
import { Button, Pill, Avatar, Icon, cx, fmt, fmtSigned, hueFor, rankLabel, SUIT_GLYPH, toast } from './ui.js';

// ─── shared helpers ──────────────────────────────────────────────────────────

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

export function playerOf(view, pid) {
  return ((view && view.players) || []).find((p) => p.id === pid) || null;
}

/** Avatar seed: the seat (same hue as the table pod), else the name (Avatar's own fallback). */
export function seedOf(view, pid, fallbackName) {
  const p = playerOf(view, pid);
  if (p && p.seat != null) return p.seat;
  return (p && p.name) || fallbackName || pid;
}

export function ledgerRowOf(view, pid) {
  return ((view && view.ledger && view.ledger.players) || []).find((r) => r.pid === pid) || null;
}

/** 22:41 */
export function clockTime(t) {
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Is a hand running (not yet complete) that this player was dealt into? */
export function inRunningHand(view, pid) {
  const h = view && view.hand;
  return !!(h && h.phase !== 'complete' && (h.players || []).some((x) => x.pid === pid));
}

/** Dealt into the current hand at all (incl. a complete one) — host adjustments wait for its end. */
export function dealtIn(view, pid) {
  const h = view && view.hand;
  return !!(h && (h.players || []).some((x) => x.pid === pid));
}

/**
 * Status of a public player: { key, label, tone } with key one of
 * playing | next | away | busted | leaving | spectating | waiting.
 */
export function playerStatus(view, p, { long = false } = {}) {
  if (!p) return { key: 'spectating', label: 'Spectating', tone: 'default' };
  if (p.seat == null) {
    const req = (view.requests || []).find((r) => r.pid === p.id && r.kind === 'sit');
    return req ? { key: 'waiting', label: 'Wants a seat', tone: 'brass' } : { key: 'spectating', label: 'Spectating', tone: 'default' };
  }
  if (p.leaveAfterHand) return { key: 'leaving', label: 'Leaving', tone: 'danger' };
  if (p.away) {
    const why = p.awayBy === 'host' ? 'by host' : p.awayBy === 'timeout' ? 'timed out' : null;
    return { key: 'away', label: long && why ? 'Away · ' + why : 'Away', tone: 'brass' };
  }
  if (p.busted) return { key: 'busted', label: 'Busted', tone: 'danger' };
  const h = view.hand;
  if (h && h.phase !== 'complete' && !p.inHand) return { key: 'next', label: 'Next hand', tone: 'default' };
  return { key: 'playing', label: 'Playing', tone: 'default' };
}

// "When I come back" — wait for the big blind or play the next hand. One preference shared by the
// session box (radios) and the action bar's away banner (checkbox), so the two never disagree.
// Default off, as in design/AwayMobile.dc.html.
let backWaitBB = false;
const backSubs = new Set();

// "At showdown, when I lose": 'ask' (prompt each time) | 'muck' (keep them hidden, no prompt) |
// 'show' (show them automatically). Per browser (localStorage), shared by the session box and the
// action bar, which applies it when a showdown I lost completes.
const SHOWDOWN_KEY = 'felt:showdownPref';
export const SHOWDOWN_PREFS = [
  { value: 'ask', label: 'Ask me each time' },
  { value: 'muck', label: 'Always muck' },
  { value: 'show', label: 'Always show' },
];
let showdownPref = null;
const showdownSubs = new Set();
function readShowdownPref() {
  if (showdownPref == null) {
    const v = store.get(SHOWDOWN_KEY);
    showdownPref = v === 'muck' || v === 'show' ? v : 'ask';
  }
  return showdownPref;
}

export function useShowdownPref() {
  const [v, setV] = useState(readShowdownPref);
  useEffect(() => {
    showdownSubs.add(setV);
    setV(readShowdownPref());
    return () => showdownSubs.delete(setV);
  }, []);
  const set = useCallback((next) => {
    showdownPref = next === 'muck' || next === 'show' ? next : 'ask';
    store.set(SHOWDOWN_KEY, showdownPref);
    showdownSubs.forEach((fn) => fn(showdownPref));
  }, []);
  return [v, set];
}

export function useBackPref() {
  const [v, setV] = useState(backWaitBB);
  useEffect(() => {
    backSubs.add(setV);
    setV(backWaitBB);
    return () => backSubs.delete(setV);
  }, []);
  const set = useCallback((next) => {
    backWaitBB = !!next;
    backSubs.forEach((fn) => fn(backWaitBB));
  }, []);
  return [v, set];
}

/** Small light "card chip" for inline text: K♥ */
export function CardChip({ card, ghost }) {
  if (!card) return null;
  return html`<span class=${cx('cchip', 'suit-' + card[1], ghost && 'cchip-ghost')}>${rankLabel(card)}${SUIT_GLYPH[card[1]] || ''}</span>`;
}

function CardChips({ cards, ghost }) {
  if (!cards || !cards.length) return null;
  return html`<span class="cchips">${cards.map((c, i) => html`<${CardChip} key=${i} card=${c} ghost=${ghost} />`)}</span>`;
}

// ─── HandLog ─────────────────────────────────────────────────────────────────

const STREET = { preflop: 'Preflop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' };
const PLURAL = { calls: 'call', checks: 'check', folds: 'fold', bets: 'bet', raises: 'raise', posts: 'post', wins: 'win', shows: 'show', gets: 'get', reveals: 'reveal' };

/** 'calls' → 'call' when the subject is "You" or several people. */
function verb(text, plural) {
  const t = String(text || '');
  if (t === 'all-in') return plural ? 'go all-in' : 'goes all-in';
  if (!plural) return t;
  const i = t.indexOf(' ');
  const head = i < 0 ? t : t.slice(0, i);
  return (PLURAL[head] || head) + (i < 0 ? '' : t.slice(i));
}

function isResult(e) {
  return e.pid && /^(wins|gets back)/.test(e.text || '');
}

/**
 * Turn a raw log into display groups:
 *   [{ key, title, cards, lines: [{ who:[names], text, amount, cards, kind }] }]
 * Consecutive identical check/call/fold lines are merged ("Ari, Leo call 6").
 */
function buildGroups(log, view) {
  const meId = view && view.me ? view.me.id : null;
  const groups = [];
  const results = [];
  let cur = null;
  const open = (key, title, cards) => {
    cur = { key, title, cards: cards || null, lines: [] };
    groups.push(cur);
  };
  for (let i = 0; i < (log || []).length; i++) {
    const e = log[i];
    const street = e.street || 'preflop';
    if (!e.pid && Array.isArray(e.cards) && e.cards.length) {
      open('g' + i, e.text || STREET[street] || '', e.cards);
      cur.street = street;
      continue;
    }
    const who = e.pid ? { n: e.pid === meId ? 'You' : e.name || 'Someone', self: !!meId && e.pid === meId } : null;
    const line = { key: 'l' + i, who: who ? [who] : [], text: e.text, amount: e.amount, cards: e.cards || null, kind: e.pid ? 'act' : 'note' };
    if (isResult(e)) {
      results.push({ ...line, kind: 'result' });
      continue;
    }
    if (!cur || cur.street !== street) {
      open('g' + i, STREET[street] || street, null);
      cur.street = street;
    }
    const prev = cur.lines[cur.lines.length - 1];
    const mergeable = line.kind === 'act' && /^(calls|checks|folds)$/.test(e.text) && !line.cards;
    if (mergeable && prev && prev.kind === 'act' && prev.text === e.text && prev.amount === e.amount && !prev.cards) {
      prev.who.push(who);
    } else cur.lines.push(line);
  }
  return { groups, results };
}

/** [{n, self}] → "Ari, You and Leo" with each name bold (mine in brass). */
function Names({ who }) {
  const out = [];
  who.forEach((w, i) => {
    if (i > 0) out.push(i === who.length - 1 ? ' and ' : ', ');
    out.push(html`<b key=${i} class=${cx(w.self && 'log-me')}>${w.n}</b>`);
  });
  return out;
}

function LogLine({ line }) {
  const plural = line.who.length > 1 || (line.who[0] && line.who[0].self);
  const quiet = line.kind === 'note' || /^(checks|folds)/.test(line.text);
  let amount;
  if (line.kind === 'result') amount = html`<span class="mono pos">+${fmt(line.amount)}</span>`;
  else if (line.amount != null) amount = html`<span class="mono">${fmt(line.amount)}</span>`;
  else if (/^(checks|folds)/.test(line.text)) amount = html`<span class="mono muted">—</span>`;
  else amount = null;
  return html`<div class=${cx('log-line', quiet && 'is-quiet', line.kind === 'result' && 'is-result')}>
    <span class="log-text">
      ${line.who.length > 0 && html`<${Names} who=${line.who} />${' '}`}${line.who.length ? verb(line.text, plural) : line.text}
      ${line.cards && html` <${CardChips} cards=${line.cards} ghost=${/reveals/.test(line.text)} />`}
    </span>
    ${amount}
  </div>`;
}

function LogGroups({ log, view }) {
  const { groups, results } = useMemo(() => buildGroups(log, view), [log, view && view.me && view.me.id]);
  return html`<div class="log">
    ${groups.map(
      (g) => html`<div class=${cx('log-group', !g.lines.length && 'is-bare')} key=${g.key}>
        <div class="label log-head">${g.title}${g.cards && html`<${CardChips} cards=${g.cards} />`}</div>
        ${g.lines.map((l) => html`<${LogLine} key=${l.key} line=${l} />`)}
      </div>`,
    )}
    ${results.length > 0 &&
    html`<div class="log-group">
      <div class="label log-head">Results</div>
      ${results.map((l) => html`<${LogLine} key=${l.key} line=${l} />`)}
    </div>`}
  </div>`;
}

function phaseLabel(h) {
  if (!h) return '';
  if (h.phase === 'complete') return h.results && h.results.endedBy === 'fold' ? 'Won without showdown' : 'Showdown';
  if (h.phase === 'ritVote') return 'Run-it vote';
  if (h.phase === 'runout') return h.runs > 1 ? 'Running it ' + (h.runs === 2 ? 'twice' : h.runs + '×') : 'Runout';
  return STREET[h.street] || h.street;
}

/** Nearest ancestor that scrolls vertically (the side panel body, or a sheet's body on phones). */
function scrollParent(el) {
  for (let n = el && el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/**
 * Keep the newest line of the running hand in view while the reader is following along: a new
 * hand starts at the top; each new line scrolls into view unless the reader scrolled away.
 */
function useFollowLog(endRef, handNo, lines) {
  const follow = useRef(true);
  const lastNo = useRef(handNo);
  useLayoutEffect(() => {
    const newHand = lastNo.current !== handNo;
    lastNo.current = handNo;
    if (newHand) follow.current = true;
    const end = endRef.current;
    const sp = end && scrollParent(end);
    if (!sp) return undefined;
    const below = () => end.getBoundingClientRect().bottom - sp.getBoundingClientRect().bottom;
    if (newHand) sp.scrollTop = 0;
    else if (follow.current && below() > 0) sp.scrollTop += below() + 8;
    const onScroll = () => {
      follow.current = below() <= 48;
    };
    sp.addEventListener('scroll', onScroll, { passive: true });
    return () => sp.removeEventListener('scroll', onScroll);
  }, [handNo, lines]);
}

export function HandLog() {
  const { view } = useRoom();
  const h = view.hand;
  const last = view.lastHand;
  const [showLast, setShowLast] = useState(false);
  const endRef = useRef(null);
  useFollowLog(endRef, h ? h.no : null, h ? h.log.length : 0);

  if (!h && !last) {
    return html`<div class="side-empty">
      <${Icon} name="history" size=${22} />
      <p>No hands yet.</p>
      <p class="muted">The log fills in as cards are dealt.</p>
    </div>`;
  }

  const lastSummary = last ? buildGroups(last.log, view).results : [];
  return html`<div class="handlog">
    ${h &&
    html`<div class="log-title">
        <span>Hand <span class="mono">#${h.no}</span></span>
        <span class="muted">${phaseLabel(h)}</span>
      </div>
      <${LogGroups} log=${h.log} view=${view} />
      <div ref=${endRef} class="log-end" aria-hidden="true"></div>`}
    ${last &&
    html`<div class=${cx('log-last', !h && 'is-only')}>
      <div class="log-title">
        <span>${h ? 'Previous hand' : 'Last hand'} <span class="mono">#${last.no}</span></span>
        ${h &&
        html`<button type="button" class="linkbtn" aria-expanded=${showLast} onClick=${() => setShowLast(!showLast)}>
          ${showLast ? 'Hide' : 'Full log'}<${Icon} name="down" size=${14} class=${cx('chev', showLast && 'up')} />
        </button>`}
      </div>
      ${!h || showLast
        ? html`<${LogGroups} log=${last.log} view=${view} />`
        : html`<div class="log">${lastSummary.map((l) => html`<${LogLine} key=${l.key} line=${l} />`)}</div>`}
    </div>`}
  </div>`;
}

// ─── Chat ────────────────────────────────────────────────────────────────────

export function Chat({ autoFocus = false } = {}) {
  const { view, act } = useRoom();
  const me = view.me;
  const msgs = view.chat || [];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const listRef = useRef(null);
  const stickRef = useRef(true);
  const lastId = msgs.length ? msgs[msgs.length - 1].id : 0;

  // Follow new messages when the reader is at (or near) the bottom, or the message is mine.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const mine = msgs.length && me && msgs[msgs.length - 1].pid === me.id;
    if (stickRef.current || mine) el.scrollTop = el.scrollHeight;
  }, [lastId]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const send = async (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const v = await act('chat', { text: t });
    setBusy(false);
    if (v) {
      setText('');
      stickRef.current = true;
    }
  };

  // Group consecutive messages from the same person within 3 minutes under one header.
  const items = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    const p = msgs[i - 1];
    const cont = p && p.pid === m.pid && m.t - p.t < 180000;
    items.push({ m, cont });
  }

  return html`<div class="chat">
    <div class="chat-list" ref=${listRef} onScroll=${onScroll} role="log" aria-live="polite" aria-label="Chat messages">
      ${msgs.length === 0
        ? html`<div class="side-empty">
            <${Icon} name="chat" size=${22} />
            <p>No messages yet.</p>
            <p class="muted">Say hi to the table.</p>
          </div>`
        : items.map(({ m, cont }) => {
            const mine = me && m.pid === me.id;
            return html`<div key=${m.id} class=${cx('chat-msg', cont && 'is-cont', mine && 'is-me')}>
              ${!cont &&
              html`<div class="chat-meta">
                <b style=${{ color: hueFor(seedOf(view, m.pid, m.name)) }}>${mine ? 'You' : m.name}</b>
                <span class="mono muted">${clockTime(m.t)}</span>
              </div>`}
              <div class="chat-text">${m.text}</div>
            </div>`;
          })}
    </div>
    ${me
      ? html`<form class="chat-form" onSubmit=${send}>
          <input
            class="field"
            aria-label="Message"
            placeholder="Message the table"
            maxlength="280"
            autocomplete="off"
            enterkeyhint="send"
            autoFocus=${autoFocus}
            value=${text}
            onInput=${(e) => setText(e.target.value)}
          />
          <button type="submit" class="btn btn-primary btn-icon" aria-label="Send" disabled=${busy || !text.trim()}>
            <${Icon} name="arrow" size=${18} />
          </button>
        </form>`
      : html`<div class="note note-plain chat-note"><${Icon} name="info" /><span>Join the game to chat.</span></div>`}
  </div>`;
}

// ─── PlayersList ─────────────────────────────────────────────────────────────

const STATUS_CLASS = { away: 'brass', busted: 'neg', leaving: 'neg', waiting: 'brass' };

export function PlayersList() {
  const { view } = useRoom();
  const me = view.me;
  const players = view.players || [];
  const seated = players.filter((p) => p.seat != null).sort((a, b) => a.seat - b.seat);
  const watching = players.filter((p) => p.seat == null);

  const row = (p) => {
    const st = playerStatus(view, p, { long: true });
    const mine = me && p.id === me.id;
    return html`<li key=${p.id} class=${cx('plist-row', p.seat == null && 'is-watching')}>
      <span class="plist-seat mono" aria-label=${p.seat != null ? 'Seat ' + (p.seat + 1) : 'No seat'}>${p.seat != null ? p.seat + 1 : '–'}</span>
      <${Avatar} name=${p.name} seed=${p.seat ?? p.name} size=${34} />
      <span class="plist-who">
        <span class="plist-name">
          <span class="plist-name-text">${p.name}</span>
          ${mine && html`<span class="muted plist-you">you</span>`}
          ${p.isHost && html`<span class="plist-crown" title="Host" aria-label="Host"><${Icon} name="crown" size=${14} /></span>`}
        </span>
        <span class=${cx('plist-status', STATUS_CLASS[st.key])}>${st.label}</span>
      </span>
      ${p.seat != null &&
      html`<span class="plist-stack">
        <span class="mono brass">${fmt(p.stack)}</span>
        ${p.pendingChips > 0 && html`<span class="mono muted plist-pend">+${fmt(p.pendingChips)}</span>`}
      </span>`}
    </li>`;
  };

  return html`<div class="plist">
    <div class="log-title">
      <span>Players</span>
      <span class="muted">${seated.length} seated${watching.length ? ' · ' + watching.length + ' watching' : ''}</span>
    </div>
    ${seated.length > 0 ? html`<ul class="plist-list">${seated.map(row)}</ul>` : html`<p class="muted plist-none">Nobody is seated yet.</p>`}
    ${watching.length > 0 &&
    html`<div class="label plist-sub">Watching</div>
      <ul class="plist-list">${watching.map(row)}</ul>`}
  </div>`;
}

// ─── SessionBox ──────────────────────────────────────────────────────────────

export function SessionBox({ onBuyIn, onLeave }) {
  const room = useRoom();
  const { view, act } = room;
  const me = view.me;
  const [busy, setBusy] = useState('');
  const [waitBB, setWaitBB] = useBackPref();
  const [sdPref, setSdPref] = useShowdownPref();

  if (!me) {
    if (view.ended) return null;
    return html`<div class="session">
      <p class="muted session-hint">You’re watching. Join to chat, sit down and play.</p>
      ${room.openJoin && html`<${Button} kind="primary" class="btn-block" onClick=${() => room.openJoin()}>Join this game<//>`}
    </div>`;
  }

  const row = ledgerRowOf(view, me.id);
  const buyIns = row ? row.buyIns : 0;
  const net = row ? row.net : 0;
  const req = me.request;
  const hostName = (view.players.find((p) => p.isHost) || {}).name || 'the host';
  const needsApproval = !!view.settings.approveBuyIns && !view.isHost;
  const running = inRunningHand(view, me.id);
  const handNo = view.hand ? view.hand.no : view.handNo;

  const run = async (key, type, args) => {
    if (busy) return null;
    setBusy(key);
    const v = await act(type, args);
    setBusy('');
    return v;
  };

  const cancelRequest = async () => {
    const v = await run('cancel', 'cancelRequest', { id: req.id });
    if (v) toast('Request cancelled.', 'default');
  };

  const money = html`<div class="session-money">
    <div class="session-row"><span class="muted">Bought in</span><span class="mono">${fmt(buyIns)}</span></div>
    <div class="session-row">
      <span class="muted">${view.ended ? 'Final result' : 'Net this session'}</span>
      <span class=${cx('mono', 'session-net', net > 0 && 'pos', net < 0 && 'neg')}>${fmtSigned(net)}</span>
    </div>
  </div>`;

  const reqNote =
    req &&
    html`<div class="note session-note">
      <${Icon} name="clock" />
      <span class="session-note-text">
        ${req.kind === 'sit' ? 'Seat request' : 'Buy-in request'} for <span class="mono">${fmt(req.amount)}</span> is waiting for ${hostName}.
      </span>
      <button type="button" class="linkbtn" disabled=${!!busy} onClick=${cancelRequest}>Cancel</button>
    </div>`;

  if (view.ended) return html`<div class="session">${row && money}</div>`;

  // Spectator: no seat.
  if (me.seat == null) {
    return html`<div class="session">
      ${row && money}
      ${reqNote ||
      html`<p class="muted session-hint">You’re watching this game.</p>
        <${Button} kind="primary" class="btn-block" onClick=${onBuyIn}><${Icon} name="seat" />Take a seat<//>`}
    </div>`;
  }

  const buyLabel = me.busted ? (needsApproval ? 'Request a buy-in' : 'Buy back in') : needsApproval ? 'Request a buy-in' : 'Add chips';

  const showdownSelect = html`<label class="session-pref">
    <span class="muted">At showdown, when I lose</span>
    <select class="field" value=${sdPref} onChange=${(e) => setSdPref(e.target.value)}>
      ${SHOWDOWN_PREFS.map((o) => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}
    </select>
  </label>`;

  return html`<div class="session">
    ${money}
    ${showdownSelect}
    ${me.pendingChips > 0 &&
    html`<div class="note note-plain session-note"><${Icon} name="chips" /><span class="session-note-text"><span class="mono">${fmt(me.pendingChips)}</span> chips arrive when this hand ends.</span></div>`}
    ${reqNote || (!me.leaveAfterHand && html`<${Button} kind=${me.busted ? 'primary' : 'default'} class="btn-block" onClick=${onBuyIn}>${buyLabel}<//>`)}
    ${me.away &&
    html`<div class="session-opts" role="radiogroup" aria-label="When I come back">
      <div class="session-opts-title">When I come back</div>
      <label class="session-opt">
        <input type="radio" name="felt-back" checked=${waitBB} onChange=${() => setWaitBB(true)} />
        <span>Wait for the big blind</span>
      </label>
      <label class="session-opt">
        <input type="radio" name="felt-back" checked=${!waitBB} onChange=${() => setWaitBB(false)} />
        <span>Play the next hand</span>
      </label>
    </div>`}
    ${me.leaveAfterHand
      ? html`<div class="note note-danger session-note">
            <${Icon} name="leave" />
            <span class="session-note-text">${me.removedByHost
              ? html`The host removed you — you’ll be cashed out when hand <span class="mono">#${handNo}</span> ends.`
              : html`You’ll stand up when hand <span class="mono">#${handNo}</span> ends.`}</span>
          </div>
          ${!me.removedByHost && html`<${Button} class="btn-block" disabled=${!!busy} onClick=${() => run('stay', 'cancelLeave', {})}>Stay seated<//>`}`
      : html`<div class="session-pair">
          ${me.away
            ? html`<${Button} kind="primary" disabled=${!!busy} aria-pressed="true" onClick=${() => run('away', 'away', { on: false, waitForBB: waitBB })}>
                <${Icon} name="play" size=${16} />I’m back
              <//>`
            : html`<${Button} disabled=${!!busy} aria-pressed="false" onClick=${() => run('away', 'away', { on: true })}>
                <${Icon} name="clock" size=${16} />Away
              <//>`}
          <${Button} kind="danger" onClick=${onLeave}><${Icon} name="leave" size=${16} />Leave seat<//>
        </div>`}
    ${!me.away &&
    !me.leaveAfterHand &&
    running &&
    html`<label class="session-check">
      <input
        type="checkbox"
        checked=${!!me.awayAfterHand}
        disabled=${!!busy}
        onChange=${(e) => run('after', 'away', e.target.checked ? { on: true, afterHand: true } : { on: false })}
      />
      <span>Away after this hand<span class="muted session-check-sub">Finish hand <span class="mono">#${handNo}</span>, then sit out</span></span>
    </label>`}
    ${me.away &&
    html`<p class="muted session-hint">
      ${me.awayBy === 'host' ? 'The host set you away. ' : me.awayBy === 'timeout' ? 'You timed out and were set away. ' : ''}You skip hands and blinds; your seat and chips stay until you return.
    </p>`}
  </div>`;
}

// ─── SidePanel ───────────────────────────────────────────────────────────────

const TABS = [
  { key: 'hand', label: 'Hand' },
  { key: 'chat', label: 'Chat' },
  { key: 'players', label: 'Players' },
];

export function SidePanel({ onBuyIn, onLeave }) {
  const { view } = useRoom();
  const [tab, setTabState] = useState(() => {
    const t = store.get('felt:sideTab');
    return TABS.some((x) => x.key === t) ? t : 'hand';
  });
  const setTab = (t) => {
    setTabState(t);
    store.set('felt:sideTab', t);
  };

  // Unread chat: messages from others newer than what was on screen while the Chat tab was open.
  const msgs = view.chat || [];
  const lastId = msgs.length ? msgs[msgs.length - 1].id : 0;
  const [seen, setSeen] = useState(lastId);
  useEffect(() => {
    if (tab === 'chat') setSeen(lastId);
  }, [tab, lastId]);
  const meId = view.me ? view.me.id : null;
  const unread = tab !== 'chat' && msgs.some((m) => m.id > seen && m.pid !== meId);

  const tablist = useRef(null);
  const onKey = (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = TABS.findIndex((t) => t.key === tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length].key;
    setTab(next);
    const btn = tablist.current && tablist.current.querySelector('[data-tab="' + next + '"]');
    if (btn) btn.focus();
  };

  let body;
  if (tab === 'chat') body = html`<${Chat} />`;
  else if (tab === 'players') body = html`<${PlayersList} />`;
  else body = html`<${HandLog} />`;

  return html`<div class=${cx('panel', 'side', 'side-' + tab)}>
    <div class="side-tabs" role="tablist" aria-label="Side panel" ref=${tablist} onKeyDown=${onKey}>
      ${TABS.map(
        (t) => html`<button
          key=${t.key}
          type="button"
          role="tab"
          data-tab=${t.key}
          id=${'side-tab-' + t.key}
          aria-selected=${tab === t.key}
          aria-controls="side-body"
          tabindex=${tab === t.key ? 0 : -1}
          class=${cx('side-tab', tab === t.key && 'on')}
          onClick=${() => setTab(t.key)}
        >
          ${t.label}
          ${t.key === 'chat' && unread && html`<span class="side-dot" aria-label="unread messages"></span>`}
          ${t.key === 'players' && html`<span class="side-count mono">${(view.players || []).filter((p) => p.seat != null).length}</span>`}
        </button>`,
      )}
    </div>
    <div class="side-body" id="side-body" role="tabpanel" aria-labelledby=${'side-tab-' + tab}>${body}</div>
    ${(view.me || !view.ended) && html`<div class="side-session"><${SessionBox} onBuyIn=${onBuyIn} onLeave=${onLeave} /></div>`}
  </div>`;
}
