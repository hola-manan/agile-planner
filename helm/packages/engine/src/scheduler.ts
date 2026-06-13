import {
  Alert,
  DayPlan,
  PlannedSlot,
  SlotConfig,
  SlotType,
  SolveResult,
  Sprint,
  Task,
  DEFAULT_SLOT_CONFIG,
  slotHours,
} from './types';
import { daysUntil, priorityScore, quadrantOfTask } from './quadrant';
import { sprintCapacityHours } from './capacity';

export interface SolveInput {
  tasks: Task[];
  /** The active sprint to commit against. If absent, nothing is committed. */
  sprint?: Sprint | null;
  today: string; // YYYY-MM-DD
  slotConfig?: SlotConfig;
  /** Tasks older than this many days that are still open raise an aging alert. */
  agingDays?: number;
  /** Due within this many days + unscheduled raises a deadline-risk alert. */
  deadlineWindow?: number;
}

// Statuses that are "open" — still part of the portfolio the solver reasons over.
// `blocked` is included so it surfaces in alerts; isReady() keeps it off the plan.
const ACTIVE_STATUSES = new Set<Task['status']>([
  'backlog',
  'todo',
  'scheduled',
  'in_progress',
  'blocked',
]);

export function remainingSlots(t: Task): number {
  return Math.max(0, t.slots - t.slotsDone);
}

export function remainingHours(t: Task, cfg: SlotConfig): number {
  return remainingSlots(t) * slotHours(t.slotType, cfg);
}

/** A task can be worked if it's open, not blocked, and every dependency is done. */
export function isReady(t: Task, doneIds: Set<string>): boolean {
  if (!ACTIVE_STATUSES.has(t.status)) return false;
  if (t.status === 'blocked') return false;
  return t.dependsOn.every((d) => doneIds.has(d));
}

/**
 * The whole solve. Pure: same input → same plan. Runs on every mutation, which
 * is what keeps "Today" honest. Greedy by priority, so a high-priority arrival
 * naturally bumps the lowest-value work past the capacity line into the backlog.
 */
