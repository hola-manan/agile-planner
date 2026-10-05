// Keyboard shortcuts and pre-actions (public/js/hotkeys.js, SPEC §11): the pure decisions, fed
// with REAL views — games scripted with lib/engine.js and rendered by lib/view.js — and every
// move a decision produces is checked against the engine (it must be legal when it is sent).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../lib/engine.js';
import { viewFor } from '../lib/view.js';
import {
  HOTKEYS,
  PRE_KEYS,
  canPreAct,
  decidePreAction,
  decideTurnKey,
  ignoreKeyEvent,
  isMyTurn,
  normKey,
  preLabel,
  showKey,
  toCallOf,
  togglePreAction,
} from '../public/js/hotkeys.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const T0 = 1_700_000_000_000;

/** n seated players p0..p(n-1) at seats 0.. (+ one spectator), first hand dealt. */
function game({ n = 3, stacks = null, settings = {}, seed = 5 } = {}) {
  const ctx = { now: T0, rng: mulberry32(seed) };
  const state = E.createRoom(
    {
      code: 'KEY-0001',
      name: 'Keys',
      hostName: 'Host',
      hostId: 'p0',
      hostTokenHash: 'h0',
      settings: { approveBuyIns: false, minBuyIn: 1, maxBuyIn: 10000, maxRuns: 1, ...settings },
    },
    ctx,
  );
  for (let i = 1; i <= n; i++) E.addPlayer(state, { id: `p${i}`, name: `Player ${i}`, tokenHash: `h${i}` }, ctx);
  const g = { state, ctx };
  for (let i = 0; i < n; i++) apply(g, `p${i}`, { type: 'sit', seat: i, amount: stacks ? stacks[i] : 200 });
  g.ctx.now = Math.max(g.ctx.now, g.state.deadline);
  E.tick(g.state, g.ctx);
  assert.ok(g.state.hand && g.state.hand.phase === 'betting', 'a hand is dealt');
  return g;
}

const apply = (g, pid, a) => E.apply(g.state, pid, a, g.ctx);
const view = (g, pid) => viewFor(g.state, pid, 1, g.ctx.now);
const toAct = (g) => g.state.hand.toAct;
/** Seated pids in the order they act after `pid`. */
const after = (g, pid, k = 1) => {
  const order = g.state.hand.order;
  return order[(order.indexOf(pid) + k) % order.length];
};

/** Sends `move` for whoever is to act; asserts the engine accepts it. */
function send(g, move) {
  const pid = toAct(g);
  assert.doesNotThrow(() => apply(g, pid, { type: 'act', ...move }), `${pid}: ${JSON.stringify(move)} must be legal`);
  return pid;
}

/** The engine accepts this move from the viewer on a copy of the game (the original is untouched). */
function legalOnCopy(g, pid, move) {
  const copy = { state: structuredClone(g.state), ctx: { ...g.ctx } };
  assert.doesNotThrow(() => E.apply(copy.state, pid, { type: 'act', ...move }, copy.ctx), `${pid}: ${JSON.stringify(move)}`);
}

