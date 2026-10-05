// public/js/dialogs.js — BuyInDialog, LeaveDialog, JoinPrompt, ConfirmDialog, ShortcutsDialog
// (SPEC §6.5, §11, §12).
import { html, useState, useEffect, useRef, useMemo, Fragment } from './h.js';
import { useRoom } from './room.js';
import { Modal, Button, Icon, Avatar, Pill, cx, fmt, fmtSigned, toast } from './ui.js';
import { HOTKEYS } from './hotkeys.js';

const VARIANT_NAME = { NLH: 'No-Limit Hold’em', PLO: 'Pot-Limit Omaha' };
const toInt = (v) => {
  const n = Number(String(v).replace(/[^0-9-]/g, ''));
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Is a hand running that `pid` is still contesting (dealt in, not folded, not finished)? */
function contesting(view, pid) {
  const h = view && view.hand;
  if (!h || h.phase === 'complete' || !pid) return null;
  const p = (h.players || []).find((x) => x.pid === pid);
  return p && !p.folded ? p : null;
}

function ledgerRow(view, pid) {
  return ((view && view.ledger && view.ledger.players) || []).find((r) => r.pid === pid) || null;
}

/** First seat that is empty and not reserved by someone else (or reserved by me). */
export function firstFreeSeat(view, meId) {
  const seats = (view && view.seats) || [];
  const s = seats.find((x) => !x.pid && (!x.reservedBy || x.reservedBy === meId));
  return s ? s.seat : null;
}

function seatIsFree(view, seat, meId) {
  const s = ((view && view.seats) || []).find((x) => x.seat === seat);
  return !!s && !s.pid && (!s.reservedBy || s.reservedBy === meId);
}

// ─── BuyInDialog ─────────────────────────────────────────────────────────────

/**
 * Sit down (unseated: {type:'sit', seat, amount}) or rebuy (seated: {type:'buyin', amount}).
 * Ranges per SPEC §6.5:
 *   sit                         minBuyIn … maxBuyIn
 *   rebuy, busted (stack+pending = 0)   minBuyIn … maxBuyIn
 *   rebuy, has chips            1 … maxBuyIn − stack − pendingChips  (nothing if that is < 1)
 */
export function BuyInDialog({ open, onClose, seat = null }) {
  const room = useRoom();
  const view = room && room.view;
  const me = view && view.me;
  const s = (view && view.settings) || {};
  const min = s.minBuyIn || 1;
  const max = s.maxBuyIn || min;
  const bb = s.bb || 1;

  const mode = !me ? 'join' : me.seat == null ? 'sit' : 'rebuy';
  const have = me ? (me.stack || 0) + (me.pendingChips || 0) : 0;
  const busted = mode === 'rebuy' && have === 0;
  let lo = min;
  let hi = max;
  if (mode === 'rebuy' && !busted) {
    lo = 1;
    hi = max - have;
  }
  const canBuy = hi >= lo && hi >= 1;

  const targetSeat = mode === 'sit' ? (seat != null && seatIsFree(view, seat, me.id) ? seat : firstFreeSeat(view, me.id)) : null;
  const seatTaken = mode === 'sit' && seat != null && targetSeat !== seat;

  const suggested = () => {
    if (!canBuy) return 0;
    if (mode === 'rebuy' && !busted) return hi; // top up to the max
    return clamp(100 * bb, lo, hi);
  };

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (open) {
      setText(String(suggested()));
      setErr('');
      setBusy(false);
    }
  }, [open, mode, lo, hi]);

  if (!open) return null;

  const amount = toInt(text);
  const valid = Number.isInteger(amount) && amount >= lo && amount <= hi;
  const needsApproval = !!s.approveBuyIns && !(view && view.isHost);
  const inHand = !!(me && me.inHand && view.hand && view.hand.phase !== 'complete');
  const pending = me && me.request;
  const hostName = ((view && view.players) || []).find((p) => p.isHost)?.name || 'The host';

  const title =
    mode === 'sit' ? (targetSeat != null ? 'Take seat ' + (targetSeat + 1) : 'Table is full') : busted ? 'Buy back in' : 'Add chips';
  const subtitle =
    mode === 'sit' || busted
      ? html`Buy-in <span class="mono">${fmt(min)}–${fmt(max)}</span> · Blinds <span class="mono">${fmt(s.sb)}/${fmt(s.bb)}</span>`
      : html`Stack <span class="mono">${fmt(have)}</span> · table max <span class="mono">${fmt(max)}</span>`;

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (busy) return;
    if (!valid) {
      setErr(lo === hi ? 'The only amount available is ' + fmt(lo) + '.' : 'Enter an amount from ' + fmt(lo) + ' to ' + fmt(hi) + '.');
      return;
    }
    setBusy(true);
    const v = mode === 'sit' ? await room.act('sit', { seat: targetSeat, amount }) : await room.act('buyin', { amount });
    setBusy(false);
    if (!v) return;
    const req = v.me && v.me.request;
    if (req) toast('Request sent — ' + hostName + ' will approve it.', 'brass');
    else if (mode === 'sit') toast('You’re seated with ' + fmt(amount) + ' chips.', 'pos');
    else if (v.me && v.me.pendingChips > (me.pendingChips || 0)) toast(fmt(amount) + ' chips will be added when this hand ends.', 'pos');
    else toast(fmt(amount) + ' chips added.', 'pos');
    onClose && onClose();
  };

  const cancelRequest = async () => {
    setBusy(true);
    const v = await room.act('cancelRequest', { id: pending.id });
    setBusy(false);
    if (v) {
      toast('Request cancelled.', 'default');
      onClose && onClose();
    }
  };

  let body;
  if (mode === 'join') {
    body = html`<div class="note note-plain"><${Icon} name="info" />Join the game first, then pick a seat.</div>
      <div class="dlg-actions" style=${{ gridTemplateColumns: '1fr' }}><${Button} onClick=${onClose}>Close<//></div>`;
  } else if (pending) {
    body = html`
      <div class="summary">
        <div class="summary-row"><span class="muted">${pending.kind === 'sit' ? 'Seat request' : 'Rebuy request'}</span>
          <span class="mono" style=${{ fontWeight: 700, color: 'var(--brass)' }}>${fmt(pending.amount)}</span></div>
        ${pending.seat != null && html`<div class="summary-row"><span class="muted">Seat</span><span class="mono">${pending.seat + 1}</span></div>`}
      </div>
      <div class="note"><${Icon} name="clock" />Waiting for ${hostName} to approve. You can only have one request at a time.</div>
      <div class="dlg-actions">
        <${Button} onClick=${onClose}>Close<//>
        <${Button} kind="danger" disabled=${busy} onClick=${cancelRequest}>Cancel request<//>
      </div>`;
  } else if (mode === 'sit' && targetSeat == null) {
    body = html`<div class="note note-plain"><${Icon} name="info" />Every seat is taken or reserved. You can keep watching and sit when one opens up.</div>
      <div class="dlg-actions" style=${{ gridTemplateColumns: '1fr' }}><${Button} onClick=${onClose}>OK<//></div>`;
  } else if (!canBuy) {
    body = html`<div class="note note-plain"><${Icon} name="info" />You’re at the table maximum of <span class="mono">${fmt(max)}</span>. You can add chips once your stack drops below it.</div>
      <div class="dlg-actions" style=${{ gridTemplateColumns: '1fr' }}><${Button} onClick=${onClose}>OK<//></div>`;
  } else {
    const shown = Number.isInteger(amount) ? amount : 0;
    const presets = [];
    presets.push({ label: 'Min', v: lo });
    if (100 * bb > lo && 100 * bb < hi) presets.push({ label: '100 BB', v: 100 * bb });
    else if (hi - lo >= 4) presets.push({ label: 'Half', v: Math.round((lo + hi) / 2) });
    presets.push({ label: mode === 'rebuy' && !busted ? 'Top up' : 'Max', v: hi });
    body = html`
      <form class="buyin" onSubmit=${submit} noValidate>
        <div class="buyin-amount">
          <label class="label" for="buyin-amt">${mode === 'rebuy' && !busted ? 'Add' : 'Buy in for'}</label>
          <input
            id="buyin-amt"
            class="buyin-input mono"
            inputmode="numeric"
            autocomplete="off"
            value=${text}
            aria-invalid=${!valid}
            onInput=${(e) => {
              setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 9));
              setErr('');
            }}
            onBlur=${() => {
              if (Number.isInteger(amount)) setText(String(clamp(amount, lo, hi)));
            }}
          />
          <span class="muted mono buyin-bb">${valid ? (Math.round((shown / bb) * 10) / 10).toLocaleString('en-US') + ' BB' : fmt(lo) + '–' + fmt(hi)}</span>
        </div>
        ${hi > lo &&
        html`<input
          type="range"
          class="buyin-range"
          aria-label="Buy-in amount"
          min=${lo}
          max=${hi}
          step=${hi - lo >= 50 ? Math.max(1, Math.round(bb)) : 1}
          value=${clamp(shown || lo, lo, hi)}
          onInput=${(e) => {
            setText(e.target.value);
            setErr('');
          }}
        />`}
        <div class="buyin-presets">
          ${presets.map(
            (p) => html`<button
              type="button"
              key=${p.label}
              class=${cx('preset', amount === p.v && 'on')}
              aria-pressed=${amount === p.v}
              onClick=${() => {
                setText(String(p.v));
                setErr('');
              }}
            >${p.label} <span class="mono">${fmt(p.v)}</span></button>`,
          )}
        </div>
        ${mode === 'rebuy' &&
        !busted &&
        html`<div class="summary">
          <div class="summary-row"><span class="muted">Stack after</span><span class="mono" style=${{ fontWeight: 700 }}>${fmt(have + (valid ? amount : 0))}</span></div>
        </div>`}
        ${seatTaken && html`<div class="note"><${Icon} name="info" />Seat ${seat + 1} was just taken — you’ll get seat ${targetSeat + 1}.</div>`}
        ${needsApproval &&
        html`<div class="note"><${Icon} name="crown" />${hostName} approves buy-ins. ${mode === 'sit' ? 'You’ll be seated once they accept.' : 'Chips arrive once they accept.'}</div>`}
        ${inHand && mode === 'rebuy' && html`<div class="note note-plain"><${Icon} name="clock" />You’re in a hand — the chips are added when it ends.</div>`}
        ${err && html`<div class="form-error" role="alert">${err}</div>`}
        <div class="dlg-actions">
          <${Button} onClick=${onClose}>Cancel<//>
          <${Button} kind="primary" type="submit" disabled=${busy}>
            ${needsApproval ? 'Request' : mode === 'sit' ? 'Sit down' : 'Add'} <span class="mono">${valid ? fmt(amount) : ''}</span>
          <//>
        </div>
      </form>`;
  }

  return html`<${Modal} open=${open} onClose=${onClose} label=${title}>
    <div class="dlg">
      <div class="dlg-head">
        <div class="dlg-icon"><${Icon} name="chips" size=${22} /></div>
        <div>
          <h2>${title}</h2>
          <div class="muted">${subtitle}</div>
        </div>
      </div>
      ${body}
    </div>
  <//>`;
}

