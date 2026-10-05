// public/js/host.js — Host tools (SPEC §6.6, §11, §12; design/Host.dc.html, design/HostMobile.dc.html).
//
//   HostTools()   requests (approve / edit amount / deny, auto-approve switch), players table
//                 (status, bought in, stack, net, Adjust chips / Set away / Remove), adjust-chips form
//                 (right column on desktop, bottom sheet on phones), table rules editor, pause / resume,
//                 copy invite link, transfer host, end game.
import { html, useState, useEffect, useRef, Fragment } from './h.js';
import { useRoom } from './room.js';
import { Button, Pill, Avatar, Icon, Switch, Seg, Modal, cx, fmt, fmtSigned, toast, copyText, inviteUrl, useIsMobile } from './ui.js';
import { ConfirmDialog } from './dialogs.js';
import { playerOf, ledgerRowOf, playerStatus, ordinal, dealtIn, clockTime } from './side.js';

const VARIANT_LONG = { NLH: 'No-Limit Hold’em', PLO: 'Pot-Limit Omaha' };
const REVEAL = { anyone: 'Anyone', winner: 'Winner only', host: 'Host only', off: 'Off' };
const LOSERS = { choose: 'Player’s choice', show: 'Always shown' };
const REASONS = [
  { label: 'Cash rebuy', count: true },
  { label: 'Miscount fix', count: false },
  { label: 'Move from player', count: false },
  { label: 'Bounty', count: false },
];

const toInt = (v) => {
  const s = String(v ?? '').replace(/[^0-9]/g, '');
  return s === '' ? NaN : Number(s);
};
const poss = (name) => name + '’s';

function ago(t, now) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  if (m < 180) return Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago';
  return 'at ' + clockTime(t);
}

// ─── requests ────────────────────────────────────────────────────────────────

function RequestRow({ req, mobile }) {
  const { view, act } = useRoom();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(req.amount));
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.select();
  }, [editing]);

  const p = playerOf(view, req.pid);
  const row = ledgerRowOf(view, req.pid);
  const count = row ? row.buyInCount : 0;
  const name = req.name || (p && p.name) || 'Someone';
  const title = req.kind === 'sit' ? `${name} wants to sit in seat ${(req.seat ?? 0) + 1}` : `${name} wants to rebuy`;
  const bits = [];
  if (req.kind === 'rebuy' && p) bits.push(p.busted || p.stack + p.pendingChips === 0 ? 'Busted' : 'Stack ' + fmt(p.stack + p.pendingChips));
  bits.push(count ? ordinal(count + 1) + ' buy-in' : 'New player');
  if (req.createdAt) bits.push(ago(req.createdAt, view.serverNow));

  const amount = toInt(text);
  const valid = Number.isInteger(amount) && amount >= 1;
  const s = view.settings;
  const outOfRange = valid && req.kind === 'sit' && (amount < s.minBuyIn || amount > s.maxBuyIn);

  const run = async (type, args) => {
    setBusy(true);
    const v = await act(type, args);
    setBusy(false);
    return v;
  };
  const approve = async () => {
    if (!valid) return;
    const v = await run('approve', amount !== req.amount ? { id: req.id, amount } : { id: req.id });
    if (v) toast(req.kind === 'sit' ? `${name} is seated with ${fmt(amount)}.` : `Approved ${poss(name)} rebuy of ${fmt(amount)}.`, 'pos');
  };
  const deny = async () => {
    const v = await run('deny', { id: req.id });
    if (v) toast(`Denied ${poss(name)} request.`, 'default');
  };

  const amountEl = editing
    ? html`<input
        ref=${inputRef}
        class="field mono req-input"
        inputmode="numeric"
        aria-label=${'Amount for ' + name}
        value=${text}
        aria-invalid=${!valid}
        onInput=${(e) => setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 9))}
        onKeyDown=${(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            approve();
          } else if (e.key === 'Escape') {
            e.stopPropagation();
            setText(String(req.amount));
            setEditing(false);
          }
        }}
      />`
    : html`<span class="mono req-amt">${fmt(valid ? amount : req.amount)}</span>`;

  return html`<div class=${cx('req', mobile && 'req-m')}>
    <div class="req-top">
      <${Avatar} name=${name} seed=${p && p.seat != null ? p.seat : name} size=${mobile ? 36 : 34} />
      <div class="req-who">
        <div class="req-title">${title}</div>
        <div class="muted req-sub">${bits.join(' · ')}</div>
      </div>
      ${amountEl}
      ${!mobile &&
      html`<div class="req-acts">
        <${Button} size="sm" onClick=${() => setEditing(!editing)} aria-pressed=${editing}>${editing ? 'Done' : 'Edit amount'}<//>
        <${Button} size="sm" kind="danger" disabled=${busy} onClick=${deny}>Deny<//>
        <${Button} size="sm" kind="primary" disabled=${busy || !valid} onClick=${approve}>Approve<//>
      </div>`}
    </div>
    ${outOfRange && html`<div class="req-warn">Outside the table’s buy-in range (<span class="mono">${fmt(s.minBuyIn)}–${fmt(s.maxBuyIn)}</span>) — you can still approve it.</div>`}
    ${mobile &&
    html`<div class="req-acts-m">
      <${Button} kind="danger" disabled=${busy} onClick=${deny}>Deny<//>
      <${Button} kind="primary" disabled=${busy || !valid} onClick=${approve}>Approve${valid && amount !== req.amount ? html` <span class="mono">${fmt(amount)}</span>` : ''}<//>
      <button type="button" class="linkbtn req-edit-m" onClick=${() => setEditing(!editing)}>${editing ? 'Done editing' : 'Edit amount'}</button>
    </div>`}
  </div>`;
}