describe('decideTurnKey — my turn', () => {
  test('facing a bet: f folds, c / a / g call, i folds, k explains, r focuses the raise', () => {
    const g = game();
    const me = toAct(g); // first to act preflop faces the big blind
    const v = view(g, me);
    assert.ok(isMyTurn(v));
    assert.equal(v.hand.legal.check, false);
    assert.deepEqual(decideTurnKey('f', v), { move: 'fold' });
    for (const k of ['c', 'a', 'g']) assert.deepEqual(decideTurnKey(k, v), { move: 'call' }, k);
    assert.deepEqual(decideTurnKey('i', v), { move: 'fold' });
    assert.deepEqual(decideTurnKey('k', v), { toast: 'Can’t check — 2 to call' });
    assert.deepEqual(decideTurnKey('r', v), { focus: 'raise' });
    for (const k of ['x', 's', '1', '?', '']) assert.equal(decideTurnKey(k, v), null, k);
    for (const k of ['f', 'c', 'i']) legalOnCopy(g, me, decideTurnKey(k, v));
  });

  test('nothing to call: c, k, a, g and i all check', () => {
    const g = game();
    send(g, { move: 'call' }); // button calls
    send(g, { move: 'call' }); // small blind completes
    const bb = toAct(g);
    const v = view(g, bb);
    assert.equal(v.hand.legal.check, true, 'big blind has the option');
    for (const k of ['c', 'k', 'a', 'g', 'i']) {
      assert.deepEqual(decideTurnKey(k, v), { move: 'check' }, k);
    }
    assert.deepEqual(decideTurnKey('f', v), { move: 'fold' }, 'folding is still allowed');
    legalOnCopy(g, bb, { move: 'check' });
  });

  test('the toast names the amount with thousands separators', () => {
    const g = game({ n: 2, stacks: [5000, 5000] });
    const first = toAct(g);
    send(g, { move: 'raise', to: 1500 });
    const v = view(g, after(g, first));
    assert.deepEqual(decideTurnKey('k', v), { toast: 'Can’t check — 1,498 to call' });
  });

  test('r explains when no raise is possible (the only other player is all-in)', () => {
    const g = game({ n: 2, stacks: [100, 300] });
    const first = toAct(g);
    send(g, { move: 'raise', to: g.state.hand.ps[first].bet + g.state.players[first].stack }); // shove
    const other = toAct(g);
    const v = view(g, other);
    assert.equal(v.hand.legal.raise, false);
    assert.deepEqual(decideTurnKey('r', v), { toast: 'You can’t raise here — call or fold' });
    assert.deepEqual(decideTurnKey('c', v), { move: 'call' });
    legalOnCopy(g, other, { move: 'call' });
  });

  test('not my turn (or no seat): f, c, k, r, a, g, i do nothing', () => {
    const g = game();
    const waiting = after(g, toAct(g));
    for (const pid of [waiting, 'p3', null]) {
      const v = view(g, pid);
      assert.equal(isMyTurn(v), false);
      for (const k of ['f', 'c', 'k', 'r', 'a', 'g', 'i']) assert.equal(decideTurnKey(k, v), null, `${pid} ${k}`);
    }
  });
});

describe('pre-actions — who may pick one', () => {
  test('a player waiting in the betting round may; the actor, a folder, a spectator and a visitor may not', () => {
    const g = game();
    const actor = toAct(g);
    const waiting = after(g, actor);
    assert.equal(canPreAct(view(g, waiting)), true);
    assert.equal(canPreAct(view(g, actor)), false);
    assert.equal(canPreAct(view(g, 'p3')), false, 'spectator');
    assert.equal(canPreAct(view(g, null)), false, 'visitor');
    send(g, { move: 'fold' });
    assert.equal(canPreAct(view(g, actor)), false, 'folded');
  });

  test('an all-in player and an away player may not', () => {
    const g = game({ n: 3, stacks: [200, 200, 200] });
    const first = toAct(g);
    send(g, { move: 'raise', to: 200 }); // all-in
    assert.equal(canPreAct(view(g, first)), false, 'all-in');
    const third = after(g, first, 2);
    assert.equal(canPreAct(view(g, third)), true);
    apply(g, third, { type: 'away', on: true });
    assert.equal(canPreAct(view(g, third)), false, 'away');
  });

  test('toggle: pick, the same key again turns it off, another key switches', () => {
    const g = game();
    const waiting = after(g, toAct(g));
    const v = view(g, waiting);
    const a = togglePreAction(null, 'checkFold', v);
    assert.deepEqual(a, { kind: 'checkFold', bet: 2, at: v.hand.no + ':preflop' });
    assert.equal(togglePreAction(a, 'checkFold', v), null);
    const b = togglePreAction(a, 'callCurrent', v);
    assert.equal(b.kind, 'callCurrent');
    assert.equal(b.bet, v.hand.currentBet);
    assert.equal(togglePreAction(b, 'nonsense', v), b, 'unknown kinds change nothing');
    // the actor (or anyone who can't pre-act) leaves the current pick alone
    assert.equal(togglePreAction(null, 'callAny', view(g, toAct(g))), null);
    assert.equal(togglePreAction(a, 'callAny', view(g, 'p3')), a);
    assert.deepEqual(PRE_KEYS, { i: 'checkFold', a: 'callAny', g: 'callCurrent' });
  });

  test('labels: Call current follows the amount to call (capped by my stack), or reads Check', () => {
    const g = game({ n: 3, stacks: [200, 200, 30] });
    const first = toAct(g);
    const v0 = view(g, after(g, first));
    assert.equal(preLabel('checkFold', v0), 'Check/Fold');
    assert.equal(preLabel('callAny', v0), 'Call any');
    assert.equal(preLabel('callCurrent', v0), 'Call ' + toCallOf(v0));
    send(g, { move: 'raise', to: 60 });
    const short = 'p2'; // seat 2, 30 chips, the big blind (first to act is the button, p0)
    assert.equal(first, 'p0');
    assert.notEqual(toAct(g), short);
    const vs = view(g, short);
    assert.equal(toCallOf(vs), vs.me.stack, 'capped by the stack');
    assert.equal(preLabel('callCurrent', vs), 'Call ' + vs.me.stack);
    // on the flop, with no bet yet, it is a check
    const g2 = game();
    send(g2, { move: 'call' });
    send(g2, { move: 'call' });
    send(g2, { move: 'check' });
    assert.equal(g2.state.hand.street, 'flop');
    const w = after(g2, toAct(g2));
    assert.equal(preLabel('callCurrent', view(g2, w)), 'Check');
  });
});

