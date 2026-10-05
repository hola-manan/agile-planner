// public/js/main.js — App shell: router (lobby vs room), the room page layout, dialogs and sheets
// (SPEC §11, §12). Desktop per design/Main.dc.html, phone per design/Mobile.dc.html.
//
// Structure
//   App           → Lobby (no ?room=) | RoomPage (?room=CODE) + <Toasts />
//   RoomPage      → useRoomData(code) → <RoomContext.Provider value=room> → <RoomLayout />
//   RoomLayout    → reads EVERYTHING from RoomContext (no data hooks), so dev/preview.html can mount
//                   it with a fixture view. Owns UI state only: dialogs, modals, the mobile menu.
//                   Re-provides RoomContext with openers added:
//                     openBuyIn(seat|null), openLeave(), openLedger(), openHostTools(), openJoin(),
//                     openPanel('log'|'chat'|'players'|'ledger'|'host'), closePanel()
import { html, useState, useEffect, useMemo, useCallback, Fragment, ReactDOM } from './h.js';
import { useRoomData, useRoom, RoomContext } from './room.js';
import { clearSession, getSession, normalizeCode, isValidCode } from './api.js';
import { Button, Pill, Icon, Logo, Modal, Switch, Toasts, useIsMobile, useFourColor, toast, copyText, inviteUrl, navigate, cx, fmt } from './ui.js';
import { BuyInDialog, LeaveDialog, JoinPrompt } from './dialogs.js';
import { Lobby } from './lobby.js';
import { Table } from './table.js';
import { ActionBar } from './actionbar.js';
import { SidePanel, HandLog, Chat, PlayersList, SessionBox } from './side.js';
import { HostTools } from './host.js';
import { Ledger } from './ledger.js';

const VARIANT_LONG = { NLH: 'No-Limit Hold’em', PLO: 'Pot-Limit Omaha' };
const VARIANT_SHORT = { NLH: 'NLH', PLO: 'PLO' };

// ─── router ──────────────────────────────────────────────────────────────────

function roomFromLocation() {
  const raw = new URLSearchParams(location.search).get('room');
  return raw ? normalizeCode(raw) : null;
}