function Requests({ mobile }) {
  const { view, act } = useRoom();
  const reqs = view.requests || [];
  const auto = !view.settings.approveBuyIns;
  return html`<section class="panel host-card host-reqs" aria-label="Requests">
    <div class="host-card-head">
      <h3>Requests ${reqs.length > 0 && html`<span class="pill pill-gold req-count mono">${reqs.length}</span>`}</h3>
      <label class="host-auto">
        <span>Auto-approve buy-ins</span>
        <${Switch} label="Auto-approve buy-ins" checked=${auto} onChange=${(on) => act('settings', { patch: { approveBuyIns: !on } })} />
      </label>
    </div>
    ${reqs.length === 0
      ? html`<p class="muted host-empty">
          ${auto ? 'Buy-ins within the table range are approved automatically.' : 'No requests right now. Seat and rebuy requests show up here for you to approve.'}
        </p>`
      : reqs.map((r) => html`<${RequestRow} key=${r.id} req=${r} mobile=${mobile} />`)}
  </section>`;
}

// ─── players ─────────────────────────────────────────────────────────────────

function useRemove() {
  const { view, act } = useRoom();
  const [target, setTarget] = useState(null);
  const p = target ? playerOf(view, target) : null;
  let body = null;
  const seated = !!(p && p.seat != null);
  if (p && !seated) {
    body = html`${p.name} leaves this game, which frees their spot and their name. They can only come back by joining again with the invite link.`;
  } else if (p) {
    const hp = view.hand && view.hand.phase !== 'complete' ? (view.hand.players || []).find((x) => x.pid === p.id) : null;
    const row = ledgerRowOf(view, p.id);
    body = html`${p.name} is cashed out for <b class="mono">${fmt(p.stack + p.pendingChips)}</b> chips and goes back to watching.
      ${hp && !hp.folded && (hp.allIn ? ' They’re all-in, so they leave when this hand ends.' : ' Their current hand is folded.')}
      ${row && html` Net on the ledger: <b class=${cx('mono', row.net > 0 && 'pos', row.net < 0 && 'neg')}>${fmtSigned(row.net)}</b>.`}`;
  }
  const dialog = html`<${ConfirmDialog}
    open=${!!p}
    title=${p ? (seated ? `Remove ${p.name} from the table?` : `Remove ${p.name} from the game?`) : ''}
    body=${body}
    confirmLabel="Remove"
    danger=${true}
    onConfirm=${async () => {
      const name = p.name;
      const wasSeated = p.seat != null;
      const v = await act('remove', { pid: p.id });
      if (!v) return false;
      toast(wasSeated ? `${name} was removed from the table.` : `${name} was removed from the game.`, 'default');
      return true;
    }}
    onClose=${() => setTarget(null)}
  />`;
  return [setTarget, dialog];
}

const PILL_TONE = { away: 'brass', busted: 'danger', leaving: 'danger', waiting: 'brass' };