describe('decidePreAction', () => {
  test('nothing picked → nothing; still waiting → keep waiting', () => {
    const g = game();
    const waiting = after(g, toAct(g), 2);
    const v = view(g, waiting);
    assert.equal(decidePreAction(null, v), null);
    for (const k of ['checkFold', 'callAny', 'callCurrent']) assert.equal(decidePreAction(togglePreAction(null, k, v), v), null, k);
  });

  test('Check/Fold folds to a bet and checks when free', () => {
    const g = game();
    const first = toAct(g);
    const second = after(g, first);
    const pre = togglePreAction(null, 'checkFold', view(g, second));
    send(g, { move: 'call' });
    assert.equal(toAct(g), second);
    const d = decidePreAction(pre, view(g, second));
    assert.deepEqual(d, { fire: { move: 'fold' } });
    legalOnCopy(g, second, d.fire);

    // free: the big blind's option
    const g2 = game();
    const bb = after(g2, toAct(g2), 2);
    const pre2 = togglePreAction(null, 'checkFold', view(g2, bb));
    send(g2, { move: 'call' });
    send(g2, { move: 'call' });
    assert.equal(toAct(g2), bb);
    assert.deepEqual(decidePreAction(pre2, view(g2, bb)), { fire: { move: 'check' } });
  });

  test('Call any survives a raise and calls it — all-in included', () => {
    const g = game({ n: 3, stacks: [500, 500, 80] });
    const first = toAct(g);
    const third = after(g, first, 2);
    const pre = togglePreAction(null, 'callAny', view(g, third));
    send(g, { move: 'raise', to: 300 });
    assert.equal(decidePreAction(pre, view(g, after(g, first, 2))), null, 'still waiting: the pick stays');
    send(g, { move: 'fold' });
    assert.equal(toAct(g), third);
    const v = view(g, third);
    const d = decidePreAction(pre, v);
    assert.deepEqual(d, { fire: { move: 'call' } });
    assert.ok(g.state.players[third].stack + g.state.hand.ps[third].bet < 300, 'the 80-chip stack faces more than it has');
    apply(g, third, { type: 'act', ...d.fire });
    assert.equal(g.state.hand.ps[third].allIn, true, 'a short stack calls all-in');
  });

  test('Call any checks when nothing is bet', () => {
    const g = game();
    const bb = after(g, toAct(g), 2);
    const pre = togglePreAction(null, 'callAny', view(g, bb));
    send(g, { move: 'call' });
    send(g, { move: 'call' });
    assert.deepEqual(decidePreAction(pre, view(g, bb)), { fire: { move: 'check' } });
  });

  test('Call current: calls when the bet is unchanged, is cancelled the moment it changes', () => {
    const g = game();
    const first = toAct(g);
    const second = after(g, first);
    const third = after(g, first, 2);
    const preCall = togglePreAction(null, 'callCurrent', view(g, second));
    const preChanged = togglePreAction(null, 'callCurrent', view(g, third));
    send(g, { move: 'call' }); // the bet stays at the big blind
    const d = decidePreAction(preCall, view(g, second));
    assert.deepEqual(d, { fire: { move: 'call' } });
    legalOnCopy(g, second, d.fire);
    apply(g, second, { type: 'act', move: 'raise', to: 8 }); // …but raises instead: the big blind's pick is stale
    assert.deepEqual(decidePreAction(preChanged, view(g, third)), { cancel: 'changed' });

    // cancelled even before my turn
    const g2 = game({ n: 4 });
    const a = toAct(g2);
    const last = after(g2, a, 3);
    const pre = togglePreAction(null, 'callCurrent', view(g2, last));
    send(g2, { move: 'raise', to: 6 });
    assert.notEqual(toAct(g2), last);
    assert.deepEqual(decidePreAction(pre, view(g2, last)), { cancel: 'changed' });
  });

  test('Call current checks when free and nothing changed', () => {
    const g = game();
    send(g, { move: 'call' });
    send(g, { move: 'call' });
    send(g, { move: 'check' }); // to the flop
    const firstPost = toAct(g);
    const w = after(g, firstPost);
    const pre = togglePreAction(null, 'callCurrent', view(g, w));
    assert.equal(pre.bet, 0);
    send(g, { move: 'check' });
    assert.equal(toAct(g), w);
    assert.deepEqual(decidePreAction(pre, view(g, w)), { fire: { move: 'check' } });
  });

  test('dropped when the street changes, the hand changes, I go away, or the hand completes', () => {
    const g = game();
    const first = toAct(g);
    const third = after(g, first, 2);
    const pre = togglePreAction(null, 'callAny', view(g, third));
    send(g, { move: 'call' });
    send(g, { move: 'call' });
    send(g, { move: 'check' });
    assert.equal(g.state.hand.street, 'flop');
    assert.deepEqual(decidePreAction(pre, view(g, third)), { cancel: 'street' });

    const g2 = game();
    const w2 = after(g2, toAct(g2), 2);
    const pre2 = togglePreAction(null, 'checkFold', view(g2, w2));
    apply(g2, w2, { type: 'away', on: true });
    assert.deepEqual(decidePreAction(pre2, view(g2, w2)), { cancel: 'gone' });

    const g3 = game();
    const first3 = toAct(g3);
    const w3 = after(g3, first3, 2);
    const pre3 = togglePreAction(null, 'callAny', view(g3, w3));
    // the two others fold → the big blind wins without acting; the hand is complete
    send(g3, { move: 'fold' });
    send(g3, { move: 'fold' });
    assert.equal(g3.state.hand.phase, 'complete');
    assert.ok(decidePreAction(pre3, view(g3, w3)).cancel, 'complete: dropped');
    // next hand: a pick from the old hand never fires
    g3.ctx.now = Math.max(g3.ctx.now, g3.state.deadline);
    E.tick(g3.state, g3.ctx);
    assert.equal(g3.state.hand.no, 2);
    const v = view(g3, w3);
    assert.deepEqual(decidePreAction(pre3, v), { cancel: 'street' });
  });

  test('a fired pick is always a move the engine accepts', () => {
    // random walks: every waiting player holds a random pick; whenever one fires, apply it
    let fired = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const rng = mulberry32(seed * 7919);
      const g = game({ n: 4, seed, stacks: [200, 120, 60, 300] });
      const picks = {};
      for (let steps = 0; steps < 60 && g.state.hand.phase === 'betting'; steps++) {
        for (const pid of g.state.hand.order) {
          const v = view(g, pid);
          if (canPreAct(v) && !picks[pid] && rng() < 0.5) picks[pid] = togglePreAction(null, ['checkFold', 'callAny', 'callCurrent'][Math.floor(rng() * 3)], v);
          const d = picks[pid] && decidePreAction(picks[pid], v);
          if (d && d.cancel) delete picks[pid];
        }
        const pid = toAct(g);
        const v = view(g, pid);
        const d = picks[pid] && decidePreAction(picks[pid], v);
        delete picks[pid];
        if (d && d.fire) {
          send(g, d.fire);
          fired++;
          continue;
        }
        const L = v.hand.legal;
        const r = rng();
        if (r < 0.25 && L.raise) send(g, { move: 'raise', to: L.minTo });
        else if (r < 0.35) send(g, { move: 'fold' });
        else send(g, { move: L.check ? 'check' : 'call' });
      }
    }
    assert.ok(fired > 20, 'picks fired: ' + fired);
  });
});

