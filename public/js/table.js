// public/js/table.js — the poker table (SPEC §11–§12; design/Main, Mobile, Showdown*, AllIn*, Reveal*, Away*).
//
//   <Table onSit={(seat) => …} />
//
// Reads everything from useRoom(): { view, act, … }. Desktop draws a landscape oval with the hero
// (cards + pod) at bottom-centre; phones (useIsMobile) draw a portrait oval with the hero's cards
// below it. Seats are placed on the ellipse and rotated so the viewer's seat (else seat 0) is at
// the bottom. Countdown arcs are CSS animations keyed on the deadline, so the table itself never
// needs a ticking re-render.
//
// Also exported for actionbar.js: useShowPick (which of my cards I've tapped to show), and a few
// pure helpers (actionLabel, runWord, winningCards).
import { html, useState, useEffect, useMemo, Fragment } from './h.js';
import { useRoom, serverNow } from './room.js';
import { Avatar, Card, Icon, cx, fmt, hueFor, cardText, useIsMobile } from './ui.js';

// ─── pure helpers ────────────────────────────────────────────────────────────

export function actionLabel(la) {
  if (!la) return null;
  switch (la.type) {
    case 'fold':
      return 'Folded';
    case 'check':
      return 'Check';
    case 'call':
      return 'Call ' + fmt(la.amount);
    case 'bet':
      return 'Bet ' + fmt(la.amount);
    case 'raise':
      return 'Raise to ' + fmt(la.amount);
    case 'allin':
      return 'All-in';
    default:
      return null;
  }
}

const MONEY_ACTIONS = new Set(['call', 'bet', 'raise', 'allin']);

export function runWord(n) {
  return n === 2 ? 'twice' : n === 3 ? 'three times' : 'once';
}

/** 'Flush, Ace high' → 'flush'; 'Three Queens' → 'three queens'. */
function shortHand(name) {
  if (!name) return '';
  const s = String(name).split(',')[0];
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function joinNames(names) {
  if (names.length <= 1) return names[0] || '';
  return names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1];
}

// Tiny 5-card scorer, only used to decide which cards to lift at a showdown (the server is the
// authority on who won; the view doesn't carry the winners' best five).
const RV = { 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, T: 10, J: 11, Q: 12, K: 13, A: 14 };