function PlayersTable({ selected, onAdjust, onRemove }) {
  const { view, act } = useRoom();
  const me = view.me;
  const list = (view.players || []).slice().sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
  const t = view.ledger.totals;
  return html`<section class="panel host-card host-players" aria-label="Players">
    <div class="host-card-head host-pad">
      <h3>Players</h3>
      <span class="muted host-chips">Chips in play <span class="mono">${fmt(t.chipsOnTable)}</span></span>
    </div>
    <div class="host-scroll">
      <table class="tbl host-tbl">
        <thead>
          <tr>
            <th>Player</th>
            <th>Status</th>
            <th class="num">Bought in</th>
            <th class="num">Stack</th>
            <th class="num">Net</th>
            <th><span class="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          ${list.map((p) => {
            const row = ledgerRowOf(view, p.id);
            const st = playerStatus(view, p, { long: true });
            const seated = p.seat != null;
            const mine = me && p.id === me.id;
            const net = row ? row.net : 0;
            return html`<tr key=${p.id} class=${cx(selected === p.id && 'sel', !seated && 'is-out')}>
              <td>
                <div class="tbl-who">
                  <${Avatar} name=${p.name} seed=${p.seat ?? p.name} size=${34} />
                  <span class="tbl-name">${p.name}</span>
                  ${p.isHost && html`<span class="tbl-crown" title="Host"><${Icon} name="crown" size=${14} /></span>`}
                  ${mine && html`<span class="muted tbl-you">you</span>`}
                </div>
              </td>
              <td><${Pill} tone=${PILL_TONE[st.key] || 'default'}>${st.label}<//></td>
              <td class="num mono">${row ? fmt(row.buyIns) : '—'}</td>
              <td class="num mono brass">${seated ? fmt(row ? row.stack : p.stack) : '—'}</td>
              <td class=${cx('num', 'mono', net > 0 && 'pos', net < 0 && 'neg')}>${row ? fmtSigned(net) : '—'}</td>
              <td class="tbl-acts">
                ${seated &&
                html`<div class="tbl-btns">
                  <${Button} size="sm" class=${cx(selected === p.id && 'is-on')} onClick=${() => onAdjust(p.id)}>Adjust chips<//>
                  <${Button} size="sm" onClick=${() => act('setAway', { pid: p.id, on: !p.away })}>${p.away ? 'Bring back' : 'Set away'}<//>
                  ${!mine
                    ? html`<${Button} size="sm" kind="danger" class="btn-icon" aria-label=${'Remove ' + p.name + ' from seat'} title="Remove from seat" onClick=${() => onRemove(p.id)}>
                        <${Icon} name="leave" size=${15} />
                      <//>`
                    : html`<span class="tbl-btn-gap" aria-hidden="true"></span>`}
                </div>`}
                ${!seated &&
                !mine &&
                html`<div class="tbl-btns">
                  <${Button} size="sm" kind="danger" class="btn-icon" aria-label=${'Remove ' + p.name + ' from the game'} title="Remove from the game" onClick=${() => onRemove(p.id)}>
                    <${Icon} name="close" size=${15} />
                  <//>
                </div>`}
              </td>
            </tr>`;
          })}
        </tbody>
      </table>
    </div>
  </section>`;
}

/** Phone: compact rows (design/HostMobile.dc.html); tap a seated player for the adjust sheet. */
function PlayersListM({ onAdjust, onRemove }) {
  const { view } = useRoom();
  const me = view.me;
  const list = (view.players || []).slice().sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
  return html`<section class="panel host-card host-plist-m" aria-label="Players">
    <div class="host-card-head">
      <h3>Players</h3>
      <span class="muted host-chips">In play <span class="mono">${fmt(view.ledger.totals.chipsOnTable)}</span></span>
    </div>
    ${list.map((p) => {
      const row = ledgerRowOf(view, p.id);
      const st = playerStatus(view, p, { long: true });
      const seated = p.seat != null;
      const net = row ? row.net : 0;
      const inner = html`
        <${Avatar} name=${p.name} seed=${p.seat ?? p.name} size=${36} />
        <span class="prow-who">
          <span class="prow-name">${p.name}${p.isHost && html`<${Icon} name="crown" size=${13} class="tbl-crown" />`}</span>
          <span class=${cx('prow-st', PILL_TONE[st.key] === 'danger' && 'neg', PILL_TONE[st.key] === 'brass' && 'brass')}>${st.label}${row ? html` · <span class=${cx('mono', net > 0 && 'pos', net < 0 && 'neg')}>${fmtSigned(net)}</span>` : ''}</span>
        </span>
        ${seated && html`<span class="mono brass prow-stack">${fmt(row ? row.stack : p.stack)}</span>`}
        ${seated && html`<${Icon} name="chevron" size=${16} class="prow-go" />`}`;
      return seated
        ? html`<button type="button" key=${p.id} class="prow" onClick=${() => onAdjust(p.id)} aria-label=${'Manage ' + p.name}>${inner}</button>`
        : html`<div key=${p.id} class="prow is-out">
            ${inner}
            ${!(me && p.id === me.id) &&
            html`<${Button} size="sm" kind="danger" class="btn-icon prow-x" aria-label=${'Remove ' + p.name + ' from the game'} title="Remove from the game" onClick=${() => onRemove(p.id)}>
              <${Icon} name="close" size=${15} />
            <//>`}
          </div>`;
    })}
  </section>`;
}

// ─── adjust chips ────────────────────────────────────────────────────────────

function AdjustForm({ pid, onClose, mobile, onRemove }) {
  const { view, act } = useRoom();
  const p = playerOf(view, pid);
  const row = ledgerRowOf(view, pid);
  const [mode, setMode] = useState('add');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('Cash rebuy');
  const [count, setCount] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    setMode('add');
    setText('');
    setReason('Cash rebuy');
    setCount(true);
    setErr('');
    if (!mobile && inputRef.current) inputRef.current.focus({ preventScroll: true });
  }, [pid]);

  if (!p || p.seat == null) {
    return html`<div class="adjust-gone">
      <p class="muted">${p ? p.name + ' isn’t seated any more.' : 'That player left the game.'}</p>
      <${Button} onClick=${onClose}>Close<//>
    </div>`;
  }

  const before = p.stack + (p.pendingChips || 0);
  const amount = toInt(text);
  const has = Number.isInteger(amount);
  const valid = has && (mode === 'set' ? amount >= 0 : amount >= 1);
  const after = !valid ? before : mode === 'add' ? before + amount : mode === 'remove' ? Math.max(0, before - amount) : amount;
  const delta = after - before;
  const pending = dealtIn(view, pid);
  const hp = view.hand && view.hand.phase !== 'complete' ? (view.hand.players || []).find((x) => x.pid === pid) : null;
  const inPot = hp ? hp.committed : 0;
  const handNo = view.hand ? view.hand.no : view.handNo;
  const buyIns = row ? row.buyIns : 0;

  const submitLabel = !valid
    ? mode === 'set'
      ? 'Set stack'
      : mode === 'add'
        ? 'Add chips'
        : 'Remove chips'
    : mode === 'add'
      ? html`Add <span class="mono">${fmt(amount)}</span> chips`
      : mode === 'remove'
        ? html`Remove <span class="mono">${fmt(Math.min(amount, before) || amount)}</span> chips`
        : html`Set stack to <span class="mono">${fmt(amount)}</span>`;

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!valid) {
      setErr(mode === 'set' ? 'Enter the new stack (0 or more).' : 'Enter a number of chips (at least 1).');
      return;
    }
    if (!pending && delta === 0) {
      setErr('That doesn’t change ' + poss(p.name) + ' stack.');
      return;
    }
    setBusy(true);
    const v = await act('adjust', { pid, mode, amount, reason: reason || null, countAsBuyIn: count });
    setBusy(false);
    if (!v) return;
    toast(pending ? `Queued for ${p.name} — applies when hand #${handNo} ends.` : `${poss(p.name)} stack is now ${fmt(after)}.`, pending ? 'brass' : 'pos');
    onClose();
  };

  return html`<form class=${cx('adjust', mobile ? 'adjust-m' : 'panel adjust-card')} onSubmit=${submit} noValidate aria-label=${'Adjust ' + poss(p.name) + ' chips'}>
    <div class="adjust-head">
      <${Avatar} name=${p.name} seed=${p.seat} size=${44} />
      <div class="adjust-title">
        <div class="adjust-name">Adjust ${poss(p.name)} chips</div>
        <div class="muted adjust-sub">
          ${mobile ? 'Stack' : 'Current stack'} <span class="mono">${fmt(before)}</span>${p.pendingChips > 0 ? html` · incl. <span class="mono">${fmt(p.pendingChips)}</span> pending` : ''}${inPot > 0 ? html` · <span class="mono">${fmt(inPot)}</span> in the pot` : ''}
        </div>
      </div>
      ${!mobile && html`<${Button} size="sm" class="btn-icon" aria-label="Close" onClick=${onClose}><${Icon} name="close" size=${16} /><//>`}
    </div>
    ${mobile &&
    html`<div class="adjust-quick">
      <${Button} onClick=${() => act('setAway', { pid, on: !p.away })}>${p.away ? 'Bring back' : 'Set away'}<//>
      ${view.me && view.me.id === pid ? html`<span></span>` : html`<${Button} kind="danger" onClick=${() => onRemove(pid)}>Remove from seat<//>`}
    </div>`}
    <${Seg}
      label="Adjustment"
      value=${mode}
      onChange=${(m) => {
        setMode(m);
        setErr('');
      }}
      options=${[
        { value: 'add', label: 'Add' },
        { value: 'remove', label: 'Remove' },
        { value: 'set', label: 'Set to' },
      ]}
    />
    <div class=${cx('adjust-amt', mobile && 'is-row')}>
      <label class="adjust-amt-field">
        ${!mobile && html`<span class="adjust-lbl">Amount</span>`}
        <input
          ref=${inputRef}
          class="field mono adjust-input"
          inputmode="numeric"
          autocomplete="off"
          aria-label="Amount"
          placeholder=${mode === 'set' ? String(before) : '0'}
          value=${text}
          aria-invalid=${!!err}
          onInput=${(e) => {
            setText(e.target.value.replace(/[^0-9]/g, '').slice(0, 9));
            setErr('');
          }}
        />
      </label>
      <div class="adjust-preview" aria-live="polite">
        <span class="mono muted adjust-before">${fmt(before)}</span>
        <${Icon} name="arrow" size=${mobile ? 18 : 22} class="muted" />
        <span class=${cx('mono', 'adjust-after', valid && delta < 0 && 'is-down')}>${fmt(after)}</span>
      </div>
    </div>
    <div class="adjust-reasons">
      ${!mobile && html`<span class="adjust-lbl">Reason</span>`}
      <div class="chipbtns" role="group" aria-label="Reason">
        ${REASONS.map(
          (r) => html`<button
            type="button"
            key=${r.label}
            class=${cx('chipbtn', reason === r.label && 'on')}
            aria-pressed=${reason === r.label}
            onClick=${() => {
              if (reason === r.label) setReason('');
              else {
                setReason(r.label);
                setCount(r.count);
              }
            }}
          >${r.label}</button>`,
        )}
      </div>
    </div>
    <label class="adjust-count">
      <input type="checkbox" checked=${count} onChange=${(e) => setCount(e.target.checked)} />
      <span>
        Count as a buy-in on the ledger
        ${!mobile &&
        html`<span class="muted adjust-count-sub">
          ${count
            ? html`${poss(p.name)} buy-ins go from <span class="mono">${fmt(buyIns)}</span> to <span class="mono">${fmt(buyIns + (valid ? delta : 0))}</span>`
            : 'Recorded as an adjustment only — buy-ins stay at ' + fmt(buyIns)}
        </span>`}
      </span>
    </label>
    ${pending &&
    html`<div class="note"><${Icon} name="alert" /><span>${mobile
        ? html`Applies when hand <span class="mono">#${handNo}</span> ends.`
        : html`Hand <span class="mono">#${handNo}</span> is in progress — the change applies when it ends.`}</span></div>`}
    ${err && html`<div class="form-error" role="alert">${err}</div>`}
    <div class="dlg-actions">
      <${Button} onClick=${onClose}>Cancel<//>
      <${Button} kind="primary" type="submit" disabled=${busy}>${submitLabel}<//>
    </div>
  </form>`;
}