describe('showKey — after the hand', () => {
  function foldedHand({ variant = 'NLH' } = {}) {
    const g = game({ settings: { variant } });
    const first = toAct(g);
    const folder = first;
    send(g, { move: 'fold' });
    const second = toAct(g);
    send(g, { move: 'fold' });
    assert.equal(g.state.hand.phase, 'complete');
    const winner = after(g, second);
    return { g, folder, winner };
  }

  test('numpad navigation keys (NumLock off) never show a card; real numpad digits do', () => {
    const { g, winner } = foldedHand();
    const v = view(g, winner);
    assert.deepEqual(showKey(normKey({ key: '2', code: 'Numpad2' }), v), [1], 'a real digit still shows');
    assert.equal(showKey(normKey({ key: 'End', code: 'Numpad1' }), v), null);
    assert.equal(showKey(normKey({ key: 'ArrowDown', code: 'Numpad2' }), v), null);
  });

  test('s shows every unshown card, 1 / 2 one card; shown cards are skipped', () => {
    const { g, folder, winner } = foldedHand();
    for (const pid of [folder, winner]) {
      const v = view(g, pid);
      assert.equal(v.hand.canShow, true, pid);
      assert.deepEqual(showKey('s', v), [0, 1]);
      assert.deepEqual(showKey('1', v), [0]);
      assert.deepEqual(showKey('2', v), [1]);
      assert.equal(showKey('3', v), null, 'Hold’em has two cards');
      assert.equal(showKey('x', v), null);
    }
    apply(g, folder, { type: 'show', cards: showKey('1', view(g, folder)) });
    const v = view(g, folder);
    assert.equal(showKey('1', v), null, 'already shown');
    assert.deepEqual(showKey('s', v), [1]);
    apply(g, folder, { type: 'show', cards: showKey('s', v) });
    const done = view(g, folder);
    assert.equal(done.hand.canShow, false);
    assert.equal(showKey('s', done), null);
    assert.equal(showKey('2', done), null);
  });

  test('Omaha: 1–4', () => {
    const { g, winner } = foldedHand({ variant: 'PLO' });
    const v = view(g, winner);
    assert.equal(v.me.hole.length, 4);
    assert.deepEqual(showKey('s', v), [0, 1, 2, 3]);
    assert.deepEqual(showKey('4', v), [3]);
    assert.deepEqual(showKey('3', v), [2]);
  });

  test('nothing during the hand, for a spectator or a visitor', () => {
    const g = game();
    for (const pid of [toAct(g), after(g, toAct(g)), 'p3', null]) {
      for (const k of ['s', '1', '2']) assert.equal(showKey(k, view(g, pid)), null, `${pid} ${k}`);
    }
    const { g: g2 } = foldedHand();
    for (const pid of ['p3', null]) assert.equal(showKey('s', view(g2, pid)), null);
  });
});

