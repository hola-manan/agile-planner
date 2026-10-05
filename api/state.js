// GET /api/state?code=XXX  (x-felt-token optional) → { view }
// Lazily advances time: when a deadline has passed it runs the engine tick through mutateRoom
// (save + publish only if something changed). Otherwise it is a pure read — no write per GET.
import { tick } from 'lib/engine.js';
import { viewFor } from 'lib/view.js';
import { cryptoRng } from 'lib/cards.js';
import { loadRoom, mutateRoom, resolvePlayer, requireCode, sendError, StoreError } from 'lib/store.js';

export const access = 'public';
export const methods = ['GET'];

export default async function (req, res) {
  try {
    const code = requireCode(req.query && req.query.code);
    let room = await loadRoom(code);
    if (!room) throw new StoreError('That game doesn’t exist. Check the room code.', 'not_found');
    let now = Date.now();

    if (room.state.deadline != null && room.state.deadline <= now) {
      try {
        const rng = cryptoRng();
        const out = await mutateRoom(code, (state) => {
          now = Date.now();
          if (state.deadline == null || state.deadline > now) return false; // someone else already ticked
          return tick(state, { now, rng });
        });
        room = { state: out.state, version: out.version };
      } catch (err) {
        // A failed lazy tick must not break reads; serve the last committed state.
        console.error('[felt] lazy tick failed for ' + code + ':', err && err.stack ? err.stack : err);
        now = Date.now();
      }
    }

    const pid = await resolvePlayer(room.state, req);
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ view: viewFor(room.state, pid, room.version, now) });
  } catch (err) {
    return sendError(res, err);
  }
}
