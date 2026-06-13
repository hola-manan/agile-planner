// Thin client + types mirroring the engine/server contract.
export type SlotType = 'deep' | 'important' | 'maintenance';
export type Quadrant = 'Q1' | 'Q2' | 'Q3' | 'Q4';
export type TaskStatus =
  | 'backlog' | 'todo' | 'scheduled' | 'in_progress' | 'blocked' | 'done';

export interface List {
  id: string; name: string; goal: string; kind: 'code' | 'general';
  color?: string; repoUrl?: string; createdAt: number;
}
export interface Sublist { id: string; listId: string; name: string; createdAt: number; }

export interface Task {
  id: string; listId: string; sublistId: string | null; title: string;
  importance: number; timeSensitivity: number; complexity: string; estHours: number;
  due?: string | null; slotType: SlotType; slots: number; slotsDone: number;
  status: TaskStatus; blocker?: string | null; sprintId?: string | null;
  dependsOn: string[]; rationale?: string; createdAt: number; updatedAt: number;
}

export interface Sprint {
  id: string; number: number; name?: string; startDate: string; endDate: string;
  status: 'planning' | 'active' | 'complete'; capacityDays: number;
  leaveDays: string[]; goal?: string; createdAt: number;
}

export interface PlannedSlot {
  type: SlotType; taskId: string; taskTitle: string; hours: number; slicePosition?: string;
}
export interface DayPlan {
  date: string; slots: PlannedSlot[]; unfilled: { type: SlotType; hours: number }[];
}
export interface Alert {
  kind: string; severity: 'info' | 'warn' | 'critical'; message: string; taskIds: string[];
}
export interface SolveResult {
  committed: Task[]; backlog: Task[]; today: DayPlan; alerts: Alert[];
}
export interface AppState {
  lists: List[]; sublists: Sublist[]; sprints: Sprint[]; tasks: Task[];
  plan: SolveResult; aiBackend: string;
}

const BASE = '/api';
async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  state: () => fetch(`${BASE}/state`).then(j<AppState>),
  addTask: (body: Record<string, unknown>) =>
    fetch(`${BASE}/tasks`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(
      j<{ task: Task; plan: SolveResult }>,
    ),
  patchTask: (id: string, body: Record<string, unknown>) =>
    fetch(`${BASE}/tasks/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) }).then(
      j<{ task: Task; plan: SolveResult }>,
    ),
  createList: (body: Record<string, unknown>) =>
    fetch(`${BASE}/lists`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(j<List>),
  addSublist: (listId: string, name: string) =>
    fetch(`${BASE}/lists/${listId}/sublists`, { method: 'POST', headers: H, body: JSON.stringify({ name }) }).then(
      j<Sublist>,
    ),
  createSprint: (body: Record<string, unknown>) =>
    fetch(`${BASE}/sprints`, { method: 'POST', headers: H, body: JSON.stringify(body) }).then(j<Sprint>),
  patchSprint: (id: string, body: Record<string, unknown>) =>
    fetch(`${BASE}/sprints/${id}`, { method: 'PATCH', headers: H, body: JSON.stringify(body) }).then(
      j<{ sprint: Sprint; plan: SolveResult }>,
    ),
};
const H = { 'Content-Type': 'application/json' };
