import type { D1Database } from '@cloudflare/workers-types';
import {
  deriveFields,
  solve,
  type Complexity,
  type List,
  type SolveResult,
  type Sprint,
  type Sublist,
  type Task,
} from '@helm/engine';
import { buildEnricher, type Enricher } from './agent/graph.js';
import type { RawTaskInput } from './agent/prompts.js';

const uid = (p: string) => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
const todayISO = () => new Date().toISOString().slice(0, 10);
/** D1 .bind() rejects `undefined`; coerce optionals to null. */
const nn = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

const TASK_COLUMNS = [
  'id', 'listId', 'sublistId', 'title', 'importance', 'timeSensitivity', 'complexity',
  'estHours', 'due', 'slotType', 'slots', 'slotsDone', 'status', 'blocker', 'sprintId',
  'dependsOn', 'rationale', 'createdAt', 'updatedAt', 'completedAt',
] as const;

export class Store {
  constructor(private db: D1Database, private enricher: Enricher = buildEnricher()) {}

  // --- reads ----------------------------------------------------------------
  async lists(): Promise<List[]> {
    return (await this.db.prepare('SELECT * FROM lists ORDER BY createdAt').all<List>()).results;
  }
  async sublists(listId?: string): Promise<Sublist[]> {
    const stmt = listId
      ? this.db.prepare('SELECT * FROM sublists WHERE listId = ? ORDER BY createdAt').bind(listId)
      : this.db.prepare('SELECT * FROM sublists ORDER BY createdAt');
    return (await stmt.all<Sublist>()).results;
  }
  async tasks(): Promise<Task[]> {
    const { results } = await this.db.prepare('SELECT * FROM tasks').all<TaskRow>();
    return results.map(rowToTask);
  }
  async sprints(): Promise<Sprint[]> {
    const { results } = await this.db.prepare('SELECT * FROM sprints ORDER BY number').all<SprintRow>();
    return results.map((s) => ({ ...s, leaveDays: JSON.parse(s.leaveDays || '[]') }) as Sprint);
  }
  async activeSprint(): Promise<Sprint | null> {
    return (await this.sprints()).find((s) => s.status === 'active') ?? null;
  }

  /** The live plan — pure, persists nothing. Runs on every mutation. */
  async solveState(today = todayISO()): Promise<SolveResult> {
    const [tasks, sprint] = await Promise.all([this.tasks(), this.activeSprint()]);
    return solve({ tasks, sprint, today });
  }

  // --- lists / sublists -----------------------------------------------------
  async createList(input: Partial<List> & { name: string }): Promise<List> {
    const list: List = {
      id: uid('list'),
      name: input.name,
      goal: input.goal ?? '',
      kind: input.kind ?? 'general',
      color: input.color,
      repoUrl: input.repoUrl,
      createdAt: Date.now(),
    };
    await this.db
      .prepare('INSERT INTO lists (id,name,goal,kind,color,repoUrl,createdAt) VALUES (?,?,?,?,?,?,?)')
      .bind(list.id, list.name, list.goal, list.kind, nn(list.color), nn(list.repoUrl), list.createdAt)
      .run();
    return list;
  }
  async createSublist(listId: string, name: string): Promise<Sublist> {
    const s: Sublist = { id: uid('sub'), listId, name, createdAt: Date.now() };
    await this.db
      .prepare('INSERT INTO sublists (id,listId,name,createdAt) VALUES (?,?,?,?)')
      .bind(s.id, s.listId, s.name, s.createdAt)
      .run();
    return s;
  }

