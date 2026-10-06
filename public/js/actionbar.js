// public/js/actionbar.js — the bar under the table (desktop) / bottom dock (phone). SPEC §11.
//
//   <ActionBar onBuyIn={() => …} onLeave={() => …} onSit={(seat|null) => …} />
//
// One component, one state at a time (first match wins):
//   visitor → spectator (pick a seat / seat request pending; + Reveal the runout when allowed) →
//   away (unless a finished hand still offers me show / reveal — then hand complete with an
//   away notice) → my turn → run-it vote → runout → hand complete (show cards, reveal runout,
//   next-hand countdown) → busted → waiting (someone else's turn / sitting out / no hand yet).
// A "leaving / going away after this hand" notice is stacked on top of any state.
//
// Keyboard (one document listener here; the decisions are pure, in hotkeys.js — SPEC §11):
//   my turn      F fold · C call/check · K check · R raise amount · A/G call/check · I check/fold
//   waiting      I Check/Fold · A Call any · G Call current — pre-actions, also buttons (desktop + phone)
//   hand over    S show all my cards · 1–4 show one
//   anywhere     ? the cheat sheet (room.openShortcuts)
// Ignored while typing, while a dialog/sheet is open, with Ctrl/Meta/Alt and on key repeat.
import { html, useState, useEffect, useRef, useMemo, useCallback, Fragment } from './h.js';
import { useRoom, useClock, serverNow } from './room.js';
import { Button, Avatar, Icon, cx, fmt, cardText, countdownText, useIsMobile, toast } from './ui.js';
import { PRE_KEYS, PRE_KINDS, canPreAct, decidePreAction, decideTurnKey, ignoreKeyEvent, normKey, preLabel, showKey, togglePreAction } from './hotkeys.js';
import { useShowPick, runWord } from './table.js';
import { useBackPref, useShowdownPref } from './side.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const VOTE_LABEL = { 1: 'Once', 2: 'Twice', 3: '3×' };

function nameOf(view, pid) {
  if (view.me && pid === view.me.id) return 'You';
  const p = (view.players || []).find((x) => x.id === pid);
  return p ? p.name : 'Someone';
}

function seatOf(view, pid) {
  const p = (view.players || []).find((x) => x.id === pid);
  return p ? p.seat : null;
}

/** CSS-driven drain (width) for a timer bar, computed once per deadline. */
function useDrainStyle(deadline, total) {
  return useMemo(() => {
    if (!deadline || !total) return null;
    const left = clamp(deadline - serverNow(), 0, total);
    return { animationDuration: total + 'ms', animationDelay: -(total - left) + 'ms' };
  }, [deadline, total]);
}

function TimerBar({ deadline, total, thin }) {
  const style = useDrainStyle(deadline, total);
  return html`<div class=${cx('timer', thin && 'timer-thin')} aria-hidden="true">
    ${style && html`<div key=${deadline} class="timer-fill" style=${style}></div>`}
  </div>`;
}

/** A tiny keycap hint on a desktop button (not part of the button's accessible name). */
function Kc({ k }) {
  return html`<kbd class="kc" aria-hidden="true">${k}</kbd>`;
}

// ─── my turn ─────────────────────────────────────────────────────────────────