// ─── table rules ─────────────────────────────────────────────────────────────

const RULE_FIELDS = ['variant', 'sb', 'bb', 'minBuyIn', 'maxBuyIn', 'seats', 'maxRuns', 'revealRunout', 'showdownLosers', 'actionTime', 'nextHandDelay', 'autoAwayTimeouts'];
const NUMERIC = new Set(['sb', 'bb', 'minBuyIn', 'maxBuyIn', 'seats', 'maxRuns', 'actionTime', 'nextHandDelay', 'autoAwayTimeouts']);

function RuleRow({ label, children }) {
  return html`<div class="rule"><span>${label}</span><span class="rule-v">${children}</span></div>`;
}

function NumField({ label, value, onChange, suffix, min, max }) {
  return html`<label class="rule-num">
    <input
      class="field mono"
      inputmode="numeric"
      aria-label=${label}
      value=${value}
      onInput=${(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 7))}
      onBlur=${() => {
        const n = toInt(value);
        if (Number.isInteger(n) && min != null && max != null) onChange(String(Math.min(max, Math.max(min, n))));
      }}
    />
    ${suffix && html`<span class="muted">${suffix}</span>`}
  </label>`;
}

function Rules() {
  const { view, act } = useRoom();
  const s = view.settings;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const start = () => {
    const d = {};
    for (const k of RULE_FIELDS) d[k] = NUMERIC.has(k) ? String(s[k]) : s[k];
    setDraft(d);
    setErr('');
    setEditing(true);
  };
  const set = (k) => (v) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErr('');
  };

  const highestSeat = Math.max(-1, ...(view.players || []).filter((p) => p.seat != null).map((p) => p.seat));

  const save = async (e) => {
    e.preventDefault();
    const patch = {};
    for (const k of RULE_FIELDS) {
      const v = NUMERIC.has(k) ? toInt(draft[k]) : draft[k];
      if (NUMERIC.has(k) && !Number.isInteger(v)) {
        setErr('Fill in every number.');
        return;
      }
      if (v !== s[k]) patch[k] = v;
    }
    const sb = patch.sb ?? s.sb;
    const bb = patch.bb ?? s.bb;
    const lo = patch.minBuyIn ?? s.minBuyIn;
    const hi = patch.maxBuyIn ?? s.maxBuyIn;
    if (sb < 1 || bb < sb) return setErr('The big blind must be at least the small blind (both ≥ 1).');
    if (lo < 1 || hi < lo) return setErr('The maximum buy-in can’t be below the minimum.');
    if ((patch.seats ?? s.seats) < highestSeat + 1) return setErr(`Seat ${highestSeat + 1} is taken, so the table needs at least ${highestSeat + 1} seats.`);
    if (!Object.keys(patch).length) {
      setEditing(false);
      return;
    }
    setBusy(true);
    const v = await act('settings', { patch });
    setBusy(false);
    if (!v) return;
    toast(view.hand && view.hand.phase !== 'complete' ? 'Rules saved — they apply from the next hand.' : 'Rules saved.', 'pos');
    setEditing(false);
  };

  if (!editing || !draft) {
    return html`<section class="panel host-card host-rules" aria-label="Table rules">
      <div class="host-card-head"><h3>Table rules</h3></div>
      <${RuleRow} label="Game">${VARIANT_LONG[s.variant] || s.variant}<//>
      <${RuleRow} label="Blinds"><span class="mono">${fmt(s.sb)} / ${fmt(s.bb)}</span><//>
      <${RuleRow} label="Buy-in range"><span class="mono">${fmt(s.minBuyIn)} – ${fmt(s.maxBuyIn)}</span><//>
      <${RuleRow} label="Seats"><span class="mono">${s.seats}</span><//>
      <${RuleRow} label="Run it more than once">
        <span class="muted rule-hint">${s.maxRuns > 1 ? 'up to ' + s.maxRuns + '×' : ''}</span>
        <${Switch} label="Run it more than once" checked=${s.maxRuns > 1} onChange=${(on) => act('settings', { patch: { maxRuns: on ? 2 : 1 } })} />
      <//>
      <${RuleRow} label="Reveal runout after a fold"><span class="muted">${REVEAL[s.revealRunout] || s.revealRunout}</span><//>
      <${RuleRow} label="Losing hands at showdown"><span class="muted">${LOSERS[s.showdownLosers] || s.showdownLosers}</span><//>
      <${RuleRow} label="Action timer"><span class="mono">${s.actionTime}s</span><//>
      <${RuleRow} label="Time between hands"><span class="mono">${s.nextHandDelay}s</span><//>
      <${RuleRow} label="Auto-away">${s.autoAwayTimeouts ? html`<span>after <span class="mono">${s.autoAwayTimeouts}</span> timeout${s.autoAwayTimeouts === 1 ? '' : 's'}</span>` : html`<span class="muted">Never</span>`}<//>
      <button type="button" class="linkbtn rule-edit" onClick=${start}>Edit rules (applies next hand)</button>
    </section>`;
  }

  return html`<form class="panel host-card host-rules is-editing" onSubmit=${save} noValidate aria-label="Edit table rules">
    <div class="host-card-head"><h3>Table rules</h3><span class="muted host-chips">Applies next hand</span></div>
    <div class="rule rule-block">
      <span>Game</span>
      <${Seg} small label="Game" value=${draft.variant} onChange=${set('variant')} options=${[{ value: 'NLH', label: 'Hold’em' }, { value: 'PLO', label: 'Omaha' }]} />
    </div>
    <${RuleRow} label="Blinds">
      <span class="rule-pair">
        <${NumField} label="Small blind" value=${draft.sb} onChange=${set('sb')} />
        <span class="muted">/</span>
        <${NumField} label="Big blind" value=${draft.bb} onChange=${set('bb')} />
      </span>
    <//>
    <${RuleRow} label="Buy-in range">
      <span class="rule-pair">
        <${NumField} label="Minimum buy-in" value=${draft.minBuyIn} onChange=${set('minBuyIn')} />
        <span class="muted">–</span>
        <${NumField} label="Maximum buy-in" value=${draft.maxBuyIn} onChange=${set('maxBuyIn')} />
      </span>
    <//>
    <${RuleRow} label="Seats">
      <select class="field rule-select" aria-label="Seats" value=${draft.seats} onChange=${(e) => set('seats')(e.target.value)}>
        ${[2, 3, 4, 5, 6, 7, 8, 9].map((n) => html`<option key=${n} value=${String(n)} disabled=${n < highestSeat + 1}>${n}</option>`)}
      </select>
    <//>
    <div class="rule rule-block">
      <span>Run it more than once</span>
      <${Seg} small label="Run it" value=${String(draft.maxRuns)} onChange=${set('maxRuns')} options=${[{ value: '1', label: 'Once' }, { value: '2', label: 'Twice' }, { value: '3', label: '3×' }]} />
    </div>
    <${RuleRow} label="Reveal runout after a fold">
      <select class="field rule-select" aria-label="Who can reveal the runout" value=${draft.revealRunout} onChange=${(e) => set('revealRunout')(e.target.value)}>
        ${Object.entries(REVEAL).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
      </select>
    <//>
    <${RuleRow} label="Losing hands at showdown">
      <select class="field rule-select" aria-label="Losing hands at showdown" value=${draft.showdownLosers} onChange=${(e) => set('showdownLosers')(e.target.value)}>
        ${Object.entries(LOSERS).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
      </select>
    <//>
    <${RuleRow} label="Action timer"><${NumField} label="Action timer in seconds" value=${draft.actionTime} onChange=${set('actionTime')} suffix="s" min=${10} max=${120} /><//>
    <${RuleRow} label="Time between hands"><${NumField} label="Seconds between hands" value=${draft.nextHandDelay} onChange=${set('nextHandDelay')} suffix="s" min=${3} max=${30} /><//>
    <${RuleRow} label="Auto-away after">
      <select class="field rule-select" aria-label="Auto-away after timeouts" value=${draft.autoAwayTimeouts} onChange=${(e) => set('autoAwayTimeouts')(e.target.value)}>
        <option value="0">Never</option>
        ${[1, 2, 3, 4, 5].map((n) => html`<option key=${n} value=${String(n)}>${n} timeout${n === 1 ? '' : 's'}</option>`)}
      </select>
    <//>
    ${err && html`<div class="form-error" role="alert">${err}</div>`}
    <div class="dlg-actions rule-actions">
      <${Button} onClick=${() => setEditing(false)}>Cancel<//>
      <${Button} kind="primary" type="submit" disabled=${busy}>Save rules<//>
    </div>
  </form>`;
}

