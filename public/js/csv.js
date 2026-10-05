// public/js/csv.js — the ledger CSV export (SPEC §11). No React, so node tests import it directly.
//
// Every text cell comes from players (names, the game name, adjust reasons). A spreadsheet treats a
// cell starting with = + - @ (or a tab / CR) as a formula even inside quotes, so such text cells
// get a leading apostrophe and open as plain text. Numbers are written as they are.

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (typeof v === 'string' && FORMULA_START.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function isoLocal(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function ledgerCsv(view, now = Date.now()) {
  const L = view.ledger;
  const T = L.totals;
  const rows = [];
  rows.push(['Game', view.name], ['Room', view.code], ['Hands played', T.hands], ['Exported', isoLocal(now)], []);
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
