// dev/table-fixtures.mjs — extra table/action-bar states not covered by dev/make-fixtures.mjs.
// Scripts real games with lib/engine.js and renders them with lib/view.js.
//
//   node dev/table-fixtures.mjs        → dev/fixtures-table/<name>.json + manifest.json
//
// dev/table-preview.html maps the preview harness's fixture loader to dev/fixtures-table/index.js,
// which lists these fixtures after the shared ones.
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../lib/engine.js';
import { viewFor } from '../lib/view.js';
import { fullDeck } from '../lib/cards.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures-table');
const T0 = Date.UTC(2026, 9, 2, 19, 30, 0);
const NAMES = { maya: 'Maya', alex: 'Alex', dev: 'Dev', ari: 'Ari', kim: 'Kim', leo: 'Leo', jonah: 'Jonah', priya: 'Priya', sam: 'Sam' };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Game {
  constructor({ seats, stacks = {}, settings = {}, host = 'maya', extra = [], seed = 7 }) {
    this.ctx = { now: T0, rng: mulberry32(seed) };
    this.version = 1;
    this.state = E.createRoom({ code: 'RVR-4821', name: 'Friday Night Game', hostName: NAMES[host], hostId: host, hostTokenHash: 'x', settings: { approveBuyIns: false, ...settings } }, this.ctx);
    for (const pid of [...Object.keys(seats), ...extra]) {
      if (pid === host) continue;
      E.addPlayer(this.state, { id: pid, name: NAMES[pid] || pid, tokenHash: 'x' }, this.ctx);
      this.ctx.now += 10_000;
    }
    for (const [pid, seat] of Object.entries(seats)) this.do(pid, { type: 'sit', seat, amount: stacks[pid] ?? 200 });
  }
  do(pid, a) {
    E.apply(this.state, pid, a, this.ctx);
    this.version++;
    return this;
  }
  fire() {
    this.ctx.now = Math.max(this.ctx.now, this.state.deadline);
    E.tick(this.state, this.ctx);
    this.version++;
    return this;
  }
  deal() {
    if (!this.state.hand) this.fire();
    return this;
  }
  rig(holes, board = []) {
    const h = this.state.hand;
    const taken = new Set([...Object.values(holes).flat(), ...board]);
    const pool = fullDeck().filter((c) => !taken.has(c));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this.ctx.rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (const pid of h.order) h.ps[pid].hole = holes[pid] ? holes[pid].slice() : pool.splice(0, h.ps[pid].hole.length);
    h.deck = [...board, ...pool];
    return this;
  }
  play(moves) {
    for (const m of moves) {
      const h = this.state.hand;
      const pid = h.toAct;
      const L = E.legalActions(this.state, pid);
      this.ctx.now += 2_500;
      let a;
      if (m === 'cc') a = { type: 'act', move: L.check ? 'check' : 'call' };
      else if (m === 'allin') a = L.raise ? { type: 'act', move: 'raise', to: L.maxTo } : { type: 'act', move: 'call' };
      else if (m === 'pot') a = { type: 'act', move: 'raise', to: L.potTo };
      else if (m.startsWith('raise:')) a = { type: 'act', move: 'raise', to: Number(m.slice(6)) };
      else a = { type: 'act', move: m };
      this.do(pid, a);
    }
    return this;
  }
  view(pid) {
    return viewFor(this.state, pid, this.version, this.ctx.now);
  }
}

const fixtures = [];
function fixture(name, title, description, build) {
  try {
    fixtures.push({ name, title, description, view: build() });
  } catch (err) {
    console.error(`✗ ${name}: ${(err.stack || String(err)).split('\n').slice(0, 4).join('\n')}`);
    process.exitCode = 1;
  }
}

const FIVE = { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4 };
const FIVE_STACKS = { maya: 300, dev: 520, ari: 210, alex: 236, kim: 400 };

