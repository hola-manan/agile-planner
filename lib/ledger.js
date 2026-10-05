// lib/ledger.js — ledger summary + settle-up (SPEC §7).
//
// PURE module (SPEC §0). summarize(state) → { entries, players, totals, settlement }
//
//   players   one row per player who ever appears in the ledger or is seated:
//             buyIns     Σ buy-ins + Σ adjustments counted as buy-ins (signed)
//             buyInCount number of buy-ins (+ counted positive adjustments)
//             cashOuts   Σ cash-outs
//             stack      chips behind + chips in the running hand's pot + pending chips (0 if unseated)
//             net        cashOuts + stack − buyIns
//             (sorted biggest winner first)
//   totals    { buyIns, chipsOnTable, cashedOut, uncountedAdjust, diff, balanced, buyInCount, players,
//               hands, biggestWinner }  with diff = chipsOnTable + cashedOut − buyIns, balanced = diff === 0
//   settlement  payments already made (ticked by the host, `paid: true`, key from>to:amount#id),
//             then what is still owed after them — fewest-ish payments: repeatedly the largest
//             debtor pays the largest creditor ([{ key: from+'>'+to+':'+amount, …, paid: false }]).
//             If the books don't balance, whatever can be settled is settled and the rest is left.
//   entries   ledger entries newest first (last 200), each with `byName` added.

const MAX_ENTRIES = 200;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function summarize(state) {
  const players = (state && state.players) || {};
  const ledger = (state && state.ledger) || [];
  const hand = state && state.hand;
  const handLive = !!hand && hand.phase !== 'complete'; // once settled, the pot is already in stacks
  const nameOf = (pid) => (pid != null && players[pid] ? players[pid].name : null);

  const rows = new Map();
  const rowFor = (pid, fallbackName) => {
    let r = rows.get(pid);
    if (!r) {
      const p = players[pid];
      r = {
        pid,
        name: p ? p.name : fallbackName || 'Player',
        seat: p && p.seat != null ? p.seat : null,
        seated: !!(p && p.seat != null),
        buyIns: 0,
        buyInCount: 0,
        cashOuts: 0,
        adjustments: 0,
        stack: 0,
        net: 0,
      };
      rows.set(pid, r);
    }
    return r;
  };

  let buyIns = 0;
  let buyInCount = 0;
  let cashedOut = 0;
  let uncountedAdjust = 0;
  for (const e of ledger) {
    const r = rowFor(e.pid, e.name);
    const amount = Number(e.amount) || 0;
    if (e.type === 'buyin') {
      r.buyIns += amount;
      r.buyInCount += 1;
      buyIns += amount;
      buyInCount += 1;
    } else if (e.type === 'cashout') {
      r.cashOuts += amount;
      cashedOut += amount;
    } else if (e.type === 'adjust') {
      r.adjustments += amount;
      if (e.countAsBuyIn) {
        r.buyIns += amount;
        buyIns += amount;
        if (amount > 0) {
          r.buyInCount += 1;
          buyInCount += 1;
        }
      } else {
        uncountedAdjust += amount;
      }
    }
  }
  for (const p of Object.values(players)) if (p.seat != null) rowFor(p.id, p.name);

  let chipsOnTable = 0;
  for (const r of rows.values()) {
    const p = players[r.pid];
    if (p && p.seat != null) {
      const h = handLive ? hand.ps[r.pid] : null;
      const inPot = h && h.seat === p.seat ? h.committed : 0;
      r.stack = p.stack + (p.pendingChips || 0) + inPot;
    }
    r.net = r.cashOuts + r.stack - r.buyIns;
    chipsOnTable += r.stack;
  }
  // Chips already in the pot from players who have since left the table are still on the table.
  if (handLive) {
    for (const pid of hand.order) {
      const p = players[pid];
      const h = hand.ps[pid];
      if (!p || p.seat == null || h.seat !== p.seat) chipsOnTable += h.committed;
    }
  }

  const list = [...rows.values()].sort((a, b) => b.net - a.net || cmp(a.name, b.name) || cmp(a.pid, b.pid));
  const diff = chipsOnTable + cashedOut - buyIns;
  const top = list.length && list[0].net > 0 ? list[0] : null;

  return {
    entries: ledger
      .slice(-MAX_ENTRIES)
      .reverse()
      .map((e) => ({ ...e, byName: nameOf(e.by) })),
    players: list,
    totals: {
      buyIns,
      chipsOnTable,
      cashedOut,
      uncountedAdjust,
      diff,
      balanced: diff === 0,
      buyInCount,
      players: list.length,
      hands: (state && state.handNo) || 0,
      biggestWinner: top ? { pid: top.pid, name: top.name, net: top.net } : null,
    },
    settlement: settle(list, (state && state.paid) || {}, (state && state.payments) || []),
  };
}

/**
 * Settle-up. Recorded payments come first (paid); the rest is a greedy match on what each player
 * still owes / is owed after those payments: the largest debtor pays the largest creditor until
 * one side runs out. `paid` is the legacy tick map (by key) of rooms created before `payments`.
 */
export function settle(rows, paid = {}, payments = []) {
  const owed = new Map(rows.map((r) => [r.pid, { pid: r.pid, name: r.name, amt: r.net }]));
  const out = [];
  for (const x of payments) {
    const f = owed.get(x.from);
    const t = owed.get(x.to);
    if (f) f.amt += x.amount; // paying settles part of a debt
    if (t) t.amt -= x.amount; // being paid settles part of a credit
    out.push({
      key: x.key,
      from: x.from,
      fromName: f ? f.name : x.fromName,
      to: x.to,
      toName: t ? t.name : x.toName,
      amount: x.amount,
      paid: true,
    });
  }
  const debtors = [];
  const creditors = [];
  for (const r of owed.values()) {
    if (r.amt < 0) debtors.push({ pid: r.pid, name: r.name, amt: -r.amt });
    else if (r.amt > 0) creditors.push({ pid: r.pid, name: r.name, amt: r.amt });
  }
  const byAmount = (a, b) => b.amt - a.amt || cmp(a.name, b.name) || cmp(a.pid, b.pid);
  while (debtors.length && creditors.length) {
    debtors.sort(byAmount);
    creditors.sort(byAmount);
    const d = debtors[0];
    const c = creditors[0];
    const amount = Math.min(d.amt, c.amt);
    const key = d.pid + '>' + c.pid + ':' + amount;
    out.push({ key, from: d.pid, fromName: d.name, to: c.pid, toName: c.name, amount, paid: !!paid[key] });
    d.amt -= amount;
    c.amt -= amount;
    if (d.amt === 0) debtors.shift();
    if (c.amt === 0) creditors.shift();
  }
  return out;
}