function TurnControls({ view, act, busy, mobile, now, focusRef }) {
  const hand = view.hand;
  const me = view.me;
  const legal = hand.legal;
  const hp = hand.players.find((p) => p.pid === me.id);
  const myBet = hp ? hp.bet : 0;
  const allInTo = myBet + me.stack;
  const canRaise = !!legal.raise && legal.maxTo > 0;
  const onlyAllIn = canRaise && legal.minTo === legal.maxTo;
  const opening = hand.currentBet === 0;
  const plo = hand.variant === 'PLO';

  const resetKey = hand.no + '|' + hand.street + '|' + legal.minTo + '|' + legal.maxTo;
  const [amt, setAmt] = useState(legal.minTo);
  const [text, setText] = useState(String(legal.minTo));
  useEffect(() => {
    setAmt(legal.minTo);
    setText(String(legal.minTo));
  }, [resetKey]);
  const inputRef = useRef(null);

  const setTo = (v) => {
    const x = clamp(Math.round(Number(v) || 0), legal.minTo, legal.maxTo);
    setAmt(x);
    setText(String(x));
  };

  // presets: fraction of the pot after calling, as a "raise to" total
  const realCall = Math.max(0, hand.currentBet - myBet);
  const potAfterCall = hand.potTotal + realCall;
  const frac = (f) => clamp(Math.round(hand.currentBet + f * potAfterCall), legal.minTo, legal.maxTo);
  const maxLabel = legal.maxTo >= allInTo ? 'All-in' : plo ? 'Max' : 'All-in';
  const potPreset = plo ? legal.potTo : frac(1);
  const presetsAll = canRaise && !onlyAllIn
    ? (mobile
        ? [['Min', legal.minTo], ['½ pot', frac(0.5)], ['Pot', plo ? legal.potTo : frac(1)], [maxLabel, legal.maxTo]]
        : [['Min', legal.minTo], ['½ pot', frac(0.5)], ['¾ pot', frac(0.75)], ['Pot', plo ? legal.potTo : frac(1)], [maxLabel, legal.maxTo]])
    : [];
  // PLO: the max raise is usually the pot — don't show the same number twice
  const presets = presetsAll.filter(([label, v]) => !(plo && label === 'Max' && v === potPreset));

  const to = clamp(Math.round(amt) || legal.minTo, legal.minTo, legal.maxTo);
  const isAllIn = to >= allInTo;
  const raiseWord = isAllIn ? 'All-in' : opening ? 'Bet' : 'Raise';

  const fold = () => !busy && act('act', { move: 'fold' });
  const checkCall = () => !busy && act('act', legal.check ? { move: 'check' } : { move: 'call' });
  const raise = () => !busy && canRaise && act('act', { move: 'raise', to });

  // R (the bar's key handler): focus + select the amount; with only an all-in left, the button.
  const rootRef = useRef(null);
  if (focusRef) {
    focusRef.current = () => {
      const input = inputRef.current;
      if (input && !input.disabled) {
        input.focus();
        if (input.select) input.select();
        return;
      }
      const root = rootRef.current;
      const go = root && root.querySelector('.raise-go, .abar-grid .btn-primary');
      if (go && !go.disabled) go.focus();
    };
  }
  const deadline = view.deadlineKind === 'action' ? view.deadline : null;
  const total = (view.settings.actionTime || 25) * 1000;
  const secs = countdownText(deadline, now);
  const low = deadline && deadline - now < 5000;

  const callLabel = legal.check
    ? 'Check'
    : html`${legal.call >= me.stack ? 'Call all-in' : 'Call'} <span class="mono">${fmt(legal.call)}</span>`;

  const onIdx = presets.findIndex(([, v]) => v === to);
  const presetBtns = presets.map(
    ([label, v], i) => html`<button
      type="button"
      key=${label}
      class=${cx('preset', i === onIdx && 'on')}
      aria-pressed=${i === onIdx}
      disabled=${busy}
      onClick=${() => setTo(v)}
    >${label}${!mobile && html` <span class="mono">${fmt(v)}</span>`}</button>`,
  );

  const slider = canRaise && !onlyAllIn
    ? html`<input
        type="range"
        class="raise-range"
        min=${legal.minTo}
        max=${legal.maxTo}
        step="1"
        value=${to}
        aria-label=${(opening ? 'Bet' : 'Raise to') + ' amount'}
        onInput=${(e) => setTo(e.target.value)}
        onChange=${(e) => setTo(e.target.value)}
      />`
    : null;

  const numInput = html`<input
    ref=${inputRef}
    class="raise-num mono"
    type="text"
    inputmode="numeric"
    aria-label=${(opening ? 'Bet' : 'Raise to') + ' amount'}
    value=${text}
    disabled=${onlyAllIn}
    onInput=${(e) => {
      const raw = e.target.value.replace(/[^0-9]/g, '');
      setText(raw);
      if (raw) setAmt(Number(raw));
    }}
    onBlur=${() => setTo(text || legal.minTo)}
    onKeyDown=${(e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setTo(text || legal.minTo);
        raise();
      } else if (e.key === 'Escape') {
        e.currentTarget.blur();
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        setTo(to + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? hand.bb * 5 : hand.bb));
      }
    }}
  />`;

  if (mobile) {
    return html`<div class="abar-body abar-in" ref=${rootRef}>
      <div class="abar-mline">
        <span class="abar-me"><b>You</b> · <span key=${'stack-' + me.stack} class="mono brass num-bump">${fmt(me.stack)}</span>${me.handName && html` · ${me.handName}`}</span>
        <span class=${cx('mono', 'muted', low && 'abar-low')}>${secs}</span>
      </div>
      <${TimerBar} deadline=${deadline} total=${total} thin />
      ${presetBtns.length > 0 && html`<div class="presets presets-m">${presetBtns}</div>`}
      ${slider && html`<div class="raise-m">${slider}${numInput}</div>`}
      <div class="abar-grid">
        <${Button} kind="danger" disabled=${busy} onClick=${fold}>Fold<//>
        <${Button} disabled=${busy} onClick=${checkCall}>${callLabel}<//>
        <${Button} kind="primary" disabled=${busy || !canRaise} onClick=${raise}>
          ${canRaise ? html`${raiseWord} <span class="mono">${fmt(to)}</span>` : 'Raise'}
        <//>
      </div>
    </div>`;
  }

  return html`<div class="abar-body abar-in" ref=${rootRef}>
    <div class="abar-top">
      <div class="abar-turn">
        <span class="abar-title">Your turn</span>
        <${TimerBar} deadline=${deadline} total=${total} />
        <span class=${cx('mono', 'muted', 'abar-secs', low && 'abar-low')}>${secs}</span>
      </div>
      ${presetBtns.length > 0 && html`<div class="presets">${presetBtns}</div>`}
    </div>
    <div class="abar-acts">
      <${Button} kind="danger" class="act-btn act-fold" disabled=${busy} onClick=${fold} title="Fold (F)" aria-keyshortcuts="F">Fold<${Kc} k="F" /><//>
      <${Button} class="act-btn act-call" disabled=${busy} onClick=${checkCall} title=${legal.check ? 'Check (K)' : 'Call (C)'} aria-keyshortcuts=${legal.check ? 'K C' : 'C'}>${callLabel}<${Kc} k=${legal.check ? 'K' : 'C'} /><//>
      ${canRaise
        ? html`<div class="raise-box">
            <span class="label raise-label">${opening ? 'Bet' : 'Raise to'}</span>
            ${slider || html`<span class="raise-only muted">Only an all-in raise is possible</span>`}
            ${numInput}
            <${Button} kind="primary" class="raise-go" disabled=${busy} onClick=${raise} title="R jumps to the amount · Enter confirms" aria-keyshortcuts="R">${raiseWord}<${Kc} k="R" /><//>
          </div>`
        : html`<div class="raise-box raise-box-off"><span class="muted">${hand.players.some((p) => p.pid !== me.id && !p.folded && !p.allIn) ? 'You can’t re-raise a short all-in' : 'Everyone else is all-in — call or fold'}</span></div>`}
    </div>
  </div>`;
}