// ─── game controls ───────────────────────────────────────────────────────────

function PauseButton({ block }) {
  const { view, act } = useRoom();
  const cls = cx(block && 'btn-block');
  if (view.paused) return html`<${Button} kind="primary" class=${cls} onClick=${() => act('pause', { on: false })}><${Icon} name="play" size=${16} />Resume<//>`;
  if (view.pauseAfterHand) return html`<${Button} class=${cls} onClick=${() => act('pause', { on: false })}><${Icon} name="play" size=${16} />Keep playing<//>`;
  return html`<${Button} class=${cls} onClick=${() => act('pause', { on: true })}><${Icon} name="pause" size=${16} />${view.hand ? 'Pause after hand' : 'Pause'}<//>`;
}

async function copyInvite(code) {
  const ok = await copyText(inviteUrl(code));
  toast(ok ? 'Invite link copied.' : 'Couldn’t copy — the link is ' + inviteUrl(code), ok ? 'pos' : 'danger');
}

function useEndGame() {
  const { view, act } = useRoom();
  const [open, setOpen] = useState(false);
  const running = !!(view.hand && view.hand.phase !== 'complete');
  const dialog = html`<${ConfirmDialog}
    open=${open}
    title="End the game?"
    body=${html`Everyone is cashed out at their current stack and the table closes for good. The ledger stays open so you can settle up.${running
      ? html` Hand <span class="mono">#${view.hand.no}</span> is played out first.`
      : ''}`}
    confirmLabel=${running ? 'End after this hand' : 'End game'}
    danger=${true}
    onConfirm=${async () => {
      const v = await act('endGame');
      if (!v) return false;
      toast(v.ended ? 'The game has ended.' : 'The game ends when this hand is over.', 'brass');
      return true;
    }}
    onClose=${() => setOpen(false)}
  />`;
  return [() => setOpen(true), dialog];
}

