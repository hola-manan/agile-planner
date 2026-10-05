// dev/fixtures/index.js — loader for the engine-generated view fixtures (see dev/make-fixtures.mjs).
//
//   import { listFixtures, loadFixture } from './fixtures/index.js';
//   const all = await listFixtures();            // [{ name, title, description }]
//   const { view } = await loadFixture('allin-vote');
//
// Regenerate after engine/view changes:  node dev/make-fixtures.mjs

const BASE = new URL('./', import.meta.url);

export async function listFixtures() {
  const res = await fetch(new URL('manifest.json', BASE), { cache: 'no-store' });
  if (!res.ok) throw new Error('No fixtures yet — run: node dev/make-fixtures.mjs');
  return res.json();
}

/** → { name, title, description, view } */
export async function loadFixture(name) {
  if (!/^[a-z0-9-]+$/.test(String(name))) throw new Error('Bad fixture name: ' + name);
  const res = await fetch(new URL(name + '.json', BASE), { cache: 'no-store' });
  if (!res.ok) throw new Error('Unknown fixture “' + name + '” — run: node dev/make-fixtures.mjs');
  return res.json();
}

/** A copy of a fixture view with its clock moved so `serverNow` is "now" (keeps countdowns live). */
export function freshen(view, now = Date.now()) {
  const shift = now - view.serverNow;
  const move = (t) => (typeof t === 'number' ? t + shift : t);
  const v = JSON.parse(JSON.stringify(view));
  v.serverNow = now;
  v.deadline = move(v.deadline);
  if (v.hand && v.hand.ritVote) v.hand.ritVote.deadline = move(v.hand.ritVote.deadline);
  return v;
}