export function App() {
  const [code, setCode] = useState(roomFromLocation);
  useEffect(() => {
    const on = () => {
      setCode(roomFromLocation());
      window.scrollTo(0, 0);
    };
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return html`<${Fragment}>
    ${code ? html`<${RoomPage} key=${code} code=${code} />` : html`<${Lobby} />`}
    <${Toasts} />
  <//>`;
}

// ─── room page (data) ────────────────────────────────────────────────────────

export function RoomPage({ code }) {
  if (!isValidCode(code)) return html`<${NotFound} code=${code} />`;
  return html`<${LiveRoom} code=${code} />`;
}

function LiveRoom({ code }) {
  const room = useRoomData(code);
  const notFound = !!(room.error && (room.error.code === 'not_found' || room.error.status === 404));

  useEffect(() => {
    // A stored session for a room that no longer exists only clutters the lobby's list.
    if (notFound && getSession(code)) clearSession(code);
  }, [notFound, code]);

  if (notFound) return html`<${NotFound} code=${code} />`;
  if (!room.view) {
    if (room.error) return html`<${LoadError} error=${room.error} onRetry=${room.refresh} />`;
    return html`<${Loading} />`;
  }
  return html`<${RoomContext.Provider} value=${room}><${RoomLayout} /><//>`;
}

function Loading() {
  return html`<div class="shell-screen" aria-busy="true">
    <div class="shell-loading"><${Logo} size=${40} word=${false} /><span>Finding your table…</span></div>
  </div>`;
}

function NotFound({ code }) {
  useEffect(() => {
    document.title = 'Game not found · Felt';
  }, []);
  return html`<div class="shell-screen">
    <div class="panel shell-card">
      <div class="shell-mark"><${Icon} name="spade" size=${30} /></div>
      <h1>No game here</h1>
      <p class="muted">
        ${isValidCode(code)
          ? html`We couldn’t find a table with the code <span class="mono brass">${code}</span>. Check the invite link with your host — the code may have been mistyped.`
          : html`That doesn’t look like a room code. Codes look like <span class="mono brass">RVR-4821</span>.`}
      </p>
      <${Button} kind="primary" size="lg" onClick=${() => navigate('/')}>Back to the lobby<//>
    </div>
  </div>`;
}

function LoadError({ error, onRetry }) {
  return html`<div class="shell-screen">
    <div class="panel shell-card">
      <div class="shell-mark"><${Icon} name="alert" size=${30} /></div>
      <h1>Can’t reach the table</h1>
      <p class="muted">${(error && error.message) || 'Something went wrong.'}</p>
      <div class="shell-actions">
        <${Button} onClick=${() => navigate('/')}>Lobby<//>
        <${Button} kind="primary" onClick=${onRetry}>Try again<//>
      </div>
    </div>
  </div>`;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function handLabel(view) {
  const no = view.hand ? view.hand.no : view.handNo;
  return no ? '#' + no : null;
}

function blinds(view) {
  const h = view.hand;
  const sb = h ? h.sb : view.settings.sb;
  const bb = h ? h.bb : view.settings.bb;
  return fmt(sb) + '/' + fmt(bb);
}

function variantOf(view) {
  return (view.hand && view.hand.variant) || view.settings.variant;
}

async function copyInvite(code) {
  const ok = await copyText(inviteUrl(code));
  toast(ok ? 'Invite link copied — send it to the table.' : 'Couldn’t copy. The link is ' + inviteUrl(code), ok ? 'pos' : 'default');
}

/** Keep the tab title useful: game name, and a nudge when it's your turn. */
function useDocTitle(view) {
  const myTurn = !!(view && view.me && view.hand && view.hand.toAct === view.me.id && view.hand.phase === 'betting');
  const vote = !!(view && view.me && view.hand && view.hand.ritVote && view.hand.ritVote.voters.includes(view.me.id) && view.hand.ritVote.votes[view.me.id] == null);
  const name = view ? view.name : '';
  useEffect(() => {
    if (!name) return;
    document.title = (myTurn ? '● Your turn · ' : vote ? '● Vote · ' : '') + name + ' · Felt';
  }, [name, myTurn, vote]);
}

// ─── header pieces ───────────────────────────────────────────────────────────

function FourColorToggle({ compact }) {
  const [four, setFour] = useFourColor();
  return html`<button
    type="button"
    class=${cx('btn', 'deck-toggle', compact && 'btn-sm')}
    aria-pressed=${four}
    aria-label=${four ? 'Four-colour deck on — switch to two colours' : 'Two-colour deck — switch to four colours'}
    title=${four ? 'Four-colour deck' : 'Two-colour deck'}
    onClick=${() => setFour(!four)}
  >
    <span class="deck-suits" aria-hidden="true"><span class="ds-s">♠︎</span><span class="ds-h">♥︎</span><span class="ds-d">♦︎</span><span class="ds-c">♣︎</span></span>
  </button>`;
}

function CodePill({ code }) {
  return html`<button type="button" class="pill mono room-code" title="Copy invite link" aria-label=${'Room code ' + code + ' — copy invite link'} onClick=${() => copyInvite(code)}>
    ${code}<${Icon} name="copy" size=${13} />
  </button>`;
}

function DesktopHeader({ view, onLedger, onHost }) {
  const pending = view.isHost ? (view.requests || []).length : 0;
  const no = handLabel(view);
  return html`<header class="room-head">
    <div class="room-head-left">
      <a
        href="/"
        class="room-logo"
        aria-label="Felt — back to the lobby"
        onClick=${(e) => {
          if (e.metaKey || e.ctrlKey) return;
          e.preventDefault();
          navigate('/');
        }}
      ><${Logo} size=${28} /></a>
      <div class="room-head-div" aria-hidden="true"></div>
      <div class="room-title">
        <span class="room-name">${view.name}</span>
        <span class="muted room-sub">
          ${VARIANT_LONG[variantOf(view)] || variantOf(view)} · Blinds <span class="mono">${blinds(view)}</span>${no
            ? html` · Hand <span class="mono">${no}</span>`
            : ' · Waiting to deal'}
        </span>
      </div>
      <${CodePill} code=${view.code} />
      ${view.paused && !view.ended && html`<${Pill} tone="brass"><${Icon} name="pause" size=${12} />Paused<//>`}
    </div>
    <nav class="room-nav" aria-label="Game">
      <${Button} onClick=${onLedger}><${Icon} name="ledger" />Ledger<//>
      ${view.isHost &&
      html`<${Button} onClick=${onHost} aria-label=${'Host tools' + (pending ? ', ' + pending + ' pending' : '')}>
        <${Icon} name="crown" />Host tools${pending > 0 && html`<span class="badge">${pending}</span>`}
      <//>`}
      <${FourColorToggle} />
    </nav>
  </header>`;
}

function MobileHeader({ view, onMenu, onLedger }) {
  const pending = view.isHost ? (view.requests || []).length : 0;
  const no = handLabel(view);
  return html`<header class="room-mhead">
    <button type="button" class="btn btn-ghost btn-icon room-mbtn" aria-label=${'Menu' + (pending ? ', ' + pending + ' requests waiting' : '')} onClick=${onMenu}>
      <${Icon} name="menu" size=${20} />
      ${pending > 0 && html`<span class="room-mdot" aria-hidden="true"></span>`}
    </button>
    <div class="room-mtitle">
      <div class="room-mname">${view.name}</div>
      <div class="muted room-msub">
        ${VARIANT_SHORT[variantOf(view)] || variantOf(view)} <span class="mono">${blinds(view)}</span>${no ? html` · Hand <span class="mono">${no}</span>` : ' · Waiting'}
      </div>
    </div>
    <button type="button" class="btn btn-ghost btn-icon room-mbtn" aria-label="Ledger" onClick=${onLedger}><${Icon} name="ledger" size=${20} /></button>
  </header>`;
}

// ─── status banners ──────────────────────────────────────────────────────────

function StatusBanner({ view, act, compact }) {
  if (view.ended) return null;
  const host = view.isHost;
  let text = null;
  let action = null;
  if (view.endAfterHand) text = 'The host is ending the game after this hand.';
  else if (view.paused) {
    text = host ? 'The game is paused — no new hands will be dealt.' : 'The host paused the game. No new hands until they resume.';
    if (host) action = html`<${Button} size="sm" kind="primary" onClick=${() => act('pause', { on: false })}><${Icon} name="play" size=${14} />Resume<//>`;
  } else if (view.pauseAfterHand) {
    text = 'Pausing after this hand.';
    if (host) action = html`<${Button} size="sm" onClick=${() => act('pause', { on: false })}>Keep playing<//>`;
  }
  if (!text) return null;
  return html`<div class=${cx('room-banner', compact && 'room-banner-m')} role="status">
    <${Icon} name=${view.paused ? 'pause' : 'clock'} size=${16} />
    <span class="room-banner-text">${text}</span>
    ${action}
  </div>`;
}

function EndedBanner({ view, compact }) {
  const t = view.ledger && view.ledger.totals;
  return html`<div class=${cx('panel', 'room-ended', compact && 'room-ended-m')}>
    <div class="room-ended-icon"><${Icon} name="check" size=${22} /></div>
    <div class="room-ended-text">
      <h2>This game has ended</h2>
      <p class="muted">
        Everyone was cashed out${t && t.hands ? html` after <span class="mono">${fmt(t.hands)}</span> hands` : ''}. The ledger below is final — settle up and you’re done.
      </p>
    </div>
    <${Button} onClick=${() => navigate('/')}>New game<//>
  </div>`;
}

// ─── mobile menu ─────────────────────────────────────────────────────────────

function MenuItem({ icon, label, onClick, badge, sub }) {
  return html`<button type="button" class="menu-item" onClick=${onClick}>
    <span class="menu-icon"><${Icon} name=${icon} size=${20} /></span>
    <span class="menu-label">${label}${sub && html`<span class="muted menu-sub">${sub}</span>`}</span>
    ${badge > 0 && html`<span class="badge">${badge}</span>`}
    <${Icon} name="chevron" size=${18} class="menu-go" />
  </button>`;
}

function MenuSheet({ open, onClose, view, openPanel, onBuyIn, onLeave, onJoin }) {
  const [four, setFour] = useFourColor();
  const me = view.me;
  const pending = view.isHost ? (view.requests || []).length : 0;
  const seated = (view.players || []).filter((p) => p.seat != null).length;
  const go = (p) => () => {
    onClose();
    openPanel(p);
  };
  return html`<${Modal} open=${open} onClose=${onClose} label="Menu">
    <div class="menu">
      <div class="menu-room">
        <div style=${{ minWidth: 0 }}>
          <div class="menu-room-name">${view.name}</div>
          <div class="muted menu-room-sub">Room <span class="mono">${view.code}</span></div>
        </div>
        <${Button} size="sm" onClick=${() => copyInvite(view.code)}><${Icon} name="link" size=${16} />Invite<//>
      </div>
      <div class="menu-list">
        <${MenuItem} icon="history" label="Hand log" sub=${handLabel(view) ? 'Hand ' + handLabel(view) : null} onClick=${go('log')} />
        <${MenuItem} icon="chat" label="Chat" sub=${(view.chat || []).length ? (view.chat || []).length + ((view.chat || []).length === 1 ? ' message' : ' messages') : null} onClick=${go('chat')} />
        <${MenuItem} icon="users" label="Players" sub=${seated + ' seated'} onClick=${go('players')} />
        <${MenuItem} icon="ledger" label="Ledger" onClick=${go('ledger')} />
        ${view.isHost && html`<${MenuItem} icon="crown" label="Host tools" badge=${pending} sub=${pending ? pending + ' waiting for you' : null} onClick=${go('host')} />`}
      </div>
      ${me && me.seat != null && !view.ended
        ? html`<div class="menu-session">
            <div class="label">Your session</div>
            <${SessionBox}
              onBuyIn=${() => {
                onClose();
                onBuyIn(null);
              }}
              onLeave=${() => {
                onClose();
                onLeave();
              }}
            />
          </div>`
        : !view.ended &&
          html`<div class="menu-session">
            ${me
              ? html`<${Button} kind="primary" class="btn-block" onClick=${() => {
                  onClose();
                  onBuyIn(null);
                }}><${Icon} name="seat" />Take a seat<//>`
              : html`<${Button} kind="primary" class="btn-block" onClick=${() => {
                  onClose();
                  onJoin();
                }}>Join this game<//>`}
          </div>`}
      <div class="menu-prefs">
        <label class="menu-pref">
          <span>
            <span class="menu-pref-title">Four-colour deck</span>
            <span class="muted menu-pref-sub">♦ blue, ♣ green</span>
          </span>
          <${Switch} label="Four-colour deck" checked=${four} onChange=${setFour} />
        </label>
      </div>
      <${Button} kind="ghost" class="btn-block menu-lobby" onClick=${() => navigate('/')}><${Icon} name="home" size=${18} />Back to the lobby<//>
    </div>
  <//>`;
}

// ─── layout ──────────────────────────────────────────────────────────────────

const PANEL_TITLES = { ledger: 'Ledger', host: 'Host tools', log: 'Hand log', chat: 'Chat', players: 'Players' };

/**
 * The whole room screen. Reads { view, act, joined, ... } from RoomContext; owns only UI state.
 * Props (all optional, used by the dev preview): initialPanel, initialDialog ('buyin'|'leave'|'menu'|'join').
 */
export function RoomLayout({ initialPanel = null, initialDialog = null } = {}) {
  const room = useRoom();
  const view = room.view;
  const act = room.act;
  const mobile = useIsMobile();

  const [buyIn, setBuyIn] = useState(initialDialog === 'buyin' ? { seat: null } : null); // { seat } | null
  const [leaveOpen, setLeaveOpen] = useState(initialDialog === 'leave');
  const [menuOpen, setMenuOpen] = useState(initialDialog === 'menu');
  const [panel, setPanel] = useState(initialPanel); // 'ledger' | 'host' | 'log' | 'chat' | 'players' | null
  const [joinOpen, setJoinOpen] = useState(initialDialog === 'join' || !room.joined);

  useDocTitle(view);

  // A visitor who joins (or a joined player) never needs the join prompt again.
  useEffect(() => {
    if (room.joined) setJoinOpen(false);
  }, [room.joined]);

  // Mobile-only panels make no sense on desktop (they're in the side panel there).
  const effectivePanel = !mobile && (panel === 'log' || panel === 'chat' || panel === 'players') ? null : panel;

  const openBuyIn = useCallback(
    (seat = null) => {
      if (!room.view || !room.view.me) {
        setJoinOpen(true);
        return;
      }
      setBuyIn({ seat: typeof seat === 'number' ? seat : null });
    },
    [room.view],
  );
  const openLeave = useCallback(() => setLeaveOpen(true), []);
  const openJoin = useCallback(() => setJoinOpen(true), []);
  const openPanel = useCallback((p) => setPanel(p), []);
  const closePanel = useCallback(() => setPanel(null), []);
  const openLedger = useCallback(() => setPanel('ledger'), []);
  const openHostTools = useCallback(() => setPanel('host'), []);

  const value = useMemo(
    () => ({ ...room, openBuyIn, openLeave, openJoin, openPanel, closePanel, openLedger, openHostTools, isMobile: mobile }),
    [room, openBuyIn, openLeave, openJoin, openPanel, closePanel, openLedger, openHostTools, mobile],
  );

  const onSit = (seat) => openBuyIn(seat);
  const onBuyIn = () => openBuyIn(null);

  let panelBody = null;
  let panelSub = null;
  if (effectivePanel === 'ledger') {
    panelBody = html`<${Ledger} />`;
    panelSub = view.name + (view.handNo ? ' · after hand #' + view.handNo : '');
  } else if (effectivePanel === 'host') {
    panelBody = view.isHost ? html`<${HostTools} />` : html`<p class="muted">Only the host can use these tools.</p>`;
    panelSub = view.name + ' · room ' + view.code;
  } else if (effectivePanel === 'log') panelBody = html`<${HandLog} />`;
  else if (effectivePanel === 'chat') panelBody = html`<${Chat} />`;
  else if (effectivePanel === 'players') panelBody = html`<${PlayersList} />`;

  const overlays = html`
    <${Modal}
      open=${!!effectivePanel}
      onClose=${closePanel}
      wide=${true}
      title=${PANEL_TITLES[effectivePanel] || ''}
      subtitle=${panelSub}
      class=${cx('room-modal', effectivePanel && 'room-modal-' + effectivePanel)}
    >${panelBody}<//>
    ${mobile &&
    html`<${MenuSheet}
      open=${menuOpen}
      onClose=${() => setMenuOpen(false)}
      view=${view}
      openPanel=${openPanel}
      onBuyIn=${openBuyIn}
      onLeave=${openLeave}
      onJoin=${openJoin}
    />`}
    <${BuyInDialog} open=${!!buyIn} seat=${buyIn ? buyIn.seat : null} onClose=${() => setBuyIn(null)} />
    <${LeaveDialog} open=${leaveOpen} onClose=${() => setLeaveOpen(false)} />
    ${!room.joined && !view.ended && html`<${JoinPrompt} open=${joinOpen} onClose=${() => setJoinOpen(false)} />`}
  `;

  if (mobile) {
    return html`<${RoomContext.Provider} value=${value}>
      <div class=${cx('room', 'room-m', view.ended && 'room-is-ended')}>
        <${MobileHeader} view=${view} onMenu=${() => setMenuOpen(true)} onLedger=${openLedger} />
        <${StatusBanner} view=${view} act=${act} compact=${true} />
        ${view.ended
          ? html`<div class="room-m-ended">
              <${EndedBanner} view=${view} compact=${true} />
              <${Ledger} />
            </div>`
          : html`
              <div class="room-m-table"><${Table} onSit=${onSit} /></div>
              <div class="room-m-dock"><${ActionBar} onBuyIn=${onBuyIn} onLeave=${openLeave} onSit=${onSit} /></div>
            `}
      </div>
      ${overlays}
    <//>`;
  }

  return html`<${RoomContext.Provider} value=${value}>
    <div class=${cx('room', 'room-d', view.ended && 'room-is-ended')}>
      <${DesktopHeader} view=${view} onLedger=${openLedger} onHost=${openHostTools} />
      <main class="room-main">
        <section class="room-play" aria-label="Table">
          <${StatusBanner} view=${view} act=${act} />
          ${view.ended
            ? html`<${EndedBanner} view=${view} />
                <div class="panel room-ended-ledger"><${Ledger} /></div>`
            : html`<${Table} onSit=${onSit} />
                <${ActionBar} onBuyIn=${onBuyIn} onLeave=${openLeave} onSit=${onSit} />`}
        </section>
        <aside class="room-side" aria-label="Hand log, chat and players">
          <${SidePanel} onBuyIn=${onBuyIn} onLeave=${openLeave} />
        </aside>
      </main>
    </div>
    ${overlays}
  <//>`;
}

// ─── mount ───────────────────────────────────────────────────────────────────

export function mount(el = document.getElementById('root')) {
  if (!el) return null;
  const root = ReactDOM.createRoot(el);
  root.render(html`<${App} />`);
  return root;
}

// The dev preview (dev/preview.html) imports this module for RoomLayout and mounts it itself.
if (!window.FELT_NO_MOUNT) mount();