describe('key events', () => {
  test('normKey: e.key lower-cased; digits from e.code on any layout / with Shift', () => {
    assert.equal(normKey({ key: 'F', code: 'KeyF' }), 'f');
    assert.equal(normKey({ key: 'f', code: 'KeyF' }), 'f');
    assert.equal(normKey({ key: '!', code: 'Digit1' }), '1');
    assert.equal(normKey({ key: '&', code: 'Digit1' }), '1'); // AZERTY
    assert.equal(normKey({ key: '2', code: 'Numpad2' }), '2');
    assert.equal(normKey({ key: '?', code: 'Slash' }), '?');
    assert.equal(normKey(null), '');
  });

  test('normKey: numpad navigation keys (NumLock off) are not digits, so they never show a card', () => {
    assert.equal(normKey({ key: '1', code: 'Numpad1' }), '1');
    assert.equal(normKey({ key: 'End', code: 'Numpad1' }), 'end');
    assert.equal(normKey({ key: 'ArrowDown', code: 'Numpad2' }), 'arrowdown');
    assert.equal(normKey({ key: 'PageDown', code: 'Numpad3' }), 'pagedown');
    assert.equal(normKey({ key: 'Unidentified', code: 'Digit1' }), 'unidentified');
  });

  test('ignored with modifiers, on repeat, while typing or with a dialog open', () => {
    const plain = { key: 'f', target: { tagName: 'BODY' } };
    assert.equal(ignoreKeyEvent(plain, false), false);
    assert.equal(ignoreKeyEvent({ ...plain, shiftKey: true }, false), false, 'Shift is fine');
    for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'defaultPrevented', 'isComposing']) {
      assert.equal(ignoreKeyEvent({ ...plain, [mod]: true }, false), true, mod);
    }
    assert.equal(ignoreKeyEvent(plain, true), true, 'modal open');
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(ignoreKeyEvent({ key: 'f', target: { tagName } }, false), true, tagName);
    for (const type of ['text', 'number', 'search', 'email', 'password', 'TEXT', undefined]) {
      assert.equal(ignoreKeyEvent({ key: 'f', target: { tagName: 'INPUT', type } }, false), true, 'input ' + type);
    }
    // A slider (the raise slider), checkbox, radio or button input takes no typing: keys still work.
    for (const type of ['range', 'checkbox', 'radio', 'button', 'submit']) {
      assert.equal(ignoreKeyEvent({ key: 'f', target: { tagName: 'INPUT', type } }, false), false, 'input ' + type);
    }
    assert.equal(ignoreKeyEvent({ key: 'f', target: { tagName: 'DIV', isContentEditable: true } }, false), true);
    assert.equal(ignoreKeyEvent({ key: 'f', target: { tagName: 'BUTTON' } }, false), false);
  });

  test('the cheat sheet lists every key', () => {
    const listed = new Set(HOTKEYS.flatMap((g) => g.keys.flatMap((k) => k.keys)));
    for (const k of ['F', 'C', 'K', 'R', 'A', 'G', 'I', 'S', '1', '2', '?']) assert.ok(listed.has(k), k);
  });
});