// ─── LeaveDialog ─────────────────────────────────────────────────────────────

export function LeaveDialog({ open, onClose }) {
  const room = useRoom();
  const view = room && room.view;
  const me = view && view.me;
  const live = me ? contesting(view, me.id) : null;
  const allIn = !!(live && live.allIn);
  const [when, setWhen] = useState('after');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setWhen('after');
      setBusy(false);
    }
  }, [open]);

  // Close automatically if we're no longer seated (e.g. the host removed us meanwhile).
  useEffect(() => {
    if (open && me && me.seat == null && !busy) onClose && onClose();
  }, [open, me && me.seat]);

  if (!open || !me) return null;

  const row = ledgerRow(view, me.id);
  const stackNow = row ? row.stack : (me.stack || 0) + (me.pendingChips || 0);
  const buyIns = row ? row.buyIns : null;
  const net = row ? row.net : null;
  const handNo = view.hand ? view.hand.no : view.handNo;
  const mobile = window.matchMedia('(max-width: 899px)').matches;

  const leave = async (afterHand) => {
    setBusy(true);
    const v = await room.act('leave', afterHand ? { afterHand: true } : {});
    setBusy(false);
    if (!v) return;
    if (v.me && v.me.leaveAfterHand) toast('You’ll stand up when hand #' + handNo + ' ends.', 'brass');
    else toast('You cashed out ' + fmt(stackNow) + ' chips.', 'pos');
    onClose && onClose();
  };

  const cancelLeave = async () => {
    setBusy(true);
    const v = await room.act('cancelLeave');
    setBusy(false);
    if (v) {
      toast('You’re staying in your seat.', 'pos');
      onClose && onClose();
    }
  };

  const summary = html`<div class="summary">
    <div class="summary-row"><span class="muted">${mobile ? 'Cash out' : 'Cash out (your stack)'}</span><span class="mono" style=${{ fontWeight: 700 }}>${fmt(stackNow)}</span></div>
    ${buyIns != null && !mobile && html`<div class="summary-row"><span class="muted">Bought in</span><span class="mono">${fmt(buyIns)}</span></div>`}
    ${net != null &&
    html`<div class="summary-row"><span class="muted">Net on the ledger</span>
      <span class=${cx('mono', net > 0 && 'pos', net < 0 && 'neg')} style=${{ fontWeight: 700 }}>${fmtSigned(net)}</span></div>`}
  </div>`;

  let options = null;
  let actions;
  if (me.leaveAfterHand && me.removedByHost) {
    // The host's removal can't be cancelled by the player, so there's no "Stay seated".
    options = html`<div class="note"><${Icon} name="clock" />The host removed you — you’ll be cashed out when hand #${handNo} ends.</div>`;
    actions = html`<div class="dlg-actions">
      <${Button} onClick=${onClose}>OK<//>
    </div>`;
  } else if (me.leaveAfterHand) {
    options = html`<div class="note"><${Icon} name="clock" />You’re standing up when hand #${handNo} ends. Your stack is cashed out then.</div>`;
    actions = html`<div class="dlg-actions">
      <${Button} disabled=${busy} onClick=${cancelLeave}>Stay seated<//>
      <${Button} kind="leave" disabled=${busy || allIn} onClick=${() => leave(false)} title=${allIn ? 'You’re all-in — you’ll leave when the hand ends' : undefined}>Leave now<//>
    </div>`;
  } else {
    if (live) {
      const opt = (key, title, sub, disabled) => html`<label class=${cx('opt', when === key && 'on', disabled && 'disabled')}>
        <input type="radio" name="leave-when" checked=${when === key} disabled=${disabled} onChange=${() => setWhen(key)} />
        <span><b>${title}</b><br /><span class="muted" style=${{ fontSize: mobile ? '13px' : '14px' }}>${sub}</span></span>
      </label>`;
      options = html`<div style=${{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        ${opt('after', 'After this hand', mobile ? 'Finish hand #' + handNo + ' first' : 'Finish hand #' + handNo + ', then stand up', false)}
        ${opt('now', 'Right now', allIn ? 'Not while you’re all-in' : 'Folds your current hand', allIn)}
      </div>`;
    }
    actions = html`<div class="dlg-actions">
      <${Button} onClick=${onClose}>Stay<//>
      <${Button} kind="leave" disabled=${busy} onClick=${() => leave(!!live && (when === 'after' || allIn))}>Leave seat<//>
    </div>`;
  }

  return html`<${Modal} open=${open} onClose=${onClose} label="Leave your seat?">
    <div class="dlg">
      <div class="dlg-head">
        ${!mobile && html`<div class="dlg-icon danger"><${Icon} name="leave" size=${22} /></div>`}
        <div>
          <h2>Leave your seat?</h2>
          <div class="muted">${mobile ? 'You can stay and watch.' : 'You can stay and watch the game.'}</div>
        </div>
      </div>
      ${summary}
      ${options}
      ${actions}
    </div>
  <//>`;
}