// ─── run-it vote ─────────────────────────────────────────────────────────────

function VoteControls({ view, act, busy, mobile, now }) {
  const hand = view.hand;
  const rv = hand.ritVote;
  const me = view.me;
  const voter = !!(me && rv.voters.includes(me.id));
  const mine = voter ? rv.votes[me.id] : null;
  const opts = [1, 2, 3].filter((n) => n <= (rv.maxRuns || 1));
  const others = rv.voters.filter((pid) => !me || pid !== me.id);
  const secs = countdownText(rv.deadline, now);

  const votes = html`<div class="votes">
    ${others.map((pid) => {
      const v = rv.votes[pid];
      return html`<span key=${pid} class=${cx('vote-chip', v != null && 'vote-in')}>
        <${Avatar} name=${nameOf(view, pid)} seed=${seatOf(view, pid)} size=${22} />
        <span>${nameOf(view, pid)}</span>
        <b>${v != null ? VOTE_LABEL[v] || v + '×' : '…'}</b>
      </span>`;
    })}
  </div>`;

  return html`<div class="abar-body abar-in">
    <div class="abar-top">
      <div class="abar-turn">
        <span class="abar-title">${voter ? 'Run it how many times?' : 'All-in — the players are voting'}</span>
        ${!mobile && html`<${TimerBar} deadline=${rv.deadline} total=${12000} />`}
        <span class="mono muted abar-secs">${secs}</span>
      </div>
      ${!mobile && votes}
    </div>
    ${mobile && html`<${TimerBar} deadline=${rv.deadline} total=${12000} thin />`}
    <div class="muted abar-sub">${opts.length > 1 ? 'Everyone all-in must pick the same number — otherwise it runs once. Hands are shown once the vote is in.' : 'Running it once.'}</div>
    ${voter &&
    html`<div class=${cx('vote-opts', mobile && 'abar-grid')}>
      ${opts.map(
        (n) => html`<button
          type="button"
          key=${n}
          class=${cx('btn', 'vote-btn', mine === n && 'btn-primary')}
          aria-pressed=${mine === n}
          disabled=${busy}
          onClick=${() => act('vote', { runs: n })}
        >${VOTE_LABEL[n]}</button>`,
      )}
    </div>`}
    ${mobile && others.length > 0 && votes}
  </div>`;
}

// ─── hand complete ───────────────────────────────────────────────────────────

function resultLine(view) {
  const hand = view.hand;
  const winners = hand.players.filter((p) => p.isWinner);
  if (!winners.length) return 'Hand over';
  const me = view.me;
  const runs = (hand.results && hand.results.runs) || [];
  const hn = hand.results && hand.results.endedBy === 'showdown' && runs.length === 1 ? runs[0].handName : null;
  if (winners.length === 1) {
    const w = winners[0];
    const who = me && w.pid === me.id ? 'You win' : w.name + ' wins';
    return html`${who} <span class="mono brass">${fmt(w.won)}</span>${hn ? ' with ' + hn.charAt(0).toLowerCase() + hn.slice(1) : hand.results && hand.results.endedBy === 'fold' ? ' — everyone else folded' : ''}`;
  }
  const names = winners.map((w) => (me && w.pid === me.id ? 'You' : w.name));
  const total = winners.reduce((s, w) => s + (w.won || 0), 0);
  return html`${names.slice(0, -1).join(', ')} & ${names[names.length - 1]} split <span class="mono brass">${fmt(total)}</span>${runs.length > 1 ? ' over ' + runs.length + ' runs' : ''}`;
}

function RevealButton({ view, act, busy, mobile, now }) {
  const hand = view.hand;
  if (!hand || hand.phase !== 'complete' || !hand.canRevealRunout) return null;
  const nextIn = view.deadlineKind === 'nextHand' ? countdownText(view.deadline, now) : '';
  return html`<${Button} class=${cx('reveal-btn', mobile && 'btn-block btn-ghost reveal-m')} disabled=${busy} onClick=${() => act('revealRunout')}>
    <${Icon} name="eye" size=${18} />Reveal the runout${mobile && nextIn ? html` · <span class="mono">${nextIn}</span>` : ''}
  <//>`;
}

