// lib/view.js — the per-viewer, redacted view of a room (SPEC §10).
//
// PURE module (SPEC §0). viewFor(state, pid | null, version, now) → View
//
// Every object in the view is built field by field from an explicit whitelist — nothing from
// `state` is passed through wholesale — so the deck, token hashes, other players' pending requests
// (unless the viewer is the host) and any hole card this viewer may not see can never leak.
// A hole card is visible to a viewer iff it is their own card or it has been shown (`shown[i]`).

import { canRevealRunout, canShow, displayBoard, legalActions, potTotal, seatReservedBy } from './engine.js';
import { evaluateFor } from './evaluator.js';
import { summarize } from './ledger.js';

const hasOwn = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);

/** Best-hand name, or null when the board is too short / anything is off. */
function handNameFor(variant, hole, board) {
  if (!Array.isArray(board) || board.length < 3 || !Array.isArray(hole) || hole.some((c) => !c)) return null;
  try {
    return evaluateFor(variant, hole, board).name;
  } catch {
    return null;
  }
}

function logEntry(e, nameOf) {
  const out = { street: e.street, pid: e.pid ?? null, name: nameOf(e.pid), text: e.text, amount: e.amount ?? null };
  if (Array.isArray(e.cards)) out.cards = e.cards.slice(); // only ever public cards (board / shown / runout)
  if (e.run != null) out.run = e.run;
  if (e.handName != null) out.handName = e.handName;
  return out;
}

function resultsView(r) {
  if (!r) return null;
  return {
    endedBy: r.endedBy,
    awards: { ...(r.awards || {}) },
    runs: (r.runs || []).map((x) => ({
      board: (x.board || []).slice(),
      winners: (x.winners || []).slice(),
      handName: x.handName ?? null,
      amount: x.amount ?? null,
      awards: { ...(x.awards || {}) },
    })),
    pots: (r.pots || []).map((p) => ({
      amount: p.amount,
      eligible: (p.eligible || []).slice(),
      winnersByRun: (p.winnersByRun || []).map((w) => w.slice()),
      returned: !!p.returned,
    })),
    winners: (r.winners || []).slice(),
  };
}