function Transfer() {
  const { view, act } = useRoom();
  const me = view.me;
  const others = (view.players || []).filter((p) => !me || p.id !== me.id);
  const [pid, setPid] = useState('');
  const [confirm, setConfirm] = useState(false);
  const target = others.find((p) => p.id === pid);
  if (!others.length) return null;
  return html`<section class="panel host-card host-transfer" aria-label="Transfer host">
    <div class="host-card-head"><h3>Transfer host</h3></div>
    <p class="muted host-help">Hand the host tools to another player. You keep your seat.</p>
    <div class="transfer-row">
      <select class="field" aria-label="New host" value=${pid} onChange=${(e) => setPid(e.target.value)}>
        <option value="">Choose a player…</option>
        ${others.map((p) => html`<option key=${p.id} value=${p.id}>${p.name}${p.seat == null ? ' (watching)' : ''}</option>`)}
      </select>
      <${Button} disabled=${!target} onClick=${() => setConfirm(true)}>Transfer<//>
    </div>
    <${ConfirmDialog}
      open=${confirm && !!target}
      title=${target ? `Make ${target.name} the host?` : ''}
      body=${target ? `${target.name} gets the host tools: approving buy-ins, adjusting chips, the rules and ending the game. You can’t undo this yourself.` : ''}
      confirmLabel="Transfer host"
      onConfirm=${async () => {
        const v = await act('transferHost', { pid: target.id });
        if (!v) return false;
        toast(`${target.name} is now the host.`, 'pos');
        return true;
      }}
      onClose=${() => setConfirm(false)}
    />
  </section>`;
}