// ─── JoinPrompt ──────────────────────────────────────────────────────────────

function savedName() {
  try {
    return localStorage.getItem('felt:name') || '';
  } catch {
    return '';
  }
}

/**
 * Name entry for a visitor with no session, shown over the spectator view of the table.
 * Uncontrolled by default (it manages its own "just watch" dismissal); pass open/onClose to control it.
 */
export function JoinPrompt({ open: openProp, onClose } = {}) {
  const room = useRoom();
  const view = room && room.view;
  const [dismissed, setDismissed] = useState(false);
  const [name, setName] = useState(savedName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const open = openProp ?? !dismissed;
  const close = () => {
    if (onClose) onClose();
    else setDismissed(true);
  };

  if (!view || (room && room.joined)) return null;

  const s = view.settings || {};
  const seated = (view.players || []).filter((p) => p.seat != null);
  const host = (view.players || []).find((p) => p.isHost);

  const submit = async (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) {
      setErr('Enter a name so the table knows who you are.');
      return;
    }
    if (n.length > 20) {
      setErr('Keep it to 20 characters.');
      return;
    }
    setBusy(true);
    const v = await room.join(n);
    setBusy(false);
    if (v && onClose) onClose();
  };

  return html`<${Modal} open=${open} onClose=${close} label=${'Join ' + view.name}>
    <form class="dlg" onSubmit=${submit} noValidate>
      <div class="dlg-head">
        <div class="dlg-icon"><${Icon} name="spade" size=${24} /></div>
        <div style=${{ minWidth: 0 }}>
          <h2>Join ${view.name}</h2>
          <div class="muted">
            ${VARIANT_NAME[s.variant] || s.variant} · Blinds <span class="mono">${fmt(s.sb)}/${fmt(s.bb)}</span>${host ? ' · hosted by ' + host.name : ''}
          </div>
        </div>
      </div>
      ${seated.length > 0 &&
      html`<div class="join-who">
        <div class="join-avatars">
          ${seated.slice(0, 7).map((p) => html`<${Avatar} key=${p.id} name=${p.name} seed=${p.seat} size=${30} />`)}
        </div>
        <span class="muted">${seated.length} seated${view.hand ? ' · hand #' + view.hand.no + ' in progress' : ''}</span>
      </div>`}
      <label class="join-field">
        <span class="label">Your name</span>
        <input
          class="field"
          data-autofocus
          maxlength="20"
          autocomplete="nickname"
          placeholder="What should the table call you?"
          value=${name}
          aria-invalid=${!!err}
          onInput=${(e) => {
            setName(e.target.value);
            setErr('');
          }}
        />
      </label>
      ${err && html`<div class="form-error" role="alert">${err}</div>`}
      <div class="dlg-actions">
        <${Button} onClick=${close}>Just watch<//>
        <${Button} kind="primary" type="submit" disabled=${busy}>${busy ? 'Joining…' : 'Join game'}<//>
      </div>
    </form>
  <//>`;
}