export function viewFor(state, pid, version, now) {
  const players = state.players || {};
  const viewer = pid != null && hasOwn(players, pid) && !players[pid].kicked ? players[pid] : null;
  const me = viewer ? viewer.id : null;
  const isHost = !!me && me === state.hostId;
  const hand = state.hand || null;
  const settings = { ...state.settings };
  const nameOf = (id) => (id != null && hasOwn(players, id) ? players[id].name : null);

  const dealtIn = (id) => !!(hand && hasOwn(hand.ps, id));
  const contesting = (id) => dealtIn(id) && !hand.ps[id].folded && hand.phase !== 'complete';
  const isBusted = (p) => p.seat != null && p.stack === 0 && !p.pendingChips && !contesting(p.id);

  const requestView = (r) => ({
    id: r.id,
    pid: r.pid,
    name: nameOf(r.pid),
    kind: r.kind,
    amount: r.amount,
    seat: r.seat ?? null,
    createdAt: r.createdAt,
  });

  // ── me ──
  let meView = null;
  if (viewer) {
    const hole = dealtIn(me) ? hand.ps[me].hole.slice() : null;
    const myReq = (state.requests || []).find((r) => r.pid === me);
    meView = {
      id: viewer.id,
      name: viewer.name,
      seat: viewer.seat,
      stack: viewer.stack,
      pendingChips: viewer.pendingChips || 0,
      away: !!viewer.away,
      awayBy: viewer.awayBy || null,
      waitForBB: !!viewer.waitForBB,
      awayAfterHand: !!viewer.awayAfterHand,
      leaveAfterHand: !!viewer.leaveAfterHand,
      removedByHost: !!(viewer.leaveAfterHand && viewer.leaveBy && viewer.leaveBy !== viewer.id),
      timeouts: viewer.timeouts || 0,
      status: viewer.seat != null ? 'seated' : 'spectator',
      inHand: dealtIn(me),
      busted: isBusted(viewer),
      hole,
      handName: hole ? handNameFor(hand.variant, hole, displayBoard(hand)) : null,
      request: myReq ? requestView(myReq) : null,
    };
  }

  // ── everyone ──
  const playerList = Object.values(players)
    .filter((p) => !p.kicked)
    .sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99) || a.joinedAt - b.joinedAt)
    .map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      pendingChips: p.pendingChips || 0,
      status: p.seat != null ? 'seated' : 'spectator',
      away: !!p.away,
      awayBy: p.awayBy || null,
      isHost: p.id === state.hostId,
      inHand: dealtIn(p.id),
      busted: isBusted(p),
      leaveAfterHand: !!p.leaveAfterHand,
    }));

  const seats = [];
  for (let i = 0; i < settings.seats; i++) {
    const occupant = Object.values(players).find((p) => p.seat === i);
    seats.push({ seat: i, pid: occupant ? occupant.id : null, reservedBy: seatReservedBy(state, i) });
  }

  // ── the hand ──
  let handView = null;
  if (hand) {
    const board = displayBoard(hand);
    const complete = hand.phase === 'complete';
    const equityPhase = hand.phase === 'ritVote' || hand.phase === 'runout';
    const winners = new Set(complete && hand.results ? hand.results.winners || [] : []);
    let bets = 0;
    for (const id of hand.order) bets += hand.ps[id].bet;
    const total = potTotal(hand);

    const handPlayers = hand.order
      .map((id) => hand.ps[id])
      .sort((a, b) => a.seat - b.seat)
      .map((h) => {
        const own = h.pid === me;
        const cards = h.hole.map((c, i) => (own || h.shown[i] ? c : null));
        const eq = equityPhase && !h.folded && hand.equity && hand.equity.by ? hand.equity.by[h.pid] : null;
        return {
          pid: h.pid,
          seat: h.seat,
          name: nameOf(h.pid),
          bet: h.bet,
          committed: h.committed,
          stack: hasOwn(players, h.pid) ? players[h.pid].stack : 0,
          folded: h.folded,
          allIn: h.allIn,
          lastAction: h.lastAction ? { type: h.lastAction.type, amount: h.lastAction.amount } : null,
          cards,
          shown: h.shown.slice(),
          equity: typeof eq === 'number' ? eq : null,
          won: complete ? h.won : 0,
          handName: cards.every((c) => c !== null) ? handNameFor(hand.variant, h.hole, board) : null,
          isWinner: winners.has(h.pid),
        };
      });

    handView = {
      no: hand.no,
      phase: hand.phase,
      street: hand.street,
      variant: hand.variant,
      sb: hand.sb,
      bb: hand.bb,
      button: hand.button,
      sbSeat: hand.sbSeat,
      bbSeat: hand.bbSeat,
      board: hand.board.slice(),
      runs: hand.runs,
      currentRun: hand.currentRun,
      runBoards: (hand.runBoards || []).map((b) => b.slice()),
      runResults: (hand.runResults || []).filter(Boolean).map((r) => ({ winners: r.winners.slice(), handName: r.handName })),
      potTotal: total,
      potCenter: total - bets,
      currentBet: hand.currentBet,
      minRaise: hand.minRaise,
      toAct: hand.toAct,
      players: handPlayers,
      legal: me ? legalActions(state, me) : null,
      ritVote:
        hand.phase === 'ritVote'
          ? {
              voters: hand.ritVoters.slice(),
              votes: Object.fromEntries(hand.ritVoters.map((v) => [v, hand.ritVotes[v] ?? null])),
              maxRuns: hand.ritMaxRuns || settings.maxRuns,
              deadline: state.deadlineKind === 'ritVote' ? state.deadline : null,
            }
          : null,
      results: resultsView(hand.results),
      runout: hand.runout ? { cards: hand.runout.cards.slice(), by: hand.runout.by, name: nameOf(hand.runout.by) } : null,
      canShow: canShow(state, me),
      canRevealRunout: me ? canRevealRunout(state, me) : false,
      log: hand.log.map((e) => logEntry(e, nameOf)),
    };
  }

  const lh = state.lastHand;
  const lastHand = lh
    ? {
        no: lh.no,
        log: (lh.log || []).map((e) => logEntry(e, nameOf)),
        results: resultsView(lh.results),
        boards: (lh.boards || []).map((b) => b.slice()),
        runout: lh.runout ? { cards: lh.runout.cards.slice(), by: lh.runout.by, name: nameOf(lh.runout.by) } : null,
        players: (lh.players || []).map((p) => ({
          pid: p.pid,
          name: nameOf(p.pid),
          seat: p.seat,
          cards: (p.cards || []).map((c) => c ?? null), // archived with only the shown cards
          folded: !!p.folded,
          won: p.won || 0,
          handName: p.handName ?? null,
        })),
      }
    : null;

  return {
    code: state.code,
    name: state.name,
    version,
    serverNow: now,
    hostId: state.hostId,
    isHost,
    settings,
    paused: !!state.paused,
    pauseAfterHand: !!state.pauseAfterHand,
    ended: !!state.ended,
    endAfterHand: !!state.endAfterHand,
    handNo: state.handNo || 0,
    button: state.button ?? null,
    deadline: state.deadline ?? null,
    deadlineKind: state.deadlineKind ?? null,
    me: meView,
    players: playerList,
    seats,
    hand: handView,
    lastHand,
    requests: (state.requests || []).filter((r) => isHost || r.pid === me).map(requestView),
    ledger: summarize(state),
    chat: (state.chat || []).map((c) => ({ id: c.id, t: c.t, pid: c.pid, name: c.name, text: c.text })),
  };
}