export function solve(input: SolveInput): SolveResult {
  const cfg = input.slotConfig ?? DEFAULT_SLOT_CONFIG;
  const today = input.today;
  const agingDays = input.agingDays ?? 14;
  const deadlineWindow = input.deadlineWindow ?? 3;

  const doneIds = new Set(input.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const open = input.tasks.filter((t) => ACTIVE_STATUSES.has(t.status));

  const ranked = [...open].sort(
    (a, b) =>
      priorityScore(b, today, isReady(b, doneIds)) -
      priorityScore(a, today, isReady(a, doneIds)),
  );

  // --- Agile: commit to the active sprint within capacity --------------------
  const committed: Task[] = [];
  const backlog: Task[] = [];
  const capacity = input.sprint ? sprintCapacityHours(input.sprint, cfg) : 0;
  let used = 0;

  for (const t of ranked) {
    const ready = isReady(t, doneIds);
    const need = remainingHours(t, cfg);
    if (input.sprint && ready && used + need <= capacity) {
      used += need;
      committed.push({ ...t, sprintId: input.sprint.id });
    } else {
      // didn't fit, not ready, or no sprint -> backlog (clear stale commitment)
      backlog.push(input.sprint && t.sprintId === input.sprint.id ? { ...t, sprintId: null } : t);
    }
  }

  // --- 3-3-3: pack today's slots from committed, ready tasks ------------------
  const today_ = packDay(committed, doneIds, today, cfg);

  // --- Proactive alerts ------------------------------------------------------
  const alerts = buildAlerts({
    ranked,
    committed,
    backlog,
    capacity,
    used,
    today,
    today_,
    doneIds,
    agingDays,
    deadlineWindow,
  });

  return { committed, backlog, today: today_, alerts };
}

function packDay(
  committed: Task[],
  doneIds: Set<string>,
  date: string,
  cfg: SlotConfig,
): DayPlan {
  const order: { type: SlotType; count: number }[] = [
    { type: 'deep', count: cfg.deepCount },
    { type: 'important', count: cfg.importantCount },
    { type: 'maintenance', count: cfg.maintenanceCount },
  ];

  // remaining slot budget per task for *this* day
  const remaining = new Map<string, number>();
  for (const t of committed) remaining.set(t.id, remainingSlots(t));

  const slots: PlannedSlot[] = [];
  const unfilled: { type: SlotType; hours: number }[] = [];

  for (const band of order) {
    const pool = committed
      .filter((t) => t.slotType === band.type && isReady(t, doneIds) && (remaining.get(t.id) ?? 0) > 0)
      .sort((a, b) => priorityScore(b, date, true) - priorityScore(a, date, true));

    for (let i = 0; i < band.count; i++) {
      const pick = pool.find((t) => (remaining.get(t.id) ?? 0) > 0);
      if (!pick) {
        unfilled.push({ type: band.type, hours: slotHours(band.type, cfg) });
        continue;
      }
      const rem = remaining.get(pick.id)!;
      remaining.set(pick.id, rem - 1);
      const total = pick.slots;
      const sliceNo = total - rem + 1; // 1-based slice index
      slots.push({
        type: band.type,
        taskId: pick.id,
        taskTitle: pick.title,
        hours: slotHours(band.type, cfg),
        slicePosition: total > 1 ? `${sliceNo} of ${total}` : undefined,
      });
    }
  }

  return { date, slots, unfilled };
}

function buildAlerts(ctx: {
  ranked: Task[];
  committed: Task[];
  backlog: Task[];
  capacity: number;
  used: number;
  today: string;
  today_: DayPlan;
  doneIds: Set<string>;
  agingDays: number;
  deadlineWindow: number;
}): Alert[] {
  const alerts: Alert[] = [];

  // Over capacity: ready, unblocked work overflowed into the backlog.
  const overflow = ctx.backlog.filter((t) => isReady(t, ctx.doneIds));
  if (ctx.capacity > 0 && overflow.length > 0) {
    alerts.push({
      kind: 'over_capacity',
      severity: 'warn',
      message: `${overflow.length} ready task(s) don't fit this sprint's capacity (${ctx.used.toFixed(
        1,
      )}/${ctx.capacity}h used). Lowest-priority work was pushed to the backlog.`,
      taskIds: overflow.map((t) => t.id),
    });
  }

  // Blocked work.
  const blocked = ctx.ranked.filter((t) => t.status === 'blocked');
  if (blocked.length > 0) {
    alerts.push({
      kind: 'blocked',
      severity: 'warn',
      message: `${blocked.length} task(s) blocked: ${blocked
        .map((t) => `"${t.title}"${t.blocker ? ` (${t.blocker})` : ''}`)
        .join(', ')}.`,
      taskIds: blocked.map((t) => t.id),
    });
  }

  // Aging: old, still-open, ready work that keeps getting skipped.
  const aging = ctx.ranked.filter(
    (t) =>
      isReady(t, ctx.doneIds) &&
      Math.floor((Date.parse(ctx.today + 'T00:00:00Z') - t.createdAt) / 86_400_000) >= ctx.agingDays,
  );
  if (aging.length > 0) {
    alerts.push({
      kind: 'aging',
      severity: 'info',
      message: `${aging.length} task(s) have been open over ${ctx.agingDays} days. Do them, delegate them, or drop them.`,
      taskIds: aging.map((t) => t.id),
    });
  }

  // Deadline risk: due soon but not committed.
  const committedIds = new Set(ctx.committed.map((t) => t.id));
  const atRisk = ctx.ranked.filter((t) => {
    const du = daysUntil(t.due, ctx.today);
    return du !== null && du <= ctx.deadlineWindow && !committedIds.has(t.id);
  });
  if (atRisk.length > 0) {
    alerts.push({
      kind: 'deadline_risk',
      severity: 'critical',
      message: `${atRisk.length} task(s) due within ${ctx.deadlineWindow} day(s) are not committed to the sprint.`,
      taskIds: atRisk.map((t) => t.id),
    });
  }

  // Q2 neglect: important-not-urgent work exists but today touches none of it.
  const plannedToday = new Set(ctx.today_.slots.map((s) => s.taskId));
  const q2Open = ctx.ranked.filter((t) => quadrantOfTask(t) === 'Q2');
  const q2Today = ctx.today_.slots.some((s) => {
    const t = ctx.ranked.find((x) => x.id === s.taskId);
    return t && quadrantOfTask(t) === 'Q2';
  });
  if (q2Open.length > 0 && !q2Today && plannedToday.size > 0) {
    alerts.push({
      kind: 'q2_neglect',
      severity: 'info',
      message: `You have ${q2Open.length} important-but-not-urgent (Q2) task(s) and today's plan touches none of them. Q2 is where the real progress lives.`,
      taskIds: q2Open.map((t) => t.id),
    });
  }

  return alerts;
}