// ─── ConfirmDialog ───────────────────────────────────────────────────────────

/** onConfirm may be async; returning false keeps the dialog open. */
export function ConfirmDialog({ open, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => (alive.current = false), []);
  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);
  if (!open) return null;
  const confirm = async () => {
    setBusy(true);
    let r;
    try {
      r = onConfirm ? await onConfirm() : undefined;
    } finally {
      if (alive.current) setBusy(false);
    }
    if (r !== false && onClose) onClose();
  };
  return html`<${Modal} open=${open} onClose=${onClose} label=${typeof title === 'string' ? title : 'Confirm'}>
    <div class="dlg">
      <div class="dlg-head">
        <div class=${cx('dlg-icon', danger && 'danger')}><${Icon} name=${danger ? 'alert' : 'info'} size=${22} /></div>
        <div><h2>${title}</h2></div>
      </div>
      ${body && html`<div class="confirm-body muted">${body}</div>`}
      <div class="dlg-actions">
        <${Button} onClick=${onClose}>${cancelLabel}<//>
        <${Button} kind=${danger ? 'leave' : 'primary'} disabled=${busy} onClick=${confirm} data-autofocus>${confirmLabel}<//>
      </div>
    </div>
  <//>`;
}

/** The keyboard cheat sheet ("?" or the header's keyboard button). Lists every key in hotkeys.js. */
export function ShortcutsDialog({ open, onClose }) {
  return html`<${Modal}
    open=${open}
    onClose=${onClose}
    title="Keyboard shortcuts"
    subtitle="They pause while you’re typing or a dialog is open."
    class="keys-modal"
  >
    <div class="keys">
      ${HOTKEYS.map(
        (g) => html`<section class="keys-group" key=${g.title}>
          <h3 class="label keys-title">${g.title}</h3>
          ${g.note && html`<p class="muted keys-note">${g.note}</p>`}
          <dl class="keys-list">
            ${g.keys.map(
              (k, i) => html`<${Fragment} key=${i}>
                <dt>${k.keys.map((c, j) => html`<${Fragment} key=${c}>${j > 0 && html`<span class="keys-or">/</span>`}<kbd class="kc kc-lg">${c}</kbd><//>`)}</dt>
                <dd><span class="keys-label">${k.label}</span>${k.note && html`<span class="muted keys-sub">${k.note}</span>`}</dd>
              <//>`,
            )}
          </dl>
        </section>`,
      )}
    </div>
  <//>`;
}