function score5(cs) {
  const r = cs.map((c) => RV[c[0]] || 0).sort((a, b) => b - a);
  const flush = cs.every((c) => c[1] === cs[0][1]);
  const cnt = new Map();
  for (const x of r) cnt.set(x, (cnt.get(x) || 0) + 1);
  const groups = [...cnt.entries()].map(([k, v]) => [v, k]).sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let ord = groups.map((g) => g[1]);
  let high = 0;
  if (cnt.size === 5) {
    if (r[0] - r[4] === 4) high = r[0];
    else if (r[0] === 14 && r[1] === 5) high = 5;
  }
  let cat;
  if (high && flush) (cat = 8), (ord = [high]);
  else if (groups[0][0] === 4) cat = 7;
  else if (groups[0][0] === 3 && groups[1][0] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (high) (cat = 4), (ord = [high]);
  else if (groups[0][0] === 3) cat = 3;
  else if (groups[0][0] === 2 && groups[1][0] === 2) cat = 2;
  else if (groups[0][0] === 2) cat = 1;
  else cat = 0;
  let s = cat;
  for (let i = 0; i < 5; i++) s = s * 15 + (ord[i] || 0);
  return s;
}

function combos(arr, k) {
  const out = [];
  const pick = (start, acc) => {
    if (acc.length === k) {
      out.push(acc.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      acc.push(arr[i]);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

function best5(variant, hole, board) {
  if (!Array.isArray(hole) || hole.some((c) => !c) || !Array.isArray(board) || board.length < 3) return null;
  let best = null;
  const consider = (five) => {
    const s = score5(five);
    if (!best || s > best.s) best = { s, cards: five };
  };
  if (variant === 'PLO') {
    if (hole.length < 2) return null;
    for (const h of combos(hole, 2)) for (const b of combos(board, 3)) consider([...h, ...b]);
  } else {
    const all = [...hole, ...board];
    if (all.length < 5) return null;
    for (const f of combos(all, 5)) consider(f);
  }
  return best;
}

/**
 * At a showdown: { boards: Set<card>[] (per run), holes: { pid: Set<card> } } of the cards that
 * make the winners' hands. null when there's nothing to highlight.
 */
export function winningCards(hand) {
  if (!hand || hand.phase !== 'complete' || !hand.results || hand.results.endedBy !== 'showdown') return null;
  const runs = hand.results.runs || [];
  if (!runs.length) return null;
  const boards = [];
  const holes = {};
  runs.forEach((run, r) => {
    const used = new Set();
    for (const pid of run.winners || []) {
      const hp = hand.players.find((p) => p.pid === pid);
      if (!hp) continue;
      const b = best5(hand.variant, hp.cards, run.board || []);
      if (!b) continue;
      for (const c of b.cards) {
        if (hp.cards.includes(c)) (holes[pid] = holes[pid] || new Set()).add(c);
        else used.add(c);
      }
    }
    boards[r] = used;
  });
  return { boards, holes };
}

// ─── "show my cards" selection (shared with the action bar) ─────────────────

const pickState = { key: null, sel: [], hidden: false };
const pickSubs = new Set();
function setPick(next) {
  Object.assign(pickState, next);
  pickSubs.forEach((f) => f());
}

/**
 * Which of my hole cards I've tapped to show at the end of a hand, keyed per hand
 * (`code:handNo`) so a new hand starts clean. → { sel: number[], hidden, toggle(i), clear(), hide() }
 */
export function useShowPick(key) {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    pickSubs.add(f);
    return () => pickSubs.delete(f);
  }, []);
  const mine = pickState.key === key;
  return {
    sel: mine ? pickState.sel : [],
    hidden: mine ? pickState.hidden : false,
    toggle(i) {
      const cur = pickState.key === key ? pickState.sel : [];
      setPick({ key, hidden: false, sel: cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b) });
    },
    clear() {
      setPick({ key, sel: [], hidden: false });
    },
    hide() {
      setPick({ key, sel: [], hidden: true });
    },
  };
}

// ─── geometry ────────────────────────────────────────────────────────────────
// Angles in screen degrees (0 = right, 90 = bottom, y grows down), so increasing angle runs
// clockwise — the same direction as seat numbers.

function seatAngle(rel, n, mobile) {
  if (rel === 0) return 90;
  if (n <= 2) return 270;
  // Leave room at the bottom for the hero; phones need a wider gap (portrait oval, big hero cards).
  const gap = mobile ? Math.max(360 / n, 58) : 360 / n;
  const step = (360 - 2 * gap) / (n - 2);
  return 90 + gap + (rel - 1) * step;
}

function polar(deg, r = 1) {
  const a = (deg * Math.PI) / 180;
  return { x: 50 + 50 * r * Math.cos(a), y: 50 + 50 * r * Math.sin(a) };
}

function polarXY(deg, rx, ry) {
  const a = (deg * Math.PI) / 180;
  return { x: 50 + 50 * rx * Math.cos(a), y: 50 + 50 * ry * Math.sin(a) };
}

const at = (p) => ({ left: p.x.toFixed(2) + '%', top: p.y.toFixed(2) + '%' });

/**
 * Phones: seats on the side rails anchor their labels (tags, the reserved pill) to the inner edge
 * of the pod so nothing wider than the pod spills past the screen edge.
 */
const edgeClass = (p, mobile) => (!mobile ? null : p.x >= 70 ? 'seat-edge-r' : p.x <= 30 ? 'seat-edge-l' : null);

// ─── countdown arc (CSS-animated, keyed on the deadline) ─────────────────────

function useDrain(deadline, total) {
  // Computed once per deadline: a negative delay starts the animation part-way through.
  return useMemo(() => {
    if (!deadline || !total) return null;
    const left = Math.max(0, Math.min(total, deadline - serverNow()));
    return { animationDuration: total + 'ms', animationDelay: -(total - left) + 'ms' };
  }, [deadline, total]);
}

function RingArc({ deadline, total, size }) {
  const style = useDrain(deadline, total);
  if (!style) return null;
  return html`<svg class="ring" width=${size} height=${size} viewBox="0 0 44 44" aria-hidden="true">
    <circle class="ring-track" cx="22" cy="22" r="20.5" />
    <circle key=${deadline} class="ring-arc" cx="22" cy="22" r="20.5" pathLength="100" style=${style} />
  </svg>`;
}

// ─── pieces ──────────────────────────────────────────────────────────────────

function Backs({ count, mobile }) {
  const n = count || 2;
  const spread = n === 2 ? [-6, 6] : [-12, -4, 4, 12];
  return html`<div class=${cx('backs', n > 2 && 'backs-4')}>
    ${spread.slice(0, n).map((r, i) => html`<${Card} key=${i} faceDown size="xs" class=${cx(mobile ? 'c-mback' : null, 'card-deal')} style=${{ rotate: r + 'deg', animationDelay: i * 120 + 'ms' }} />`)}
  </div>`;
}

function SeatCards({ hp, mobile, holeWin }) {
  const four = hp.cards.length > 2;
  return html`<div class=${cx('seat-cards', four && 'seat-cards-4')}>
    ${hp.cards.map((c, i) =>
      c
        ? html`<${Card}
            key=${'f' + i}
            card=${c}
            size="sm"
            flip
            class=${mobile ? 'c-mseat' : 'c-seat'}
            lift=${holeWin && holeWin.has(c)}
          />`
        : html`<${Card} key=${'b' + i} faceDown size="sm" class=${mobile ? 'c-mseat' : 'c-seat'} />`,
    )}
  </div>`;
}

/**
 * All-in runout: only equity numbers are shown, no hand descriptions. Not the run-it vote before it:
 * the all-in hands are still face down then (they flip when the vote closes) and there is no equity,
 * so the hero keeps their own hand name like during the betting.
 */
export function equityPhase(hand) {
  return !!hand && hand.phase === 'runout';
}

function Tag({ tone, children, title, class: klass }) {
  return html`<span class=${cx('tag', tone && 'tag-' + tone, klass)} title=${title}>${children}</span>`;
}

function EmptySeat({ seat, pos, canSit, reservedName, mine, onSit, mobile }) {
  if (reservedName) {
    return html`<div class=${cx('seat', 'seat-empty-wrap', edgeClass(pos, mobile))} style=${at(pos)}>
      <div class=${cx('seat-empty', 'seat-reserved', mine && 'seat-mine')} title=${mine ? 'Your seat request is waiting for the host' : 'Reserved for ' + reservedName}>
        <span class="se-main">${mine ? 'Requested' : 'Reserved'}</span>
        ${!mobile && html`<span class="se-sub">${mine ? 'by you' : reservedName}</span>`}
      </div>
    </div>`;
  }
  if (canSit) {
    return html`<div class="seat seat-empty-wrap" style=${at(pos)}>
      <button type="button" class="seat-empty seat-sit" aria-label=${'Sit in seat ' + (seat + 1)} onClick=${() => onSit && onSit(seat)}>
        <span class="se-main">Sit</span>
      </button>
    </div>`;
  }
  return html`<div class="seat seat-empty-wrap" style=${at(pos)}>
    <div class="seat-empty seat-quiet" aria-label=${'Seat ' + (seat + 1) + ' is open'}>
      <span class="mono">${seat + 1}</span>
    </div>
  </div>`;
}

/** Status tags shared by seats and the hero pod. */
function statusTags(pp, hp, hand, view) {
  const out = [];
  if (!pp) return out;
  if (pp.away) out.push(html`<${Tag} key="away" tone="brass" class="tag-in">Away<//>`);
  else if (pp.busted) out.push(html`<${Tag} key="busted" tone="muted" class="tag-in">Busted<//>`);
  if (pp.leaveAfterHand) out.push(html`<${Tag} key="leave" tone="danger" class="tag-in">Leaving<//>`);
  const rebuy = pp.pendingChips > 0 || (view.requests || []).some((r) => r.pid === pp.id && r.kind === 'rebuy');
  if (rebuy) out.push(html`<${Tag} key="rebuy" tone="brass" class="tag-in">Rebuy pending<//>`);
  if (hand && hand.phase !== 'complete' && !hp && !pp.away && !pp.busted) out.push(html`<${Tag} key="next" tone="muted" class="tag-in">Next hand<//>`);
  return out;
}

function positionPrefix(hand, hp) {
  if (!hand || !hp || hand.phase === 'complete') return null;
  if (hp.seat === hand.sbSeat && hp.seat === hand.button && hand.players.length === 2) return 'SB';
  if (hp.seat === hand.sbSeat) return 'SB';
  if (hp.seat === hand.bbSeat) return 'BB';
  return null;
}

function winPill(hand, hp) {
  if (!hand || hand.phase !== 'complete' || !hp || !hp.isWinner || !(hp.won > 0)) return null;
  let text = '+' + fmt(hp.won);
  const runs = (hand.results && hand.results.runs) || [];
  if (runs.length > 1) {
    const won = runs.map((r, i) => ((r.winners || []).includes(hp.pid) ? i + 1 : 0)).filter(Boolean);
    if (won.length && won.length < runs.length) text += ' · Run ' + won.join(' & ');
  }
  return text;
}

function Seat({ pos, pp, hp, hand, view, mobile, actDeadline, actTotal, holeWin }) {
  const complete = hand && hand.phase === 'complete';
  const acting = !!(hand && hp && hand.phase === 'betting' && hand.toAct === hp.pid);
  const folded = !!(hp && hp.folded);
  const out = !hp && (!!hand || pp.away || pp.busted);
  const winner = !!(complete && hp && hp.isWinner);
  const allIn = !!(hp && hp.allIn && !folded);
  const anyShown = hp && hp.cards.some(Boolean);

  // tags
  const tags = [];
  const wp = winPill(hand, hp);
  if (wp) tags.push(html`<${Tag} key=${'win-' + wp} tone="gold" class="tag-in">${wp}<//>`);
  // With several runs a single hand name would describe one board only; the run labels say it.
  if (complete && hp && hp.handName && !(hand.runs > 1)) tags.push(html`<${Tag} key=${'hn-' + hp.handName} class="tag-in">${hp.handName}<//>`);
  if (hp && !complete) {
    const pre = positionPrefix(hand, hp);
    let act = acting ? 'Thinking…' : actionLabel(hp.lastAction);
    // Phones draw no bet chips for other seats (design/Mobile.dc.html): the tag carries the amount.
    if (mobile && !acting && hand.phase === 'betting' && hp.bet > 0) {
      if (!hp.lastAction) act = fmt(hp.bet); // posted blind: "BB · 2"
      else if (hp.lastAction.type === 'allin') act = 'All-in ' + fmt(hp.bet);
    }
    const text = [pre, act].filter(Boolean).join(' · ');
    if (text) tags.push(html`<${Tag} key=${'act-' + text} tone=${acting ? 'acting' : hp.lastAction && MONEY_ACTIONS.has(hp.lastAction.type) ? 'hot' : null} class="tag-in">${text}<//>`);
  } else if (hp && complete && folded) {
    const foldedText = anyShown ? 'Folded · showed' : 'Folded';
    tags.push(html`<${Tag} key=${'act-' + foldedText} class="tag-in">${foldedText}<//>`);
  }
  tags.push(...statusTags(pp, hp, hand, view));

  const eq = hp && !folded && hp.equity != null ? hp.equity : null;
  const avSize = mobile ? 30 : 38;

  let above = null;
  if (hp && anyShown) above = html`<${SeatCards} hp=${hp} mobile=${mobile} holeWin=${holeWin} />`;
  else if (hp && !folded && !complete) above = html`<${Backs} count=${hp.cards.length} mobile=${mobile} />`;

  const label = [pp.name, fmt(pp.stack) + ' chips', ...(hp && hp.cards.some(Boolean) ? [hp.cards.map((c) => (c ? cardText(c) : 'hidden')).join(' ')] : [])].join(', ');

  return html`<div class=${cx('seat', acting && 'seat-acting', winner && 'seat-win', edgeClass(pos, mobile))} style=${at(pos)} role="group" aria-label=${label}>
    ${above && html`<div class="seat-above">${above}</div>`}
    <div class=${cx('pod', folded && 'pod-folded', out && 'pod-out', allIn && 'pod-allin', acting && 'pod-acting', winner && 'pod-win')}>
      <div class="pod-av">
        <${Avatar} name=${pp.name} seed=${pp.seat} size=${avSize} />
        ${acting && html`<${RingArc} deadline=${actDeadline} total=${actTotal} size=${avSize + 10} />`}
      </div>
      <div class="pod-txt">
        <span class="pod-name">${pp.name}</span>
        <span key=${'stack-' + pp.stack} class="pod-stack mono num-bump">${fmt(pp.stack)}</span>
      </div>
    </div>
    ${(eq != null || tags.length > 0) &&
    html`<div class="seat-below">
      ${eq != null && html`<span class="eq mono" style=${{ color: hueFor(pp.seat) }} aria-label=${pp.name + ' ' + eq + ' percent to win'}>${eq}%</span>`}
      ${tags}
    </div>`}
  </div>`;
}

function Hero({ me, pp, hp, hand, view, mobile, actDeadline, actTotal, holeWin, pick }) {
  const complete = hand && hand.phase === 'complete';
  const inHand = !!(hp && me.hole);
  const folded = !!(hp && hp.folded);
  const acting = !!(hand && hp && hand.phase === 'betting' && hand.toAct === me.id);
  const winner = !!(complete && hp && hp.isWinner);
  const allIn = !!(hp && hp.allIn && !folded);
  const canPick = !!(hand && hand.canShow && !pick.hidden);
  const four = inHand && me.hole.length > 2;
  const handNo = hand ? hand.no : 0;

  // pills inside the pod
  const pills = [];
  const wp = winPill(hand, hp);
  if (wp) pills.push(html`<${Tag} key=${'win-' + wp} tone="gold" class="tag-in">${wp}<//>`);
  if (inHand && folded) {
    const text = complete ? 'Folded · only you see these' : 'Folded';
    pills.push(html`<${Tag} key=${'fold-' + text} class="tag-in">${text}<//>`);
  }
  else if (inHand && me.handName && !equityPhase(hand) && !(complete && hand.runs > 1)) {
    pills.push(html`<${Tag} key=${'hn-' + me.handName} tone=${complete && !winner ? null : 'gold'} class="tag-in">${me.handName}<//>`);
  }
  if (inHand && !complete && !folded) {
    const pre = positionPrefix(hand, hp);
    const act = acting ? null : actionLabel(hp.lastAction);
    const text = [pre, act].filter(Boolean).join(' · ');
    if (text) pills.push(html`<${Tag} key=${'act-' + text} tone=${hp.lastAction && MONEY_ACTIONS.has(hp.lastAction.type) ? 'hot' : null} class="tag-in">${text}<//>`);
  }
  pills.push(...statusTags(pp, hp, hand, view));
  const eq = hp && !folded && hp.equity != null ? hp.equity : null;

  const cards = inHand
    ? html`<div class=${cx('hero-cards', four && 'hero-cards-4', folded && 'hero-folded', canPick && 'hero-pickable')}>
        ${me.hole.map((c, i) => {
          const n = me.hole.length;
          const rot = n === 2 ? (i === 0 ? -5 : 5) : [-9, -3, 3, 9][i] || 0;
          const shown = hp.shown && hp.shown[i];
          const picked = pick.sel.includes(i);
          const lift = !!(holeWin && holeWin.has(c));
          const size = mobile ? (four ? 'md' : 'xl') : four ? 'lg' : 'xl';
          const klass = cx(mobile && (four ? 'c-mhero4' : 'c-mhero'), picked && 'card-picked', pick.sel.length > 0 && !picked && canPick && !shown && 'card-unpicked', !complete && 'card-deal');
          const dealStyle = complete ? { rotate: rot + 'deg' } : { rotate: rot + 'deg', animationDelay: (i * 120) + 'ms' };
          const card = html`<${Card} card=${c} size=${size} class=${klass} lift=${lift} style=${dealStyle} />`;
          const badge = shown ? html`<span class="hero-shown" title="Everyone can see this card"><${Icon} name="eye" size=${12} /></span>` : null;
          if (canPick && !shown) {
            return html`<button
              type="button"
              key=${handNo + '-' + i}
              class="hero-card-btn"
              aria-pressed=${picked}
              aria-label=${(picked ? 'Unselect ' : 'Pick ') + cardText(c) + ' to show'}
              onClick=${() => pick.toggle(i)}
            >${card}</button>`;
          }
          return html`<div key=${handNo + '-' + i} class="hero-card">${card}${badge}</div>`;
        })}
      </div>`
    : null;

  const pod = html`<div class=${cx('pod', 'pod-hero', folded && complete && 'pod-hero-folded', !inHand && (me.away || me.busted || hand) && 'pod-out', me.away && 'pod-away', allIn && 'pod-allin', acting && 'pod-acting', winner && 'pod-win')}>
    <div class="pod-av">
      <${Avatar} name=${me.name} seed=${me.seat} size=${mobile ? 30 : 38} />
      ${acting && html`<${RingArc} deadline=${actDeadline} total=${actTotal} size=${(mobile ? 30 : 38) + 10} />`}
      ${me.away && html`<span class="av-badge" aria-hidden="true"><${Icon} name="clock" size=${12} /></span>`}
    </div>
    <div class="pod-txt">
      <span class="pod-name">You</span>
      <span key=${'stack-' + me.stack} class="pod-stack mono num-bump">${fmt(me.stack)}</span>
    </div>
    ${!mobile && (eq != null || pills.length > 0) && html`<div class="pod-pills">${eq != null && html`<span class="eq mono" style=${{ color: hueFor(me.seat) }}>${eq}%</span>`}${pills}</div>`}
  </div>`;

  if (mobile) {
    // Phone: cards (when dealt in) sit below the oval; otherwise the pod sits on the rail.
    // The pod isn't drawn while I'm dealt in, so my winnings get their own tag above my cards.
    if (inHand) return { outside: cards, onFelt: null, win: wp, eq };
    return {
      outside: null,
      onFelt: html`<div class="seat seat-hero-m" style=${at({ x: 50, y: 100 })}>
        ${pod}
        ${pills.length > 0 && html`<div class="seat-below">${pills}</div>`}
      </div>`,
    };
  }
  return {
    onFelt: html`<div class=${cx('hero', !inHand && 'hero-solo')} style=${at({ x: 50, y: 100 })}>
      ${cards}
      ${pod}
    </div>`,
    outside: null,
  };
}

function Board({ cards, size, klass, win, dimRest, ghosts }) {
  const slots = [];
  for (let i = 0; i < 5; i++) {
    const c = cards[i];
    if (c) {
      const lifted = !!(win && win.has(c));
      const dealStyle = i < 3 ? { animationDelay: (i * 140) + 'ms' } : undefined;
      slots.push(html`<${Card} key=${'c' + i} card=${c} size=${size} class=${cx(klass, 'card-deal')} style=${dealStyle} lift=${lifted} dim=${dimRest && !lifted} />`);
    } else if (ghosts && ghosts[i - cards.length]) {
      slots.push(html`<${Card} key=${'g' + i} card=${ghosts[i - cards.length]} size=${size} class=${klass} ghost flip />`);
    } else slots.push(html`<${Card} key=${'s' + i} size=${size} class=${klass} />`);
  }
  return slots;
}

function Center({ view, hand, mobile, win }) {
  if (!hand) {
    let msg;
    let sub = null;
    if (view.ended) msg = 'Game over';
    else if (view.paused) (msg = 'Paused'), (sub = view.isHost ? 'Resume when you’re ready' : 'The host paused the game');
    else if (view.deadlineKind === 'nextHand' && view.deadline) msg = 'Shuffling up…';
    else {
      const ready = (view.players || []).filter((p) => p.seat != null && p.stack > 0 && !p.away).length;
      msg = 'Waiting for players';
      sub = ready < 2 ? 'Need two players with chips to deal' : null;
    }
    return html`<div class="tbl-center tbl-idle">
      <div class="idle-msg">${msg}</div>
      ${sub && html`<div class="idle-sub">${sub}</div>`}
    </div>`;
  }

  const complete = hand.phase === 'complete';
  const pot = hand.phase === 'betting' ? hand.potCenter : hand.potTotal;
  const multi = hand.runBoards.length > 1 || hand.runs > 1;
  const runNote =
    hand.runs > 1
      ? mobile
        ? ' · ' + hand.runs + ' runs'
        : complete
          ? ' · ran ' + runWord(hand.runs)
          : ' · running it ' + runWord(hand.runs)
      : '';

  // Before any street completes nothing is in the middle yet: keep the pill's space, hide it.
  const potPill = html`<div class=${cx('pot', hand.phase === 'betting' && pot === 0 && 'pot-empty')} aria-hidden=${hand.phase === 'betting' && pot === 0 ? 'true' : undefined}>
    <span class="pot-label">Pot</span>
    <span key=${'pot-' + pot} class="pot-amt mono num-bump">${fmt(pot)}</span>
    ${runNote && html`<span class="pot-note">${runNote}</span>`}
  </div>`;

  if (multi && hand.phase !== 'ritVote') {
    const nRuns = Math.max(hand.runs, hand.runBoards.length);
    const size = mobile ? 'xs' : nRuns >= 3 ? 'sm' : 'md';
    const klass = mobile ? 'c-mrun' : nRuns >= 3 ? 'c-run3' : null;
    const rows = [];
    for (let r = 0; r < nRuns; r++) {
      const started = r < hand.runBoards.length;
      const board = started ? hand.runBoards[r] : hand.board;
      const res = complete && hand.results && hand.results.runs[r] ? hand.results.runs[r] : hand.runResults[r] || null;
      const names = res ? (res.winners || []).map((pid) => (hand.players.find((p) => p.pid === pid) || {}).name).filter(Boolean) : [];
      const label = res ? (names.length > 1 ? joinNames(names) + ' split' : names[0] || '') + (res.handName ? ', ' + shortHand(res.handName) : '') : null;
      const current = hand.phase === 'runout' && r === hand.currentRun;
      const runWin = win && win.boards[r];
      rows.push(html`<div key=${r} class=${cx('run', !started && 'run-pending', current && 'run-current')}>
        ${!mobile && html`<span class="run-n mono">${r + 1}</span>`}
        <div class="run-cards">
          <${Board} cards=${board} size=${size} klass=${klass} win=${runWin} dimRest=${!!runWin} />
        </div>
        ${label
          ? html`<span class="run-label">${mobile ? 'Run ' + (r + 1) + ' · ' : ''}${label}</span>`
          : mobile && html`<span class="run-label run-label-muted">Run ${r + 1}${current ? ' · dealing' : ''}</span>`}
      </div>`);
    }
    return html`<div class=${cx('tbl-center', 'tbl-runs', nRuns >= 3 && 'tbl-runs-3')}>${potPill}${rows}</div>`;
  }

  const board = hand.runBoards.length === 1 ? hand.runBoards[0] : hand.board;
  const ghosts = hand.runout ? hand.runout.cards : null;
  const runWin = win && win.boards[0];
  return html`<div class="tbl-center">
    ${potPill}
    <div class=${cx('board', mobile && 'board-m')}>
      <${Board} cards=${board} size=${mobile ? 'md' : 'lg'} klass=${mobile ? 'c-mboard' : null} win=${runWin} dimRest=${!!runWin} ghosts=${ghosts} />
    </div>
    ${hand.runout &&
    html`<div class="revealed">
      <${Icon} name="eye" size=${mobile ? 14 : 16} />
      <span>Revealed by ${hand.runout.name || 'a player'}${mobile ? '' : ' · would have come'}</span>
    </div>`}
  </div>`;
}

function BetChip({ pos, amount }) {
  return html`<div class="bet" style=${at(pos)}>
    <span class="chip" aria-hidden="true"></span>
    <span class="bet-amt mono">${fmt(amount)}</span>
  </div>`;
}

// ─── the table ───────────────────────────────────────────────────────────────

export function Table({ onSit } = {}) {
  const room = useRoom();
  const mobile = useIsMobile();
  const view = room && room.view;
  const hand = view ? view.hand : null;
  const pick = useShowPick(view && hand ? view.code + ':' + hand.no : null);
  const win = useMemo(() => winningCards(hand), [hand]);
  if (!view) return null;

  const me = view.me;
  const n = view.settings.seats || view.seats.length;
  const heroSeated = !!(me && me.seat != null);
  const anchor = heroSeated ? me.seat : 0;
  const canSit = !!(me && me.seat == null && !me.request && !view.ended);
  const pById = new Map((view.players || []).map((p) => [p.id, p]));
  const hpById = new Map(hand ? hand.players.map((p) => [p.pid, p]) : []);

  const actDeadline = hand && hand.phase === 'betting' && view.deadlineKind === 'action' ? view.deadline : null;
  const actTotal = (view.settings.actionTime || 25) * 1000;

  const seats = [];
  const bets = [];
  let dealer = null;
  let hero = null;
  const buttonSeat = hand ? hand.button : view.button;

  for (const s of view.seats) {
    const rel = (s.seat - anchor + n) % n;
    const ang = seatAngle(rel, n, mobile);
    const pos = mobile ? polarXY(ang, 1, 0.97) : polar(ang);
    const isHero = heroSeated && s.seat === me.seat;
    const pp = s.pid ? pById.get(s.pid) : null;
    const hp = s.pid ? hpById.get(s.pid) : null;

    if (isHero) {
      hero = Hero({
        me,
        pp: pp || { ...me, id: me.id },
        hp,
        hand,
        view,
        mobile,
        actDeadline,
        actTotal,
        holeWin: win && hp ? win.holes[hp.pid] : null,
        pick,
      });
    } else if (pp) {
      seats.push(html`<${Seat}
        key=${'s' + s.seat}
        pos=${pos}
        pp=${pp}
        hp=${hp}
        hand=${hand}
        view=${view}
        mobile=${mobile}
        actDeadline=${actDeadline}
        actTotal=${actTotal}
        holeWin=${win && hp ? win.holes[hp.pid] : null}
      />`);
    } else {
      const reservedName = s.reservedBy ? (pById.get(s.reservedBy) || {}).name || 'a player' : null;
      seats.push(html`<${EmptySeat}
        key=${'e' + s.seat}
        seat=${s.seat}
        pos=${pos}
        canSit=${canSit && !s.reservedBy}
        reservedName=${reservedName}
        mine=${!!(me && s.reservedBy === me.id)}
        onSit=${onSit}
        mobile=${mobile}
      />`);
    }

    // Bet chips: every seat on desktop; on phones only mine (others' tags show their amounts —
    // a portrait oval leaves no room between the pods and the board, see design/Mobile.dc.html).
    if (hp && hand.phase === 'betting' && hp.bet > 0 && (!mobile || isHero)) {
      const r = rel === 0 ? (mobile ? 0.72 : 0.42) : 0.6;
      bets.push(html`<${BetChip} key=${'b' + s.seat} pos=${polar(ang, r)} amount=${hp.bet} />`);
    }
    if (buttonSeat != null && s.seat === buttonSeat && (s.pid || hand)) {
      if (mobile && !isHero) {
        // Phone pods carry cards above and tags below, so the button goes beside the pod, on the
        // side that faces the middle of the table.
        const toRight = Math.cos((ang * Math.PI) / 180) <= 0.001;
        dealer = html`<div class=${cx('dealer', toRight ? 'dealer-r' : 'dealer-l')} style=${at(pos)} title="Dealer button" aria-label="Dealer">D</div>`;
      } else {
        const p = isHero ? polar(mobile ? 62 : 58, mobile ? 0.78 : 0.66) : polar(ang - 15, 0.7);
        dealer = html`<div class="dealer" style=${at(p)} title="Dealer button" aria-label="Dealer">D</div>`;
      }
    }
  }

  return html`<div class=${cx('tbl', mobile ? 'tbl-m' : 'tbl-d', heroSeated && hero && hero.outside && 'tbl-has-hero-cards', n >= 9 && 'tbl-9')}>
    <div class="tbl-stage">
      <div class="tbl-rail">
        <div class="tbl-felt">
          <${Center} view=${view} hand=${hand} mobile=${mobile} win=${win} />
          ${bets}
          ${dealer}
          ${seats}
          ${hero && hero.onFelt}
        </div>
      </div>
      ${hero && hero.outside && html`<div class="hero-m">
        ${hero.eq != null && html`<span class="eq mono hero-m-eq" style=${{ color: hueFor(me.seat) }}>${hero.eq}%</span>`}
        ${hero.win && html`<span class="tag tag-gold hero-m-win">${hero.win}</span>`}
        ${hero.outside}
      </div>`}
    </div>
  </div>`;
}

export default Table;
