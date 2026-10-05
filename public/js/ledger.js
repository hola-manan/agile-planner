// public/js/ledger.js — the Ledger (SPEC §7, §11, §12; design/Ledger.dc.html, design/LedgerMobile.dc.html).
//
//   Ledger()   tiles (bought in, chips on table + balanced, biggest winner, session), players with
//              centred net bars, settle-up (host ticks payments), activity feed, Export CSV, Copy summary.
import { html, useState, Fragment } from './h.js';
import { useRoom } from './room.js';
import { Button, Pill, Avatar, Icon, cx, fmt, fmtSigned, toast, copyText, useIsMobile } from './ui.js';
import { seedOf, clockTime } from './side.js';

const FEED_PREVIEW = 8;

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h ? h + 'h ' + String(m % 60).padStart(2, '0') + 'm' : m + 'm';
}

/** First / last activity time from the ledger (entries are newest first, last 200). */
function sessionSpan(view) {
  const es = (view.ledger && view.ledger.entries) || [];
  if (!es.length) return null;
  let a = Infinity;
  let b = -Infinity;
  for (const e of es) {
    if (Number.isFinite(e.t)) {
      a = Math.min(a, e.t);
      b = Math.max(b, e.t);
    }
  }
  if (!Number.isFinite(a)) return null;
  // Live: up to now — unless the table has sat idle for half a day, then the last activity.
  const now = view.serverNow || b;
  const end = view.ended || now - b > 12 * 3600000 ? b : Math.max(b, now);
  return { start: a, end, ms: end - a };
}

const poss = (name) => (name === 'You' ? 'your' : name + '’s');

/** One human sentence per ledger entry. */
export function describeEntry(e, view) {
  const meId = view.me ? view.me.id : null;
  const who = e.pid === meId ? 'You' : e.name || 'Someone';
  const by = e.by && e.by === meId ? 'You' : e.byName || 'The host';
  const amt = fmt(Math.abs(e.amount));
  const extra = [];
  let text;
  if (e.type === 'buyin') {
    const what = e.kind === 'rebuy' ? 'rebuy' : 'buy-in';
    if (e.by && e.by !== e.pid) text = `${by} approved ${poss(who)} ${what} of ${amt}`;
    else text = e.kind === 'rebuy' ? `${who} rebought for ${amt}` : `${who} bought in for ${amt}`;
  } else if (e.type === 'cashout') {
    if (e.reason === 'Removed by host') text = `${by} removed ${who === 'You' ? 'you' : who} from the table · cashed out ${amt}`;
    else text = Number(e.amount) > 0 ? `${who} cashed out ${amt}` : `${who} left the table with nothing`;
    if (e.reason === 'Game ended') extra.push('game ended');
  } else if (e.type === 'adjust') {
    const target = who === 'You' ? 'you' : who;
    if (e.mode === 'set') text = `${by} set ${poss(who)} stack to ${fmt(e.target)} (${fmtSigned(e.amount)})`;
    else if (e.amount >= 0) text = `${by} added ${amt} to ${target}`;
    else text = `${by} removed ${amt} from ${target}`;
    if (e.reason) extra.push(e.reason.toLowerCase());
    if (e.countAsBuyIn) extra.push('counted as a buy-in');
  } else text = `${who} · ${e.type} ${amt}`;
  return { text, extra: extra.join(' · '), hand: e.hand };
}

