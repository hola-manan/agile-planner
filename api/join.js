// POST /api/join  { code, name } → { pid, token, view }
// If the x-felt-token header already belongs to a player in this room, that player is returned
// (idempotent rejoin) and `name` is ignored.
import { addPlayer, activePlayers, nameKey } from 'lib/engine.js';
import { rateWait, spendRate } from 'lib/ratelimit.js';
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

    const name = cleanName(body.name, { max: 20, label: 'Your name', player: true });
    const pid = newPid();
    const token = newToken();
    const tokenHash = await sha256Hex(token);
    const rng = cryptoRng();
    let now = Date.now();

    const out = await mutateRoom(code, (state) => {
      now = Date.now();
      // Players the host removed don't count: their spot and their name are free again.
      const players = activePlayers(state);
      if (players.length >= MAX_PLAYERS) {
        throw new StoreError('This game is full (' + MAX_PLAYERS + ' players).', 'conflict');
      }
      const key = nameKey(name); // lookalikes (case, full-width, ligatures) count as the same name
      if (players.some((p) => nameKey(p.name) === key)) {
        throw new StoreError('Someone at this table is already called “' + name + '”. Pick another name.', 'conflict');
      }
      const wait = rateWait(state, null, now);
      if (wait > 0) throw new StoreError(`Lots of people are joining — try again in ${Math.ceil(wait / 1000)}s.`, 'rate_limited');
      addPlayer(state, { id: pid, name, tokenHash }, { now, rng });
      spendRate(state, null, now);
    });

    return res.json({ pid, token, view: viewFor(out.state, pid, out.version, now) });
  } catch (err) {
    return sendError(res, err);
  }
}