fixture('t-ran-twice-complete', 'Ran twice — complete', 'All-in on the flop, both ran it twice and split the runs; winning cards lifted per run.', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxRuns: 3, maxBuyIn: 600 }, seed: 3 });
  g.deal().rig({ alex: ['Ah', 'Kh'], dev: ['Qs', 'Qd'] }, ['Qh', '7h', '2c', '5d', '9s', 'Th', 'Kc']);
  g.play(['raise:6', 'fold', 'fold', 'cc', 'fold']);
  g.play(['raise:12', 'allin', 'call']);
  g.do('dev', { type: 'vote', runs: 2 }).do('alex', { type: 'vote', runs: 2 });
  while (g.state.hand.phase === 'runout') g.fire();
  g.ctx.now += 1_500;
  return g.view('alex');
});

fixture('t-three-runs', 'Running it three times', 'Three runs, run 2 dealing; hero is a spectator watching.', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxRuns: 3, maxBuyIn: 600 }, seed: 3, extra: ['priya'] });
  g.deal().rig({ alex: ['Ah', 'Kh'], dev: ['Qs', 'Qd'] }, ['Qh', '7h', '2c', '5d', '9s', 'Th', 'Kc', '3h', '8d']);
  g.play(['raise:6', 'fold', 'fold', 'cc', 'fold']);
  g.play(['raise:12', 'allin', 'call']);
  g.do('dev', { type: 'vote', runs: 3 }).do('alex', { type: 'vote', runs: 3 });
  for (let i = 0; i < 3; i++) g.fire();
  g.ctx.now += 600;
  return g.view('priya');
});

fixture('t-vote-watching', 'Run-it vote (not a voter)', 'Hero folded; the two all-in players are voting — their cards stay face down until the vote closes.', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxRuns: 2, maxBuyIn: 600 }, seed: 3 });
  g.deal().rig({ alex: ['Ah', 'Kh'], dev: ['Qs', 'Qd'], kim: ['7c', '2d'] }, ['Qh', '7h', '2c', '5d', '9s']);
  // dev SB, ari BB, alex, kim, maya
  g.play(['raise:6', 'cc', 'fold', 'cc', 'fold']); // alex raise, kim call, maya fold, dev call, ari fold
  g.play(['check', 'raise:20', 'fold', 'allin']); // flop: dev check, alex bets, kim folds, dev jams
  if (g.state.hand.toAct === 'alex') g.play(['call']);
  g.ctx.now += 1_000;
  g.do('dev', { type: 'vote', runs: 2 });
  g.ctx.now += 1_500;
  return g.view('kim');
});

fixture('t-runout-start', 'Runout starts (vote closed)', 'Both voted twice: the vote just closed, so the all-in hands flipped and the win % appeared; run 1 has not dealt yet.', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxRuns: 3, maxBuyIn: 600 }, seed: 3 });
  g.deal().rig({ alex: ['Ah', 'Kh'], dev: ['Qs', 'Qd'] }, ['Qh', '7h', '2c', '5d', '9s', 'Th', 'Kc']);
  g.play(['raise:6', 'fold', 'fold', 'cc', 'fold']);
  g.play(['raise:12', 'allin', 'call']);
  g.ctx.now += 1_500;
  g.do('dev', { type: 'vote', runs: 2 });
  g.ctx.now += 2_000;
  g.do('alex', { type: 'vote', runs: 2 });
  if (g.state.hand.phase !== 'runout') throw new Error('expected runout, got ' + g.state.hand.phase);
  g.ctx.now += 400;
  return g.view('alex');
});

fixture('t-plo-showdown', 'PLO showdown', 'Pot-Limit Omaha river showdown, hero wins with a straight.', () => {
  const g = new Game({ seats: { maya: 0, dev: 1, alex: 2, kim: 3 }, stacks: { maya: 400, dev: 380, alex: 520, kim: 260 }, settings: { variant: 'PLO', seats: 6, maxBuyIn: 600 }, seed: 21 });
  g.deal().rig({ alex: ['Ah', 'Kh', 'Qd', 'Jc'], dev: ['9s', '9d', '8c', '7c'] }, ['Th', '9c', '2h', '5s', 'Ad']);
  // button maya: dev SB, alex BB, kim, maya
  g.play(['raise:7', 'fold', 'cc', 'cc']); // kim raise, maya fold, dev call, alex call
  g.play(['check', 'check', 'check']);
  g.play(['check', 'raise:10', 'fold', 'cc']);
  g.play(['check', 'raise:30', 'cc']);
  g.ctx.now += 1_200;
  return g.view('alex');
});