// ─── export ──────────────────────────────────────────────────────────────────

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function isoLocal(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ledgerCsv(view) {
  const L = view.ledger;
  const T = L.totals;
  const rows = [];
  rows.push(['Game', view.name], ['Room', view.code], ['Hands played', T.hands], ['Exported', isoLocal(Date.now())], []);
  rows.push(['Player', 'Buy-ins', 'Buy-in count', 'Cashed out', 'Stack', 'Net']);
  for (const p of L.players) rows.push([p.name, p.buyIns, p.buyInCount, p.cashOuts, p.stack, p.net]);
  rows.push(['Total', T.buyIns, T.buyInCount, T.cashedOut, T.chipsOnTable, T.diff]);
  rows.push([], ['Balanced', T.balanced ? 'yes' : 'no (off by ' + T.diff + ')'], []);
  rows.push(['Settle up: from', 'To', 'Amount', 'Paid']);
  for (const s of L.settlement) rows.push([s.fromName, s.toName, s.amount, s.paid ? 'yes' : 'no']);
  rows.push([], ['Time', 'Type', 'Player', 'Amount', 'Counted as buy-in', 'Reason', 'By', 'Hand']);
  for (const e of L.entries.slice().reverse()) {
    const type = e.type === 'buyin' ? (e.kind === 'rebuy' ? 'rebuy' : 'buy-in') : e.type === 'cashout' ? 'cash-out' : 'adjustment';
    rows.push([isoLocal(e.t), type, e.name, e.amount, e.type === 'cashout' ? '' : e.countAsBuyIn ? 'yes' : 'no', e.reason || '', e.byName || '', e.hand ?? '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function downloadCsv(view) {
  try {
    const blob = new Blob(['﻿' + ledgerCsv(view)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    a.href = url;
    a.download = `felt-${view.code}-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Ledger exported.', 'pos');
  } catch {
    toast('Couldn’t export the ledger from this browser.');
  }
}

export function ledgerSummaryText(view) {
  const L = view.ledger;
  const T = L.totals;
  const span = sessionSpan(view);
  const lines = [];
  lines.push(`${view.name} (${view.code}) — ${view.ended ? 'final' : 'after hand #' + T.hands}${span ? ' · ' + duration(span.ms) : ''}`);
  lines.push(`Bought in ${fmt(T.buyIns)} · ${view.ended ? 'Cashed out ' + fmt(T.cashedOut) : 'On table ' + fmt(T.chipsOnTable)} · ${T.balanced ? 'Balanced' : 'Off by ' + fmtSigned(T.diff)}`);
  lines.push('');
  const w = Math.max(6, ...L.players.map((p) => p.name.length));
  for (const p of L.players) lines.push(`${p.name.padEnd(w)}  ${fmtSigned(p.net).padStart(7)}   (in ${fmt(p.buyIns)})`);
  if (L.settlement.length) {
    lines.push('', 'Settle up:');
    for (const s of L.settlement) lines.push(`${s.paid ? '✓' : '•'} ${s.fromName} pays ${s.toName} ${fmt(s.amount)}${s.paid ? ' (paid)' : ''}`);
  }
  return lines.join('\n');
}

async function copySummary(view) {
  const ok = await copyText(ledgerSummaryText(view));
  toast(ok ? 'Summary copied — paste it in the group chat.' : 'Couldn’t copy the summary.', ok ? 'pos' : 'danger');
}

// ─── pieces ──────────────────────────────────────────────────────────────────

function NetBar({ net, max, small }) {
  const w = max > 0 ? (Math.abs(net) / max) * 50 : 0;
  const left = net >= 0 ? 50 : 50 - w;
  return html`<div class=${cx('netbar', small && 'netbar-sm')} aria-hidden="true">
    ${!small && html`<span class="netbar-mid"></span>`}
    <span class=${cx('netbar-fill', net > 0 && 'is-pos', net < 0 && 'is-neg')} style=${{ left: left + '%', width: Math.max(w, net === 0 ? 0 : 1.5) + '%' }}></span>
  </div>`;
}

function Tiles({ view, mobile }) {
  const T = view.ledger.totals;
  const span = sessionSpan(view);
  const top = T.biggestWinner;
  const uncounted = !T.balanced && T.diff === T.uncountedAdjust;
  const balance = T.balanced
    ? html`<span class="tile-sub pos"><${Icon} name="check" size=${14} stroke=${2.5} /><span>Balanced</span></span>`
    : html`<span class="tile-sub neg" title=${uncounted ? 'Chip adjustments that were not counted as buy-ins' : ''}>
        <${Icon} name="alert" size=${14} /><span>Off by <span class="mono">${fmtSigned(T.diff)}</span>${uncounted && !mobile ? ' · uncounted adjustments' : ''}</span>
      </span>`;
  return html`<div class="ltiles">
    <div class="panel ltile">
      <span class="label">${mobile ? 'Bought in' : 'Total bought in'}</span>
      <span class="ltile-v mono">${fmt(T.buyIns)}</span>
      <span class="tile-sub muted">${T.buyInCount} buy-in${T.buyInCount === 1 ? '' : 's'} · ${T.players} player${T.players === 1 ? '' : 's'}</span>
    </div>
    <div class="panel ltile">
      <span class="label">${view.ended ? 'Cashed out' : mobile ? 'On table' : 'Chips on table'}</span>
      <span class="ltile-v mono">${fmt(view.ended ? T.cashedOut + T.chipsOnTable : T.chipsOnTable)}</span>
      ${balance}
    </div>
    <div class="panel ltile">
      <span class="label">Biggest winner</span>
      <span class=${cx('ltile-v', 'mono', top && 'pos')}>${top ? fmtSigned(top.net) : '—'}</span>
      <span class="tile-sub muted">${top ? (view.me && top.pid === view.me.id ? 'You' : top.name) : 'Nobody’s up yet'}</span>
    </div>
    <div class="panel ltile">
      <span class="label">${view.ended ? 'Session' : 'Session'}</span>
      <span class="ltile-v mono">${span ? duration(span.ms) : '—'}</span>
      <span class="tile-sub muted"><span class="mono">${fmt(T.hands)}</span> hand${T.hands === 1 ? '' : 's'}${view.ended ? ' · final' : ''}</span>
    </div>
  </div>`;
}

function PlayersTable({ view }) {
  const rows = view.ledger.players;
  const meId = view.me ? view.me.id : null;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  return html`<section class="panel lplayers" aria-label="Players">
    <div class="lcard-head lpad"><h3>Players</h3></div>
    ${rows.length === 0
      ? html`<p class="muted lempty lpad">Nobody has bought in yet.</p>`
      : html`<div class="host-scroll">
          <table class="tbl ltbl">
            <thead>
              <tr>
                <th>Player</th>
                <th class="num">Buy-ins</th>
                <th class="num">${view.ended ? 'Cashed out' : 'Stack'}</th>
                <th class="num">Net</th>
                <th class="ltbl-bar"><span class="sr-only">Net bar</span></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                (r) => html`<tr key=${r.pid}>
                  <td>
                    <div class="tbl-who">
                      <${Avatar} name=${r.name} seed=${seedOf(view, r.pid, r.name)} size=${32} />
                      <span class="tbl-name">${r.name}</span>
                      ${r.pid === meId && html`<span class="muted tbl-you">you</span>`}
                    </div>
                  </td>
                  <td class="num"><span class="mono">${fmt(r.buyIns)}</span> <span class="muted ltbl-count">× ${r.buyInCount}</span></td>
                  <td class="num mono">
                    ${view.ended ? fmt(r.cashOuts) : r.seated ? fmt(r.stack) : html`<span class="muted ltbl-out" title="Cashed out">out</span> ${fmt(r.cashOuts)}`}
                  </td>
                  <td class=${cx('num', 'mono', 'ltbl-net', r.net > 0 && 'pos', r.net < 0 && 'neg')}>${fmtSigned(r.net)}</td>
                  <td class="ltbl-bar"><${NetBar} net=${r.net} max=${max} /></td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>`}
  </section>`;
}

function PlayersListM({ view }) {
  const rows = view.ledger.players;
  const meId = view.me ? view.me.id : null;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.net)));
  return html`<section class="panel lplist-m" aria-label="Players">
    ${rows.length === 0 && html`<p class="muted lempty">Nobody has bought in yet.</p>`}
    ${rows.map(
      (r) => html`<div class="lprow" key=${r.pid}>
        <${Avatar} name=${r.name} seed=${seedOf(view, r.pid, r.name)} size=${32} />
        <div class="lprow-who">
          <div class="lprow-name">${r.name}${r.pid === meId && html` <span class="muted tbl-you">you</span>`}</div>
          <div class="muted mono lprow-sub">in ${fmt(r.buyIns)} · ${r.seated && !view.ended ? 'stack ' + fmt(r.stack) : 'out ' + fmt(r.cashOuts)}</div>
        </div>
        <${NetBar} net=${r.net} max=${max} small=${true} />
        <span class=${cx('mono', 'lprow-net', r.net > 0 && 'pos', r.net < 0 && 'neg')}>${fmtSigned(r.net)}</span>
      </div>`,
    )}
  </section>`;
}

function Settle({ view, mobile }) {
  const { act } = useRoom();
  const L = view.ledger;
  const list = L.settlement;
  const host = view.isHost;
  const paid = list.filter((s) => s.paid).length;
  const [busy, setBusy] = useState('');
  const toggle = async (s, on) => {
    if (!host || busy) return;
    setBusy(s.key);
    await act('markPaid', { key: s.key, paid: on });
    setBusy('');
  };
  const meId = view.me ? view.me.id : null;
  const nm = (pid, name) => (pid === meId ? 'You' : name);
  return html`<section class="panel lcard lsettle" aria-label="Settle up">
    <div class="lcard-head">
      <h3>Settle up</h3>
      ${list.length > 0 &&
      (mobile ? html`<span class="muted lcard-meta">${paid} of ${list.length} paid</span>` : html`<${Pill}>${list.length} payment${list.length === 1 ? '' : 's'}<//>`)}
    </div>
    <p class="muted lcard-sub">
      ${list.length === 0
        ? 'Everyone is even — nothing to settle.'
        : (view.ended ? 'Fewest payments to square everyone' : 'If everyone cashed out now — fewest payments to square up') +
          (host ? '. Tick each one when it’s paid.' : '.')}
    </p>
    ${list.map(
      (s) => html`<label key=${s.key} class=${cx('pay', s.paid && 'is-paid', !host && 'is-ro')} title=${host ? '' : 'Only the host can tick payments'}>
        <input type="checkbox" checked=${s.paid} disabled=${!host || busy === s.key} onChange=${(e) => toggle(s, e.target.checked)} />
        <span class="pay-who"><b>${nm(s.from, s.fromName)}</b> <span class="muted">${mobile ? '→' : s.from === meId ? 'pay' : 'pays'}</span> <b>${nm(s.to, s.toName)}</b></span>
        <span class="mono pay-amt">${fmt(s.amount)}</span>
      </label>`,
    )}
    ${!L.totals.balanced &&
    html`<div class="note note-danger lnote"><${Icon} name="alert" /><span>The books are off by <span class="mono">${fmtSigned(L.totals.diff)}</span> chips, so these payments can’t square everyone exactly.</span></div>`}
  </section>`;
}

function Activity({ view, mobile }) {
  const [all, setAll] = useState(false);
  const es = view.ledger.entries;
  const shown = all ? es : es.slice(0, mobile ? 4 : FEED_PREVIEW);
  return html`<section class="panel lcard lfeed" aria-label="Activity">
    <div class="lcard-head"><h3>Activity</h3>${es.length > 0 && html`<span class="muted lcard-meta">${es.length} entr${es.length === 1 ? 'y' : 'ies'}</span>`}</div>
    ${es.length === 0 && html`<p class="muted lcard-sub">Buy-ins, cash-outs and chip adjustments show up here.</p>`}
    ${shown.map((e) => {
      const d = describeEntry(e, view);
      return html`<div class="ev" key=${e.id}>
        <span class="mono muted ev-t">${clockTime(e.t)}</span>
        <span class="ev-text">${d.text}${d.extra && html`<span class="muted"> · ${d.extra}</span>`}</span>
      </div>`;
    })}
    ${es.length > shown.length || all
      ? html`<button type="button" class="linkbtn lfeed-more" onClick=${() => setAll(!all)}>${all ? 'Show less' : 'Full history (' + es.length + ')'}</button>`
      : null}
  </section>`;
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

export function Ledger() {
  const { view } = useRoom();
  const mobile = useIsMobile();
  if (!view || !view.ledger) return null;
  const T = view.ledger.totals;
  const span = sessionSpan(view);

  const tools = html`<div class=${cx('ltools', mobile && 'ltools-m')}>
    <span class="muted ltools-info">
      ${view.ended ? 'Final ledger' : 'Live'} · <span class="mono">${fmt(T.hands)}</span> hand${T.hands === 1 ? '' : 's'}${span ? html` · started <span class="mono">${clockTime(span.start)}</span>` : ''}
    </span>
    <div class="ltools-btns">
      <${Button} size=${mobile ? 'sm' : 'md'} onClick=${() => downloadCsv(view)}><${Icon} name="download" size=${16} />Export CSV<//>
      <${Button} size=${mobile ? 'sm' : 'md'} onClick=${() => copySummary(view)}><${Icon} name="copy" size=${16} />Copy summary<//>
    </div>
  </div>`;

  if (mobile) {
    return html`<div class="ledger ledger-m">
      <${Tiles} view=${view} mobile=${true} />
      <${PlayersListM} view=${view} />
      <${Settle} view=${view} mobile=${true} />
      <${Activity} view=${view} mobile=${true} />
      ${tools}
    </div>`;
  }

  return html`<div class="ledger">
    ${tools}
    <${Tiles} view=${view} />
    <div class="lcols">
      <div class="lmain"><${PlayersTable} view=${view} /></div>
      <div class="lside">
        <${Settle} view=${view} />
        <${Activity} view=${view} />
      </div>
    </div>
  </div>`;
}
