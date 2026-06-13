// Pure data model for Helm. No IO, no AI. Everything the engine reasons over.

export type Complexity = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type SlotType = 'deep' | 'important' | 'maintenance';
export type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'scheduled'
  | 'in_progress'
  | 'blocked'
  | 'done';

/** A core aspect of the user's life. Carries the goal everything is judged against. */
export interface List {
  id: string;
  name: string;
  /** The goal for this aspect — the yardstick the LLM uses to rate importance. */
  goal: string;
  kind: 'code' | 'general';
  color?: string;
  /** For code lists: git remote, so the HELM.md backlog can be synced. */
  repoUrl?: string;
  createdAt: number;
}

/** A phase/part of a List. A task's "type" is which sublist it belongs to. */
export interface Sublist {
  id: string;
  listId: string;
  name: string;
  createdAt: number;
}

export interface Task {
  id: string;
  listId: string;
  sublistId: string | null;
  title: string;

  // --- user may provide these; the agent fills any that are missing ---
  /** 1-5, value toward the parent List's goal. */
  importance: number;
  /** 1-5, how much delay hurts. Derived from `due` when present. */
  timeSensitivity: number;
  complexity: Complexity;
  /** Total effort in hours (from complexity, or user-provided). */
  estHours: number;
  due?: string | null; // YYYY-MM-DD

  // --- derived by the engine ---
  slotType: SlotType;
  /** Number of 3-3-3 slices this task occupies. */
  slots: number;
  /** Slices already completed (for partially-done multi-slot work). */
  slotsDone: number;

  status: TaskStatus;
  blocker?: string | null;
  sprintId?: string | null;
  dependsOn: string[];

  /** Short LLM rationale for the enrichment, surfaced in the UI. */
  rationale?: string;

  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
}

export interface Sprint {
  id: string;
  number: number;
  name?: string;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  status: 'planning' | 'active' | 'complete';
  /** Working days the user has in this sprint. */
  capacityDays: number;
  /** Specific YYYY-MM-DD dates taken as leave (subtracted from capacity). */
  leaveDays: string[];
  goal?: string;
  createdAt: number;
}

/** Tunables for the 3-3-3 day shape. Defaults match the classic method. */
export interface SlotConfig {
  deepCount: number; // 1
  deepHours: number; // 3
  importantCount: number; // 3
  importantHours: number; // 1
  maintenanceCount: number; // 3
  maintenanceHours: number; // 1
}

export const DEFAULT_SLOT_CONFIG: SlotConfig = {
  deepCount: 1,
  deepHours: 3,
  importantCount: 3,
  importantHours: 1,
  maintenanceCount: 3,
  maintenanceHours: 1,
};

/** Hours one slice of a given slot type represents. */
export function slotHours(type: SlotType, cfg: SlotConfig = DEFAULT_SLOT_CONFIG): number {
  return type === 'deep'
    ? cfg.deepHours
    : type === 'important'
      ? cfg.importantHours
      : cfg.maintenanceHours;
}

export const COMPLEXITY_HOURS: Record<Complexity, number> = {
  XS: 0.5,
  S: 1,
  M: 3,
  L: 6,
  XL: 12,
};

export type AlertKind =
  | 'q2_neglect'
  | 'aging'
  | 'over_capacity'
  | 'blocked'
  | 'deadline_risk'
  | 'unblocked_ready';

export interface Alert {
  kind: AlertKind;
  severity: 'info' | 'warn' | 'critical';
  message: string;
  taskIds: string[];
}

/** One placed slice inside a working day. */
export interface PlannedSlot {
  type: SlotType;
  taskId: string;
  taskTitle: string;
  hours: number;
  /** e.g. "2 of 3" when a task spans multiple slices. */
  slicePosition?: string;
}

export interface DayPlan {
  date: string; // YYYY-MM-DD
  slots: PlannedSlot[];
  /** Slot openings that nothing was eligible to fill. */
  unfilled: { type: SlotType; hours: number }[];
}

export interface SolveResult {
  /** Tasks committed to the active sprint, in priority order. */
  committed: Task[];
  /** Tasks pushed to / left in the backlog (didn't fit or not ready). */
  backlog: Task[];
  /** Today's 3-3-3 plan — the short "what to do next" list. */
  today: DayPlan;
  alerts: Alert[];
}
