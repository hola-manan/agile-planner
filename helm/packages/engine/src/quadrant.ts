import { Complexity, Quadrant, SlotType, Task } from './types';

export const IMPORTANCE_THRESHOLD = 3;
export const URGENCY_THRESHOLD = 3;

/** Eisenhower placement from importance × time-sensitivity. */
export function quadrantOf(importance: number, timeSensitivity: number): Quadrant {
  const important = importance >= IMPORTANCE_THRESHOLD;
  const urgent = timeSensitivity >= URGENCY_THRESHOLD;
  if (important && urgent) return 'Q1';
  if (important && !urgent) return 'Q2';
  if (!important && urgent) return 'Q3';
  return 'Q4';
}

export function quadrantOfTask(t: Pick<Task, 'importance' | 'timeSensitivity'>): Quadrant {
  return quadrantOf(t.importance, t.timeSensitivity);
}

const COMPLEX_ENOUGH_FOR_DEEP: Complexity[] = ['M', 'L', 'XL'];

/**
 * 3-3-3 slot type from importance + complexity.
 * - deep: the big rocks — important AND needs sustained focus.
 * - maintenance: low-importance upkeep/admin.
 * - important: everything else worth an hour.
 */
export function slotTypeOf(importance: number, complexity: Complexity): SlotType {
  if (importance <= 2) return 'maintenance';
  if (importance >= 4 && COMPLEX_ENOUGH_FOR_DEEP.includes(complexity)) return 'deep';
  return 'important';
}

/** Days from `today` until a YYYY-MM-DD due date (negative = overdue). */
export function daysUntil(due: string | null | undefined, today: string): number | null {
  if (!due) return null;
  const a = Date.parse(due + 'T00:00:00Z');
  const b = Date.parse(today + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/**
 * Priority score — higher runs first. Combines quadrant, raw importance, due-date
 * pressure and age (so stale work escalates). Blocked/not-ready tasks are sunk
 * but still scored for reporting.
 */
export function priorityScore(t: Task, today: string, ready: boolean): number {
  const quad = quadrantOfTask(t);
  const quadBase = quad === 'Q1' ? 400 : quad === 'Q2' ? 300 : quad === 'Q3' ? 200 : 100;

  let score = quadBase + t.importance * 20;

  const du = daysUntil(t.due, today);
  if (du !== null) {
    // closer (or overdue) => more pressure, clamped to a sane band
    score += Math.max(-20, Math.min(120, (14 - du) * 10));
  }

  const ageDays = Math.max(0, Math.floor((Date.parse(today + 'T00:00:00Z') - t.createdAt) / 86_400_000));
  score += Math.min(60, ageDays * 2); // aging escalation, capped

  if (t.status === 'in_progress') score += 50; // finish what's started
  if (!ready) score -= 10_000; // blocked or deps unmet -> out of the running

  return score;
}