fixture('t-preflop-fold-ghosts', 'Fold preflop — all ghosts', 'Everyone folded preflop; the five would-have-come cards revealed as ghosts. Hero won.', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxBuyIn: 600 }, seed: 5 });
  g.deal().rig({ alex: ['Ac', 'Ad'] }, ['Ks', 'Qd', '4c', '8h', '2s']);
  g.play(['raise:6', 'fold', 'fold', 'fold', 'fold']);
  g.ctx.now += 1_200;
  g.do('kim', { type: 'revealRunout' });
  g.ctx.now += 400;
  return g.view('alex');
});

fixture('t-won-uncontested', 'Won uncontested — show?', 'Hero bet the flop and everyone folded: “You won — show your cards?” and the reveal-runout button.', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxBuyIn: 600, revealRunout: 'anyone' }, seed: 6 });
  g.deal().rig({ alex: ['7s', '6s'] }, ['Ks', 'Qd', '4c', '8h', '2s']);
  g.play(['raise:6', 'fold', 'fold', 'cc', 'fold']);
  g.play(['check', 'raise:8', 'fold']);
  g.ctx.now += 900;
  return g.view('alex');
});

fixture('t-opening-bet-leaving', 'Opening bet + leaving after hand', 'Hero first to act on the flop (Bet), has asked to leave after this hand.', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxBuyIn: 600 }, seed: 8 });
  g.deal().rig({ alex: ['Jh', 'Th'] }, ['9h', '8c', '2h', 'Ks', '3d']);
  g.play(['cc', 'cc', 'cc', 'cc', 'cc']);
  if (g.state.hand.street === 'preflop') g.play(['cc']);
  while (g.state.hand.toAct !== 'alex') g.play(['check']);
  g.do('alex', { type: 'leave', afterHand: true });
  g.ctx.now += 3_000;
  return g.view('alex');
});

fixture('t-waiting-players', 'Waiting for players', 'Only one player with chips: no hand; hero just sat down.', () => {
  const g = new Game({ seats: { alex: 3 }, stacks: { alex: 200 }, settings: { seats: 6, maxBuyIn: 600 }, seed: 2, extra: ['dev'] });
  return g.view('alex');
});

fixture('t-spectator-requested', 'Spectator with a seat request', 'Hero asked for seat 6 and waits for the host (approve buy-ins on).', () => {
  const g = new Game({ seats: FIVE, stacks: FIVE_STACKS, settings: { maxBuyIn: 600, seats: 7 }, seed: 9, extra: ['jonah'] });
  g.do('maya', { type: 'settings', patch: { approveBuyIns: true } });
  g.deal();
  g.play(['cc', 'cc']);
  g.do('jonah', { type: 'sit', seat: 5, amount: 300 });
  g.ctx.now += 2_000;
  return g.view('jonah');
});

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.json')) unlinkSync(path.join(OUT, f));
for (const f of fixtures) writeFileSync(path.join(OUT, f.name + '.json'), JSON.stringify(f, null, 1) + '\n');
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(fixtures.map(({ name, title, description }) => ({ name, title, description })), null, 2) + '\n');
console.log(`wrote ${fixtures.length} table fixtures`);
for (const f of fixtures) {
  const h = f.view.hand;
  console.log(`  ${f.name.padEnd(26)} ${h ? `${h.phase}/${h.street} runs=${h.runs} toAct=${h.toAct}` : 'no hand'} me=${f.view.me && f.view.me.name}`);
}
