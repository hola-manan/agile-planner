import {
  COMPLEXITY_HOURS,
  Complexity,
  SlotConfig,
  Task,
  DEFAULT_SLOT_CONFIG,
  slotHours,
} from './types';
import { slotTypeOf, daysUntil } from './quadrant';

/** Judgement fields the agent (or user) supplies; everything else is derived. */
export interface TaskJudgement {
  importance: number; // 1-5
  timeSensitivity?: number; // 1-5 (else derived from `due`)
  complexity: Complexity;
  estHours?: number; // overrides complexity mapping
  due?: string | null;
  rationale?: string;
}

/** Map a due date to a 1-5 urgency when the agent didn't state one. */
export function urgencyFromDue(due: string | null | undefined, today: string): number {
  const du = daysUntil(due, today);
  if (du === null) return 1;
  if (du <= 0) return 5;
  if (du <= 1) return 5;
  if (du <= 3) return 4;
  if (du <= 7) return 3;
  if (du <= 14) return 2;
  return 1;
}

/**
 * Turn judgement fields into a fully-derived set of engine fields: estHours from
 * complexity, slot type from importance+complexity, and the slot count from
 * hours / slot size. This is the single source of truth the LLM must not bypass.
 */
export function deriveFields(
  j: TaskJudgement,
  today: string,
  cfg: SlotConfig = DEFAULT_SLOT_CONFIG,
): Pick<Task, 'importance' | 'timeSensitivity' | 'complexity' | 'estHours' | 'slotType' | 'slots' | 'due' | 'rationale'> {
  const importance = clamp(j.importance, 1, 5);
  const timeSensitivity = clamp(
    j.timeSensitivity ?? urgencyFromDue(j.due, today),
    1,
    5,
  );
  const complexity = j.complexity;
  const estHours = j.estHours ?? COMPLEXITY_HOURS[complexity];
  const slotType = slotTypeOf(importance, complexity);
  const per = slotHours(slotType, cfg);
  const slots = Math.max(1, Math.ceil(estHours / per));
  return {
    importance,
    timeSensitivity,
    complexity,
    estHours,
    slotType,
    slots,
    due: j.due ?? null,
    rationale: j.rationale,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