// Hands the "Always show" preference already showed (one automatic show per hand).
const autoShown = new Set();

function CompleteControls({ view, act, busy, mobile, now }) {
  const hand = view.hand;
  const me = view.me;
  const handKey = view.code + ':' + hand.no;
  const pick = useShowPick(handKey);
  const [sdPref] = useShowdownPref();
  const hp = me ? hand.players.find((p) => p.pid === me.id) : null;
  const hole = (me && me.hole) || [];
  const unshown = hp ? hole.map((_, i) => i).filter((i) => !hp.shown[i]) : [];
  // "At showdown, when I lose" (session box): muck = no prompt, show = show them for me.
  const lostShowdown = !!(hp && !hp.folded && !hp.isWinner && hand.results && hand.results.endedBy === 'showdown');
  const canShowNow = !!(hand.canShow && hp && unshown.length);
  useEffect(() => {
    if (sdPref === 'muck' && lostShowdown && canShowNow && !pick.hidden) pick.hide();
  }, [sdPref, lostShowdown, canShowNow, pick.hidden]);
  useEffect(() => {
    if (sdPref !== 'show' || !lostShowdown || !canShowNow || autoShown.has(handKey)) return;
    autoShown.add(handKey);
    act('show', { cards: unshown });
  }, [sdPref, lostShowdown, canShowNow, handKey]);
  const showPrompt = !!(canShowNow && !pick.hidden && !(lostShowdown && sdPref !== 'ask'));
  const sel = pick.sel.filter((i) => unshown.includes(i));
  const won = !!(hp && hp.isWinner);
  const nextIn = view.deadlineKind === 'nextHand' ? countdownText(view.deadline, now) : '';
  const after = view.endAfterHand ? 'Game ends after this hand' : view.pauseAfterHand ? 'Pausing after this hand' : null;

  const show = (idx) => {
    if (busy || !idx.length) return;
    act('show', { cards: idx });
    pick.clear();
  };
  const allWord = hole.length === 2 ? 'both' : 'all';
  const selText = sel.map((i) => cardText(hole[i])).join(' ');

  const reveal = html`<${RevealButton} view=${view} act=${act} busy=${busy} mobile=${mobile} now=${now} />`;

  const next = html`<div class="next-hand">
    ${after ? html`<span class="muted">${after}</span>` : nextIn ? html`<span class="muted">Next hand</span><span class="mono next-secs">${nextIn}</span>` : null}
  </div>`;

  if (mobile) {
    return html`<div class="abar-body abar-in">
      ${showPrompt
        ? html`<div class="abar-mline">
              <span class="abar-title">${won && hand.results && hand.results.endedBy === 'fold' ? 'You won · show your cards?' : 'Show your hand?'}</span>
              <span class="muted abar-hint">${sel.length ? 'Tap cards to change' : 'Tap a card to pick one'}</span>
            </div>
            <div class=${cx('abar-grid', !sel.length && 'abar-grid-2')}>
              <${Button} class="btn-ghost-outline" disabled=${busy} onClick=${() => pick.hide()}>Hide<//>
              <${Button} kind=${sel.length ? 'default' : 'primary'} disabled=${busy} onClick=${() => show(unshown)}>${allWord === 'both' ? 'Both' : 'All'}<//>
              ${sel.length > 0 && html`<${Button} kind="primary" disabled=${busy} onClick=${() => show(sel)}>${selText} only<//>`}
            </div>`
        : html`<div class="abar-mline">
            <span class="abar-result">${resultLine(view)}</span>
            ${nextIn && !after ? html`<span class="mono muted">${nextIn}</span>` : after && html`<span class="muted abar-hint">${after}</span>`}
          </div>`}
      ${reveal}
    </div>`;
  }

  return html`<div class="abar-body abar-in abar-row">
    <div class="abar-grow">
      ${showPrompt
        ? html`<div class="abar-title">${won && hand.results && hand.results.endedBy === 'fold' ? 'You won — show your cards?' : 'Show your hand?'}</div>
            <div class="muted abar-sub">
              ${won && hand.results && hand.results.endedBy === 'fold'
                ? 'Nobody called, so you don’t have to. Tap a card to pick one'
                : 'Anyone can show once the hand is over, even after folding. Tap a card to pick one'}${unshown.length > 1 &&
              html`<span class="kc-hint">, or press ${unshown.map((i, n) => html`<${Fragment} key=${i}>${n > 0 ? ' ' : ''}<kbd class="kc kc-inline">${i + 1}</kbd><//>`)}</span>`}.
            </div>`
        : html`<div class="abar-title abar-result">${resultLine(view)}</div>
            ${hand.runout
              ? html`<div class="muted abar-sub">Revealed by ${hand.runout.name || 'a player'} — those cards never counted.</div>`
              : hand.canRevealRunout
                ? html`<div class="muted abar-sub">Curious? See the cards that would have come.</div>`
                : null}`}
    </div>
    ${showPrompt &&
    html`<div class="abar-btns">
      <${Button} disabled=${busy} onClick=${() => pick.hide()}>Keep hidden<//>
      <${Button} kind=${sel.length ? 'default' : 'primary'} disabled=${busy} onClick=${() => show(unshown)} aria-keyshortcuts="S">Show ${allWord}<${Kc} k="S" /><//>
      ${sel.length > 0 && html`<${Button} kind="primary" disabled=${busy} onClick=${() => show(sel)}>Show ${selText}<//>`}
    </div>`}
    ${reveal}
    ${(nextIn || after) && html`<div class="abar-sep"></div>`}
    ${next}
  </div>`;
}

// ─── the bar ─────────────────────────────────────────────────────────────────

function Notice({ icon, children, action }) {
  return html`<div class="abar-notice">
    <${Icon} name=${icon} size=${16} />
    <span class="abar-notice-text">${children}</span>
    ${action}
  </div>`;
}

function Waiting({ view, mobile, now, title, sub, children, icon, pre }) {
  const hand = view.hand;
  const me = view.me;
  const toAct = hand && hand.phase === 'betting' ? hand.toAct : null;
  const deadline = toAct && view.deadlineKind === 'action' ? view.deadline : null;
  const total = (view.settings.actionTime || 25) * 1000;
  const hp = me && hand ? hand.players.find((p) => p.pid === me.id) : null;
  const secs = deadline ? countdownText(deadline, now) : '';
  const actorName = toAct ? nameOf(view, toAct) : null;

  // Default headline: whoever is acting, with their clock. With a custom title, the acting
  // player shrinks to a small chip so the clock never reads as *your* deadline.
  let line = title;
  let main = false;
  if (!line && toAct) {
    main = true;
    line = html`<span class="abar-who"><${Avatar} name=${actorName} seed=${seatOf(view, toAct)} size=${mobile ? 22 : 26} /><span class="abar-who-name">${actorName}</span><span class="abar-who-rest"> is thinking</span></span>`;
  }
  const chip = !main && toAct
    ? html`<span class="actor-chip" title=${actorName + ' to act'}>
        <${Avatar} name=${actorName} seed=${seatOf(view, toAct)} size=${20} />
        <span class="actor-name">${actorName}</span>
        ${secs && html`<span class="mono muted">${secs}</span>`}
      </span>`
    : null;
  const quiet = hand && hand.phase === 'runout'; // the runout shows win % instead (the vote does not: hands are still down)
  const meBits = me && me.seat != null && hp
    ? html`<span class="abar-me">${hp.folded
        ? 'You folded'
        : html`<b>You</b> · <span key=${'stack-' + me.stack} class="mono brass num-bump">${fmt(me.stack)}</span>${me.handName && !quiet ? html` · ${me.handName}` : ''}`}</span>`
    : null;

  return html`<div class="abar-body abar-in">
    <div class="abar-top">
      <div class="abar-turn">
        ${icon && html`<span class="abar-icon"><${Icon} name=${icon} size=${mobile ? 18 : 20} /></span>`}
        <span class="abar-title abar-title-soft">${line}</span>
        ${main && !mobile && html`<${TimerBar} deadline=${deadline} total=${total} />`}
        ${main && secs && html`<span class="mono muted abar-secs">${secs}</span>`}
      </div>
      ${!mobile && chip}
      ${!mobile && meBits}
      ${!mobile && children}
    </div>
    ${main && deadline && mobile && html`<${TimerBar} deadline=${deadline} total=${total} thin />`}
    ${sub && html`<div class=${cx('muted', 'abar-sub', icon && 'abar-sub-indent')}>${sub}</div>`}
    ${mobile && children && html`<div class="abar-mactions">${children}</div>`}
    ${mobile && (meBits || chip) && html`<div class="abar-mline">${meBits || html`<span></span>`}${chip}</div>`}
    ${pre}
  </div>`;
}

// ─── pre-actions (before my turn) ────────────────────────────────────────────

const PRE_KEY_OF = { checkFold: 'I', callAny: 'A', callCurrent: 'G' };
const PRE_TITLE = {
  checkFold: 'Check if it’s free when your turn comes, otherwise fold',
  callAny: 'Call whatever it costs when your turn comes (check if free)',
  callCurrent: 'Call this amount when your turn comes — cancelled if the bet changes',
};

function PreActions({ view, pre, onToggle, mobile }) {
  return html`<div class=${cx('pre-acts', mobile && 'pre-acts-m')} role="group" aria-label="Act before your turn">
    ${!mobile && html`<span class="label pre-label">Before your turn</span>`}
    ${PRE_KINDS.map((kind) => {
      const on = !!(pre && pre.kind === kind);
      return html`<button
        type="button"
        key=${kind}
        class=${cx('pre-btn', 'pre-' + kind, on && 'on')}
        aria-pressed=${on}
        aria-keyshortcuts=${PRE_KEY_OF[kind]}
        title=${PRE_TITLE[kind] + ' (' + PRE_KEY_OF[kind] + ')'}
        onClick=${() => onToggle(kind)}
      >
        <span class="pre-box" aria-hidden="true">${on && html`<${Icon} name="check" size=${12} stroke=${3} />`}</span>
        <span class="pre-text">${preLabel(kind, view)}</span>
        ${!mobile && html`<${Kc} k=${PRE_KEY_OF[kind]} />`}
      </button>`;
    })}
  </div>`;
}

let preSeq = 0;

// The pending pick lives outside the component, per room: the phone and desktop layouts mount
// different ActionBars (useIsMobile), so a rotation or resize across the breakpoint must not drop it.
const preStores = new Map();
function preStoreFor(code) {
  let st = preStores.get(code);
  if (!st) {
    st = {
      pre: null,
      fired: 0, // id of the pick already sent (maybe still in flight)
      subs: new Set(),
      set(next) {
        if (next === st.pre) return;
        st.pre = next;
        for (const f of st.subs) f(next);
      },
    };
    preStores.set(code, st);
  }
  return st;
}

/**
 * The pending pre-action and the effect that fires it. Fires at most once per pick (each pick has
 * an id, so repeated renders, realtime refetches, a request still in flight or a remount can't send
 * it twice), and is dropped when the street or hand moves on, I'm out of the round, or Call
 * current's bet changed.
 */
function usePreAction(view, act) {
  const store = preStoreFor((view && view.code) || '');
  const [pre, setLocal] = useState(store.pre);
  useEffect(() => {
    store.subs.add(setLocal);
    setLocal(store.pre);
    return () => {
      store.subs.delete(setLocal);
    };
  }, [store]);
  const viewRef = useRef(view);
  viewRef.current = view;
  const toggle = useCallback(
    (kind) => {
      const cur = store.pre;
      const next = togglePreAction(cur, kind, viewRef.current);
      if (next === cur) return;
      store.set(next ? { ...next, id: ++preSeq } : null);
    },
    [store],
  );
  useEffect(() => {
    if (!pre || pre !== store.pre) return;
    const d = decidePreAction(pre, view);
    if (!d) return;
    if (d.cancel) {
      store.set(null);
      if (d.cancel === 'changed') toast('The bet changed — choose again', 'default');
      return;
    }
    if (store.fired === pre.id) return; // already sent (maybe still in flight)
    store.fired = pre.id;
    const id = pre.id;
    // Accepted or refused (room.act toasts the server's reason), the pick is used up either way.
    Promise.resolve(act('act', d.fire)).finally(() => {
      if (store.pre && store.pre.id === id) store.set(null);
    });
  }, [view, pre, store]);
  return [pre, toggle];
}

/** The one document keydown listener for the room's shortcuts; `live` is read at key time. */
function useHotkeys(live) {
  const ref = useRef(live);
  ref.current = live;
  // Show keys pressed while a request is in flight wait here ({ no: hand number, keys }) and are
  // re-read against the fresh view once it lands — so 1 then 2 shows both cards.
  const showQueue = useRef(null);
  useEffect(() => {
    const q = showQueue.current;
    if (!q || live.busy) return;
    showQueue.current = null;
    const view = live.view;
    if (!view || !view.hand || view.hand.no !== q.no) return;
    const cards = new Set();
    for (const k of q.keys) for (const i of showKey(k, view) || []) cards.add(i);
    if (cards.size) live.act('show', { cards: [...cards].sort((a, b) => a - b) });
  }, [live.busy, live.view]);
  useEffect(() => {
    const onKey = (e) => {
      if (ignoreKeyEvent(e, document.documentElement.classList.contains('modal-open'))) return;
      const L = ref.current;
      const key = normKey(e);
      if (key === '?') {
        if (L.openShortcuts) {
          e.preventDefault();
          L.openShortcuts();
        }
        return;
      }
      if (key === 'm') {
        if (L.openChat && L.view && L.view.me && !L.view.ended) {
          e.preventDefault();
          L.openChat();
        }
        return;
      }
      const view = L.view;
      if (!view || view.ended || !view.me) return;
      const turn = decideTurnKey(key, view);
      if (turn) {
        e.preventDefault();
        if (turn.toast) toast(turn.toast, 'default');
        else if (turn.focus) L.focusRaise();
        else if (!L.busy) L.act('act', turn);
        return;
      }
      if (PRE_KEYS[key] && canPreAct(view)) {
        e.preventDefault();
        L.togglePre(PRE_KEYS[key]);
        return;
      }
      const cards = showKey(key, view);
      if (cards) {
        e.preventDefault();
        if (!L.busy) L.act('show', { cards });
        else {
          const q = showQueue.current;
          if (q && q.no === view.hand.no) q.keys.push(key);
          else showQueue.current = { no: view.hand.no, keys: [key] };
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

function AwayControls({ view, act, busy, mobile, onLeave }) {
  const me = view.me;
  const [waitBB, setWaitBB] = useBackPref();
  const why =
    me.awayBy === 'host'
      ? 'The host set you away.'
      : me.awayBy === 'timeout'
        ? 'You timed out, so we set you away.'
        : null;
  const check = html`<label class="abar-check">
    <input type="checkbox" checked=${waitBB} onChange=${(e) => setWaitBB(e.target.checked)} />
    <span>Wait for the big blind when I’m back</span>
  </label>`;
  const back = () => !busy && act('away', { on: false, waitForBB: waitBB });
  if (mobile) {
    return html`<div class="abar-body abar-in">
      <div class="abar-away-head">
        <span class="abar-away-icon"><${Icon} name="clock" size=${20} /></span>
        <div>
          <div class="abar-title">You’re away</div>
          <div class="muted abar-hint">${why || 'Seat held until you’re back · skipping blinds'}</div>
        </div>
      </div>
      ${check}
      <div class="abar-grid abar-grid-away">
        <${Button} kind="danger" disabled=${busy} onClick=${onLeave}>Leave seat<//>
        <${Button} kind="primary" disabled=${busy} onClick=${back}>I’m back<//>
      </div>
    </div>`;
  }
  return html`<div class="abar-body abar-in abar-row">
    <div class="abar-away-head abar-grow">
      <span class="abar-away-icon"><${Icon} name="clock" size=${24} /></span>
      <div>
        <div class="abar-title">You’re away</div>
        <div class="muted abar-sub">
          ${why ? why + ' ' : ''}You’re not dealt in and skip the blinds. Your seat and <span class="mono">${fmt(me.stack + (me.pendingChips || 0))}</span> chips stay here until you come back or the host removes you.
        </div>
        ${check}
      </div>
    </div>
    <div class="abar-btns">
      <${Button} kind="danger" disabled=${busy} onClick=${onLeave}>Leave seat<//>
      <${Button} kind="primary" class="btn-back" disabled=${busy} onClick=${back}>I’m back<//>
    </div>
  </div>`;
}

export function ActionBar({ onBuyIn, onLeave, onSit } = {}) {
  const room = useRoom();
  const mobile = useIsMobile();
  const view = room && room.view;
  const now = useClock(view);
  const [waitBB] = useBackPref();
  const act = room && room.act;
  const busy = !!(room && room.acting);
  const [pre, togglePre] = usePreAction(view, act);
  const focusRef = useRef(null);
  useHotkeys({
    view,
    act,
    busy,
    togglePre,
    openShortcuts: room && room.openShortcuts,
    openChat: room && room.openChat,
    focusRaise: () => focusRef.current && focusRef.current(),
  });
  if (!view || view.ended) return null;
  const me = view.me;
  const hand = view.hand;
  const hp = me && hand ? hand.players.find((p) => p.pid === me.id) : null;
  const props = { view, act, busy, mobile, now };

  let tone = null;
  let body;
  const notices = [];

  let stateKind = '';

  if (me && me.seat != null && me.leaveAfterHand && me.removedByHost) {
    // The host's removal can't be undone by the player — no "Stay seated" here.
    notices.push(html`<${Notice} key="leave" icon="leave">The host removed you — you’ll be cashed out when this hand ends.<//>`);
  } else if (me && me.seat != null && me.leaveAfterHand) {
    notices.push(html`<${Notice}
      key="leave"
      icon="leave"
      action=${html`<${Button} size="sm" disabled=${busy} onClick=${() => act('cancelLeave')}>Stay seated<//>`}
    >You’ll cash out and leave the table when this hand ends.<//>`);
  } else if (me && me.seat != null && me.awayAfterHand && !me.away) {
    notices.push(html`<${Notice}
      key="away"
      icon="clock"
      action=${html`<${Button} size="sm" disabled=${busy} onClick=${() => act('away', { on: false })}>Cancel<//>`}
    >You’ll be set away when this hand ends.<//>`);
  }

  if (!me) {
    stateKind = 'spectator';
    body = html`<${Waiting} key=${stateKind} ...${props} icon="eye" title="You’re watching" sub=${mobile ? null : 'Join the game to take a seat and get dealt in.'}>
      ${room.openJoin && html`<${Button} kind="primary" onClick=${() => room.openJoin()}>Join this game<//>`}
    <//>`;
  } else if (me.seat == null) {
    const req = me.request;
    stateKind = req ? 'req-spectator' : 'pick-seat';
    // Joined but not seated (spectator, or a host running the game without sitting): the runout
    // reveal is still theirs when the setting allows it.
    const reveal = hand && hand.phase === 'complete' && hand.canRevealRunout ? html`<${RevealButton} key="reveal" ...${props} />` : null;
    const kids = (list) => {
      const k = list.filter(Boolean);
      return k.length ? k : null;
    };
    if (req) {
      body = html`<${Waiting}
        key=${stateKind}
        ...${props}
        icon="clock"
        title=${html`Seat request sent${req.seat != null ? html` · seat <span class="mono">${req.seat + 1}</span>` : ''} · <span class="mono brass">${fmt(req.amount)}</span>`}
        sub="Waiting for the host to approve it."
        children=${kids([
          html`<${Button} key="cancel" size=${mobile ? 'sm' : 'md'} disabled=${busy} onClick=${() => act('cancelRequest', { id: req.id })}>Cancel request<//>`,
          reveal,
        ])}
      />`;
    } else {
      const open = view.seats.filter((s) => !s.pid && !s.reservedBy).length;
      body = html`<${Waiting}
        key=${stateKind}
        ...${props}
        icon="seat"
        title=${open ? 'Pick an empty seat to sit down' : 'The table is full'}
        sub=${open ? (mobile ? 'Tap Sit on any open seat.' : 'Tap “Sit” on any open seat to choose your buy-in.') : 'You can watch and chat until a seat opens up.'}
        children=${kids([
          open > 0 && !mobile && html`<${Button} key="sit" kind="primary" onClick=${() => onSit && onSit(null)}>Take a seat<//>`,
          reveal,
        ])}
      />`;
    }
  } else if (me.away && !(hand && hand.phase === 'complete' && (hand.canShow || hand.canRevealRunout))) {
    stateKind = 'away';
    tone = 'away';
    body = html`<${AwayControls} key=${stateKind} ...${props} onLeave=${onLeave} />`;
  } else if (hand && hand.phase === 'betting' && hand.toAct === me.id && hand.legal) {
    stateKind = 'turn';
    tone = 'turn';
    body = html`<${TurnControls} key=${stateKind + '-' + hand.no} ...${props} focusRef=${focusRef} />`;
  } else if (hand && hand.phase === 'ritVote' && hand.ritVote) {
    stateKind = 'vote';
    tone = hand.ritVote.voters.includes(me.id) && hand.ritVote.votes[me.id] == null ? 'turn' : null;
    body = html`<${VoteControls} key=${stateKind} ...${props} />`;
  } else if (hand && hand.phase === 'runout') {
    stateKind = 'runout';
    const runsText = hand.runs > 1 ? 'Running it ' + runWord(hand.runs) + ' · run ' + (hand.currentRun + 1) : 'All-in · running it out';
    const eq = hp && hp.equity != null && !hp.folded ? hp.equity : null;
    body = html`<${Waiting}
      key=${stateKind}
      ...${props}
      icon="suits"
      title=${runsText}
      sub=${eq != null ? html`You have <span class="mono brass">${eq}%</span> on this board.` : null}
    />`;
  } else if (hand && hand.phase === 'complete') {
    stateKind = 'complete';
    if (me.away) {
      // Away players keep the after-hand choices (show my cards / reveal the runout).
      tone = 'away';
      notices.push(html`<${Notice}
        key="away-now"
        icon="clock"
        action=${html`<${Button} size="sm" kind="primary" disabled=${busy} onClick=${() => act('away', { on: false, waitForBB: waitBB })}>I’m back<//>`}
      >You’re away — you won’t be dealt in until you’re back.<//>`);
    }
    body = html`<${CompleteControls} key=${stateKind} ...${props} />`;
  } else if (me.busted) {
    const req = me.request;
    stateKind = req ? 'req-busted' : 'busted';
    body = req
      ? html`<${Waiting} key=${stateKind} ...${props} icon="chips" title=${html`Buy-in of <span class="mono brass">${fmt(req.amount)}</span> requested`} sub="Waiting for the host to approve it.">
          <${Button} size=${mobile ? 'sm' : 'md'} disabled=${busy} onClick=${() => act('cancelRequest', { id: req.id })}>Cancel request<//>
        <//>`
      : html`<${Waiting} key=${stateKind} ...${props} icon="chips" title="You’re out of chips" sub=${mobile ? null : 'Request a buy-in to get back in, or leave your seat to cash out.'}>
          <div class="abar-btns">
            ${!mobile && html`<${Button} kind="danger" onClick=${onLeave}>Leave seat<//>`}
            <${Button} kind="primary" onClick=${onBuyIn}>Request a buy-in<//>
          </div>
        <//>`;
  } else if (hand) {
    stateKind = 'playing-waiting';
    // a hand is being played; either I'm in it and waiting, or I'm sitting this one out
    const sub = !hp
      ? me.waitForBB
        ? 'You’ll be dealt in when the big blind reaches you.'
        : 'You’re in from the next hand.'
      : null;
    const preBar = canPreAct(view) ? html`<${PreActions} view=${view} pre=${pre} onToggle=${togglePre} mobile=${mobile} />` : null;
    body = html`<${Waiting} key=${stateKind} ...${props} sub=${sub} pre=${preBar} />`;
  } else {
    stateKind = 'no-hand-waiting';
    // no hand
    let title;
    let sub = null;
    let icon = 'clock';
    if (view.paused) {
      title = view.isHost ? 'You paused the game' : 'Paused by the host';
      sub = 'No new hands until the game resumes.';
      icon = 'pause';
    } else if (view.deadlineKind === 'nextHand' && view.deadline) {
      title = html`Next hand in <span class="mono brass">${countdownText(view.deadline, now)}</span>`;
    } else {
      title = 'Waiting for players';
      const ready = (view.players || []).filter((p) => p.seat != null && p.stack > 0 && !p.away).length;
      sub = ready < 2 ? 'The next hand deals as soon as two players have chips.' : null;
    }
    body = html`<${Waiting} key=${stateKind} ...${props} icon=${icon} title=${title} sub=${me.waitForBB ? 'You’ll be dealt in when the big blind reaches you.' : sub} />`;
  }

  return html`<section
    class=${cx('abar', mobile ? 'abar-m' : 'abar-d panel', tone && 'abar-tone-' + tone)}
    aria-label="Your actions"
    aria-live=${tone === 'turn' ? 'polite' : undefined}
  >
    ${notices}
    ${body}
  </section>`;
}

export default ActionBar;