  // --- sprints --------------------------------------------------------------
  async createSprint(input: Partial<Sprint> & { startDate: string; endDate: string }): Promise<Sprint> {
    const number = ((await this.sprints()).at(-1)?.number ?? 0) + 1;
    const s: Sprint = {
      id: uid('spr'),
      number,
      name: input.name,
      startDate: input.startDate,
      endDate: input.endDate,
      status: input.status ?? 'planning',
      capacityDays: input.capacityDays ?? 10,
      leaveDays: input.leaveDays ?? [],
      goal: input.goal,
      createdAt: Date.now(),
    };
    await this.db
      .prepare(
        'INSERT INTO sprints (id,number,name,startDate,endDate,status,capacityDays,leaveDays,goal,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(s.id, s.number, nn(s.name), s.startDate, s.endDate, s.status, s.capacityDays, JSON.stringify(s.leaveDays), nn(s.goal), s.createdAt)
      .run();
    return s;
  }
  async updateSprint(id: string, patch: Partial<Sprint>): Promise<Sprint | null> {
    const cur = (await this.sprints()).find((s) => s.id === id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    await this.db
      .prepare('UPDATE sprints SET name=?,startDate=?,endDate=?,status=?,capacityDays=?,leaveDays=?,goal=? WHERE id=?')
      .bind(nn(next.name), next.startDate, next.endDate, next.status, next.capacityDays, JSON.stringify(next.leaveDays), nn(next.goal), id)
      .run();
    return next;
  }

  // --- tasks ----------------------------------------------------------------
  /** Add a task; the agent fills any judgement fields the user omitted. */
  async addTask(raw: RawTaskInput, today = todayISO()): Promise<Task> {
    const list = (await this.lists()).find((l) => l.id === raw.listId);
    if (!list) throw new Error('unknown list');

    let importance = raw.importance;
    let timeSensitivity: number | undefined;
    let complexity: Complexity | undefined;
    const estHours = raw.estHours;
    let sublistId = raw.sublistId ?? null;
    let rationale: string | undefined;

    if (raw.importance == null || raw.estHours == null) {
      const siblings = (await this.tasks())
        .filter((t) => t.listId === list.id)
        .map((t) => ({ title: t.title, importance: t.importance, complexity: t.complexity }));
      const j = await this.enricher.enrich(raw, { list, sublists: await this.sublists(list.id), siblings, today });
      importance = importance ?? j.importance;
      timeSensitivity = j.timeSensitivity;
      complexity = j.complexity;
      sublistId = sublistId ?? j.sublistId;
      rationale = j.rationale;
    }

    const derived = deriveFields(
      { importance: importance ?? 3, timeSensitivity, complexity: complexity ?? 'M', estHours, due: raw.due ?? null, rationale },
      today,
    );
    const task: Task = {
      id: uid('task'),
      listId: list.id,
      sublistId,
      title: raw.title,
      ...derived,
      slotsDone: 0,
      status: 'backlog',
      blocker: null,
      sprintId: null,
      dependsOn: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
    };
    await this.db
      .prepare(`INSERT INTO tasks (${TASK_COLUMNS.join(',')}) VALUES (${TASK_COLUMNS.map(() => '?').join(',')})`)
      .bind(...taskBindValues(task))
      .run();
    return task;
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task | null> {
    const cur = (await this.tasks()).find((t) => t.id === id);
    if (!cur) return null;
    const next: Task = { ...cur, ...patch, updatedAt: Date.now() };
    if (patch.status === 'done' && !next.completedAt) {
      next.completedAt = Date.now();
      next.slotsDone = next.slots;
    }
    const setCols = TASK_COLUMNS.filter((c) => c !== 'id');
    await this.db
      .prepare(`UPDATE tasks SET ${setCols.map((c) => `${c}=?`).join(',')} WHERE id=?`)
      .bind(...setCols.map((c) => taskCell(next, c)), id)
      .run();
    return next;
  }
}

// --- row (de)serialization ---------------------------------------------------
type TaskRow = Omit<Task, 'dependsOn'> & { dependsOn: string };
type SprintRow = Omit<Sprint, 'leaveDays'> & { leaveDays: string };

function rowToTask(r: TaskRow): Task {
  return { ...r, dependsOn: JSON.parse(r.dependsOn || '[]') } as Task;
}
function taskCell(t: Task, col: (typeof TASK_COLUMNS)[number]): unknown {
  if (col === 'dependsOn') return JSON.stringify(t.dependsOn);
  return nn(t[col] as unknown as undefined);
}
function taskBindValues(t: Task): unknown[] {
  return TASK_COLUMNS.map((c) => taskCell(t, c));
}
