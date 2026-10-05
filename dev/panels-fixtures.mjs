// dev/panels-fixtures.mjs — extra side-panel / host-tools / ledger states not covered by
// dev/make-fixtures.mjs. Scripts real games with lib/engine.js and renders them with lib/view.js.
//
//   node dev/panels-fixtures.mjs        → dev/fixtures-panels/<name>.json + manifest.json
//
// dev/panels-preview.html maps the preview harness's fixture loader to dev/fixtures-panels/index.js,
// which lists these fixtures after the shared ones.
import { writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../lib/engine.js';
import { viewFor } from '../lib/view.js';
import { fullDeck } from '../lib/cards.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures-panels');
const T0 = Date.UTC(2026, 9, 2, 19, 30, 0);
const NAMES = { maya: 'Maya', alex: 'Alex', dev: 'Dev', ari: 'Ari', kim: 'Kim', leo: 'Leo', jonah: 'Jonah', priya: 'Priya', sana: 'Sana' };

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
    this.state = E.createRoom(
      { code: 'RVR-4821', name: 'Friday Night Game', hostName: NAMES[host], hostId: host, hostTokenHash: 'x', settings: { approveBuyIns: false, ...settings } },
      this.ctx,
    );
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
  /** Moves for whoever is to act: 'cc' | 'fold' | 'check' | 'call' | 'raise:N' | 'allin'. */
  play(moves) {
    for (const m of moves) {
      const h = this.state.hand;
      const pid = h.toAct;
      const L = E.legalActions(this.state, pid);
      this.ctx.now += 4_000;
      let a;
      if (m === 'cc') a = { type: 'act', move: L.check ? 'check' : 'call' };
      else if (m === 'allin') a = L.raise ? { type: 'act', move: 'raise', to: L.maxTo } : { type: 'act', move: 'call' };
      else if (m.startsWith('raise:')) a = { type: 'act', move: 'raise', to: Number(m.slice(6)) };
      else a = { type: 'act', move: m };
      this.do(pid, a);
    }
    return this;
  }
  /** Random-but-sane play to the end of the hand. */
  autoplay(rng) {
    let guard = 0;
    while (this.state.hand && this.state.hand.phase !== 'complete' && guard++ < 200) {
      const h = this.state.hand;
      if (h.phase === 'betting') {
        const pid = h.toAct;
        const L = E.legalActions(this.state, pid);
        const r = rng();
        this.ctx.now = Math.min(this.ctx.now + 3_000 + Math.floor(rng() * 8_000), (this.state.deadline ?? Infinity) - 1);
        if (!L.check && r < 0.3) this.do(pid, { type: 'act', move: 'fold' });
        else if (L.raise && r > 0.85) this.do(pid, { type: 'act', move: 'raise', to: Math.min(L.maxTo, Math.max(L.minTo, Math.round(L.potTo * 0.6))) });
        else this.do(pid, { type: 'act', move: L.check ? 'check' : 'call' });
      } else if (h.phase === 'ritVote') {
        for (const v of h.ritVoters) if (h.ritVotes[v] == null) this.do(v, { type: 'vote', runs: 2 });
      } else this.fire();
    }
    return this;
  }
  chat(pid, text, dt = 20_000) {
    this.ctx.now += dt;
    return this.do(pid, { type: 'chat', text });
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

/** A few hours of play with rebuys, host adjustments, chat and a paid settlement. */
function session({ hands = 24, seed = 5 } = {}) {
  const g = new Game({
    seats: { maya: 0, dev: 1, ari: 2, alex: 3, kim: 4, leo: 5, priya: 7 },
    stacks: { maya: 400, dev: 200, ari: 300, alex: 300, kim: 200, leo: 400, priya: 200 },
    settings: { seats: 8, minBuyIn: 100, maxBuyIn: 400, maxRuns: 2 },
    extra: ['jonah', 'sana'],
    seed,
  });
  g.chat('dev', 'who brought the snacks', 5_000);
  g.chat('kim', 'Leo did. again. legend', 9_000);
  g.chat('leo', 'gl all 🍀', 7_000);
  const rng = mulberry32(seed * 31);
  for (let n = 0; n < hands; n++) {
    g.deal();
    g.autoplay(rng);
    for (const p of Object.values(g.state.players)) {
      if (p.seat == null || p.leaveAfterHand) continue;
      const hand = g.state.hand;
      if (p.stack === 0 && !(hand && hand.ps[p.id] && hand.phase !== 'complete')) g.do(p.id, { type: 'buyin', amount: 200 });
    }
    if (n === 6) g.do('maya', { type: 'adjust', pid: 'kim', mode: 'add', amount: 20, reason: 'Miscount fix', countAsBuyIn: false });
    if (n === 9) {
      g.do('maya', { type: 'adjust', pid: 'leo', mode: 'remove', amount: 25, reason: 'Move from player', countAsBuyIn: false });
      g.do('maya', { type: 'adjust', pid: 'ari', mode: 'add', amount: 25, reason: 'Move from player', countAsBuyIn: false });
    }
    if (n === 12) g.do('maya', { type: 'adjust', pid: 'dev', mode: 'add', amount: 100, reason: 'Cash rebuy', countAsBuyIn: true });
    if (n === 14) g.chat('ari', 'that river was criminal', 4_000);
    if (n === 15) g.chat('alex', 'nh nh', 3_000);
    if (n === 17) g.chat('maya', 'pizza in 20, shout if you want a slice', 6_000);
    g.fire(); // next hand
  }
  return g;
}

fixture('p-host-busy', 'Host — busy table (panels)', 'Hero hosts mid-hand: sit + rebuy requests, a player away by host, one leaving, adjustments, chat.', () => {
  const g = session();
  if (!g.state.hand) g.deal();
  // Leo set away by the host, Priya leaving after this hand, Kim requests a top-up, Sana asks for a seat.
  g.do('maya', { type: 'setAway', pid: 'leo', on: true });
  g.do('maya', { type: 'settings', patch: { approveBuyIns: true } });
  g.ctx.now += 6_000;
  g.do('sana', { type: 'sit', seat: 6, amount: 300 });
  const kim = g.state.players.kim;
  if (kim.seat != null && kim.stack < 400) {
    g.ctx.now += 9_000;
    g.do('kim', { type: 'buyin', amount: Math.min(200, 400 - kim.stack) });
  }
  if (g.state.players.priya.seat != null) g.do('priya', { type: 'leave', afterHand: true });
  // a couple of moves into the hand
  for (let i = 0; i < 3 && g.state.hand && g.state.hand.phase === 'betting'; i++) g.play(['cc']);
  g.chat('sana', 'can I jump in? 🙏', 2_000);
  // first settlement paid
  const v0 = g.view('maya');
  if (v0.ledger.settlement[0]) g.do('maya', { type: 'markPaid', key: v0.ledger.settlement[0].key, paid: true });
  g.ctx.now += 2_000;
  return g.view('maya');
});

fixture('p-player-chat', 'Player — chat & last hand (panels)', 'Hero (Alex) is seated in a hand, will go away after it; lots of chat; previous hand in the log.', () => {
  const g = session({ hands: 18, seed: 8 });
  if (!g.state.hand) g.deal();
  for (let i = 0; i < 4 && g.state.hand && g.state.hand.phase === 'betting'; i++) g.play(['cc']);
  if (g.state.hand.ps.alex) g.do('alex', { type: 'away', on: true, afterHand: true });
  g.chat('alex', 'brb after this one, need to move the car', 3_000);
  g.chat('kim', 'take your time', 4_000);
  g.chat('jonah', 'can someone save me a seat for later?', 5_000);
  g.ctx.now += 1_500;
  return g.view('alex');
});

fixture('p-leaving', 'Player — leaving after hand (panels)', 'Hero (Alex) asked to stand up after this hand.', () => {
  const g = session({ hands: 10, seed: 13 });
  if (!g.state.hand) g.deal();
  g.play(['cc']);
  if (g.state.players.alex.seat != null && g.state.hand.ps.alex) g.do('alex', { type: 'leave', afterHand: true });
  g.ctx.now += 1_500;
  return g.view('alex');
});

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) if (f.endsWith('.json')) unlinkSync(path.join(OUT, f));
for (const f of fixtures) writeFileSync(path.join(OUT, f.name + '.json'), JSON.stringify(f, null, 1) + '\n');
writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(fixtures.map(({ name, title, description }) => ({ name, title, description })), null, 2) + '\n');
console.log(`wrote ${fixtures.length} panel fixtures`);
for (const f of fixtures) {
  const v = f.view;
  console.log(`  ${f.name.padEnd(18)} hand ${v.hand ? '#' + v.hand.no + ' ' + v.hand.phase + '/' + v.hand.street : '—'} me=${v.me && v.me.name} req=${v.requests.length} chat=${v.chat.length} entries=${v.ledger.entries.length} balanced=${v.ledger.totals.balanced}`);
}
