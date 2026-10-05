// POST /api/act  { code, type, ...args } → { view }
// Every player / host / tick action goes through engine.apply inside an optimistic mutateRoom.
import { apply, tick } from 'lib/engine.js';
import { viewFor } from 'lib/view.js';
import { cryptoRng } from 'lib/cards.js';
import { RATE_LIMITED, rateWait, spendRate } from 'lib/ratelimit.js';
import {
  loadRoom, mutateRoom, resolvePlayer, requireCode, sendError, StoreError, ERROR_STATUS,
} from 'lib/store.js';

export const access = 'public';
export const methods = ['POST'];

const TYPE_RE = /^[a-zA-Z]{1,32}$/;

export default async function (req, res) {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
    if (!body) throw new StoreError('Expected a JSON body.', 'bad_request');
    const code = requireCode(body.code);
    const { code: _code, ...action } = body;
    if (typeof action.type !== 'string' || !TYPE_RE.test(action.type)) {
      throw new StoreError('Unknown action.', 'bad_request');
    }
    res.setHeader('Cache-Control', 'no-store');
    const rng = cryptoRng();
    let now = Date.now();

    if (action.type === 'tick') {
      // Anyone (even anonymous) may tick. Skip the write path entirely unless a deadline is due.
      const room = await loadRoom(code);
      if (!room) throw new StoreError('That game doesn’t exist. Check the room code.', 'not_found');
      const pid = await resolvePlayer(room.state, req);
      if (room.state.deadline == null || room.state.deadline > now) {
        return res.json({ view: viewFor(room.state, pid, room.version, now) });
      }
      const out = await mutateRoom(code, (state) => {
        now = Date.now();
        apply(state, pid, { type: 'tick' }, { now, rng });
      });
      return res.json({ view: viewFor(out.state, pid, out.version, now) });
    }

    let pid = null;
    let dueBeforeAction = false;
    let out;
    try {
      out = await mutateRoom(code, async (state) => {
        pid = await resolvePlayer(state, req);
        if (!pid) throw new StoreError('Join this game first.', 'forbidden');
        now = Date.now();
        dueBeforeAction = state.deadline != null && state.deadline <= now;
        // Cheap repeatable actions are rate limited per player and per room (lib/ratelimit.js):
        // each committed change costs one realtime publish from a project-wide budget.
        const limited = RATE_LIMITED.has(action.type);
        if (limited) {
          const wait = rateWait(state, pid, now);
          if (wait > 0) throw new StoreError(`Slow down a little — try again in ${Math.ceil(wait / 1000)}s.`, 'rate_limited');
        }
        const before = limited ? JSON.stringify(state) : null;
        apply(state, pid, action, { now, rng });
        if (limited && JSON.stringify(state) !== before) spendRate(state, pid, now);
      });
    } catch (err) {
      // apply() ticks before validating the action, but a rejected action rolls the tick back too.
      // Don't let a rejected action (e.g. acting just after your clock ran out) stall the table:
      // commit the overdue time-based transition on its own, then report the rejection.
      if (dueBeforeAction && err && ERROR_STATUS[err.code]) {
        await mutateRoom(code, (state) => {
          const t = Date.now();
          if (state.deadline != null && state.deadline <= t) tick(state, { now: t, rng });
        }).catch((e) => console.error('[felt] catch-up tick failed for ' + code + ':', e && e.message));
      }
      throw err;
    }
    return res.json({ view: viewFor(out.state, pid, out.version, now) });
  } catch (err) {
    return sendError(res, err);
  }
}
