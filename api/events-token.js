// GET /api/events-token?code=XXX → events.grant(['room:' + code]) (404 if the room is missing)
// Anyone who knows the room code may watch it (spectators see the redacted public view anyway).
import { events } from 'hatchable';
import { loadRoom, requireCode, sendError, StoreError } from 'lib/store.js';

export const access = 'public';
export const methods = ['GET'];

export default async function (req, res) {
  try {
    const code = requireCode(req.query && req.query.code);
    if (!(await loadRoom(code))) throw new StoreError('That game doesn’t exist. Check the room code.', 'not_found');
    res.setHeader('Cache-Control', 'no-store');
    return res.json(await events.grant(['room:' + code]));
  } catch (err) {
    return sendError(res, err);
  }
}