// ─── HostTools ───────────────────────────────────────────────────────────────

export function HostTools() {
  const { view } = useRoom();
  const mobile = useIsMobile();
  const [adjustPid, setAdjustPid] = useState(null);
  const [askRemove, removeDialog] = useRemove();
  const [askEnd, endDialog] = useEndGame();

  // Drop the form if that player stood up meanwhile.
  const target = adjustPid ? playerOf(view, adjustPid) : null;
  useEffect(() => {
    if (adjustPid && (!target || target.seat == null)) setAdjustPid(null);
  }, [adjustPid, target && target.seat]);

  if (!view.isHost) return html`<p class="muted">Only the host can use these tools.</p>`;
  if (view.ended) {
    return html`<div class="host">
      <div class="note note-plain"><${Icon} name="info" /><span>This game has ended — everyone was cashed out. Settle up from the ledger.</span></div>
    </div>`;
  }

  const seated = (view.players || []).filter((p) => p.seat != null).length;
  const h = view.hand;
  const status = view.endAfterHand
    ? 'Ending after this hand'
    : view.paused
      ? 'Paused'
      : view.pauseAfterHand
        ? 'Pausing after this hand'
        : h
          ? `Hand #${h.no} ${h.phase === 'complete' ? 'finishing' : 'in progress'}`
          : 'Between hands';

  const remove = (pid) => {
    askRemove(pid);
  };

  if (mobile) {
    return html`<div class="host host-m">
      <${Requests} mobile=${true} />
      <${PlayersListM} onAdjust=${setAdjustPid} onRemove=${remove} />
      <section class="panel host-card host-game" aria-label="Game">
        <div class="host-card-head"><h3>Game</h3><span class="muted host-chips">${status}</span></div>
        <div class="host-game-grid">
          <${PauseButton} block=${true} />
          <${Button} class="btn-block" onClick=${() => copyInvite(view.code)}><${Icon} name="link" size=${16} />Invite link<//>
        </div>
        <${Button} kind="danger" class="btn-block" disabled=${view.endAfterHand} onClick=${askEnd}>${view.endAfterHand ? 'Ending after this hand' : 'End game'}<//>
      </section>
      <${Rules} />
      <${Transfer} />
      <${Modal} open=${!!target && target.seat != null} onClose=${() => setAdjustPid(null)} label="Adjust chips" class="adjust-sheet">
        ${target && html`<${AdjustForm} pid=${adjustPid} mobile=${true} onClose=${() => setAdjustPid(null)} onRemove=${(pid) => {
          setAdjustPid(null);
          remove(pid);
        }} />`}
      <//>
      ${removeDialog}${endDialog}
    </div>`;
  }

  return html`<div class="host">
    <div class="host-bar">
      <div class="host-status">
        <span class=${cx('host-status-dot', (view.paused || view.endAfterHand) && 'is-off', view.pauseAfterHand && 'is-soon')}></span>
        <span>${status}</span>
        <span class="muted">· ${seated} seated${(view.requests || []).length ? ' · ' + view.requests.length + ' waiting' : ''}</span>
      </div>
      <div class="host-bar-btns">
        <${PauseButton} />
        <${Button} onClick=${() => copyInvite(view.code)}><${Icon} name="link" size=${16} />Copy invite link<//>
        <${Button} kind="danger" disabled=${view.endAfterHand} onClick=${askEnd}>${view.endAfterHand ? 'Ending after this hand' : 'End game'}<//>
      </div>
    </div>
    <div class="host-cols">
      <div class="host-main">
        <${Requests} />
        <${PlayersTable} selected=${adjustPid} onAdjust=${(pid) => setAdjustPid(adjustPid === pid ? null : pid)} onRemove=${remove} />
      </div>
      <div class="host-side">
        ${target && target.seat != null && html`<${AdjustForm} pid=${adjustPid} onClose=${() => setAdjustPid(null)} />`}
        <${Rules} />
        <${Transfer} />
      </div>
    </div>
    ${removeDialog}${endDialog}
  </div>`;
}
