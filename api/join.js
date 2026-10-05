// POST /api/join  { code, name } → { pid, token, view }
// If the x-felt-token header already belongs to a player in this room, that player is returned
// (idempotent rejoin) and `name` is ignored.
import { addPlayer } from 'lib/engine.js';
import { viewFor } from 'lib/view.js';
import { cryptoRng } from 'lib/cards.js';
import {
  loadRoom, mutateRoom, resolvePlayer, tokenFromReq, newPid, newToken, sha256Hex,
  cleanName, requireCode, sendError, StoreError,
} from 'lib/store.js';

export const access = 'public';
export const methods = ['POST'];

const MAX_PLAYERS = 30;

export default async function (req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const code = requireCode(body.code);
    res.setHeader('Cache-Control', 'no-store');

    // Existing session for this room? Hand it back instead of creating a duplicate player.
    const loaded = await loadRoom(code);
    if (!loaded) throw new StoreError('That game doesn’t exist. Check the room code.', 'not_found');
    const existing = await resolvePlayer(loaded.state, req);
    if (existing) {
      return res.json({
        pid: existing,
        token: tokenFromReq(req),
        view: viewFor(loaded.state, existing, loaded.version, Date.now()),
      });
    }

    const name = cleanName(body.name, { max: 20, label: 'Your name' });
    const pid = newPid();
    const token = newToken();
    const tokenHash = await sha256Hex(token);
    const rng = cryptoRng();
    let now = Date.now();

    const out = await mutateRoom(code, (state) => {
      now = Date.now();
      const players = Object.values(state.players || {});
      if (players.length >= MAX_PLAYERS) {
        throw new StoreError('This game is full (' + MAX_PLAYERS + ' players).', 'conflict');
      }
      const lower = name.toLocaleLowerCase();
      if (players.some((p) => String(p.name).toLocaleLowerCase() === lower)) {
        throw new StoreError('Someone at this table is already called “' + name + '”. Pick another name.', 'conflict');
      }
      addPlayer(state, { id: pid, name, tokenHash }, { now, rng });
    });

    return res.json({ pid, token, view: viewFor(out.state, pid, out.version, now) });
  } catch (err) {
    return sendError(res, err);
  }
}
