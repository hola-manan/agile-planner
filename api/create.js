// POST /api/create  { hostName, gameName, settings } → { code, pid, token, view }
import { createRoom } from 'lib/engine.js';
import { viewFor } from 'lib/view.js';
import { cryptoRng } from 'lib/cards.js';
import {
  insertRoom, newRoomCode, newPid, newToken, sha256Hex, cleanName, sendError, StoreError,
} from 'lib/store.js';

export const access = 'public';
export const methods = ['POST'];

const MAX_CODE_ATTEMPTS = 8;
const DEFAULT_GAME_NAME = 'Home Game';

export default async function (req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const hostName = cleanName(body.hostName, { max: 20, label: 'Your name' });
    const gameName =
      body.gameName == null || (typeof body.gameName === 'string' && body.gameName.trim() === '')
        ? DEFAULT_GAME_NAME
        : cleanName(body.gameName, { max: 40, label: 'Game name' });
    const settings = body.settings == null ? {} : body.settings;
    if (typeof settings !== 'object' || Array.isArray(settings)) {
      throw new StoreError('Settings must be an object.', 'bad_request');
    }

    const pid = newPid();
    const token = newToken();
    const hostTokenHash = await sha256Hex(token);
    const rng = cryptoRng();

    for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
      const code = newRoomCode();
      const now = Date.now();
      // createRoom validates settings (sanitizeSettings) and throws EngineError on nonsense.
      const state = createRoom({ code, name: gameName, hostName, hostId: pid, hostTokenHash, settings }, { now, rng });
      if (await insertRoom(state)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.json({ code, pid, token, view: viewFor(state, pid, 1, now) });
      }
      // PK collision on the room code — pick another.
    }
    throw new StoreError('Couldn’t allocate a room code — please try again.', 'conflict');
  } catch (err) {
    return sendError(res, err);
  }
}
