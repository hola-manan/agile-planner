import type Database from 'better-sqlite3';
import {
  deriveFields,
  solve,
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

export class Store {
  private enricher: Enricher;
  constructor(private db: Database.Database, enricher?: Enricher) {
    this.enricher = enricher ?? buildEnricher();
  }

  // --- reads ----------------------------------------------------------------
  lists(): List[] {
    return this.db.prepare('SELECT * FROM lists ORDER BY createdAt').all() as List[];
  }
  sublists(listId?: string): Sublist[] {
    return listId
      ? (this.db.prepare('SELECT * FROM sublists WHERE listId = ? ORDER BY createdAt').all(listId) as Sublist[])
      : (this.db.prepare('SELECT * FROM sublists ORDER BY createdAt').all() as Sublist[]);
  }
  tasks(): Task[] {
    return (this.db.prepare('SELECT * FROM tasks').all() as RawRow[]).map(rowToTask);
  }
  sprints(): Sprint[] {
    return (this.db.prepare('SELECT * FROM sprints ORDER BY number').all() as any[]).map((s) => ({
      ...s,
      leaveDays: JSON.parse(s.leaveDays || '[]'),
    })) as Sprint[];
  }
  activeSprint(): Sprint | null {
    return this.sprints().find((s) => s.status === 'active') ?? null;
  }

  // --- the money method: persist nothing, just compute the live plan --------
  solveState(today = todayISO()): SolveResult {
    return solve({ tasks: this.tasks(), sprint: this.activeSprint(), today });
  }

  // --- lists / sublists -----------------------------------------------------
  createList(input: Partial<List> & { name: string }): List {
    const list: List = {
      id: uid('list'),
      name: input.name,
      goal: input.goal ?? '',
      kind: input.kind ?? 'general',
      color: input.color,
      repoUrl: input.repoUrl,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        'INSERT INTO lists (id,name,goal,kind,color,repoUrl,createdAt) VALUES (@id,@name,@goal,@kind,@color,@repoUrl,@createdAt)',
      )
      .run(list);
    return list;
  }
  createSublist(listId: string, name: string): Sublist {
    const s: Sublist = { id: uid('sub'), listId, name, createdAt: Date.now() };
    this.db.prepare('INSERT INTO sublists (id,listId,name,createdAt) VALUES (@id,@listId,@name,@createdAt)').run(s);
    return s;
  }

  // --- sprints --------------------------------------------------------------
  createSprint(input: Partial<Sprint> & { startDate: string; endDate: string }): Sprint {
    const number = (this.sprints().at(-1)?.number ?? 0) + 1;
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
    this.db
      .prepare(
        'INSERT INTO sprints (id,number,name,startDate,endDate,status,capacityDays,leaveDays,goal,createdAt) VALUES (@id,@number,@name,@startDate,@endDate,@status,@capacityDays,@leaveDays,@goal,@createdAt)',
      )
      .run({ ...s, leaveDays: JSON.stringify(s.leaveDays) });
    return s;
  }
  updateSprint(id: string, patch: Partial<Sprint>): Sprint | null {
    const cur = this.sprints().find((s) => s.id === id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db
      .prepare('UPDATE sprints SET name=@name,startDate=@startDate,endDate=@endDate,status=@status,capacityDays=@capacityDays,leaveDays=@leaveDays,goal=@goal WHERE id=@id')
      .run({ ...next, leaveDays: JSON.stringify(next.leaveDays) });
    return next;
  }

  // --- tasks ----------------------------------------------------------------
  /** Add a task; the agent fills any judgement fields the user omitted. */
  async addTask(raw: RawTaskInput, today = todayISO()): Promise<Task> {
    const list = this.lists().find((l) => l.id === raw.listId);
    if (!list) throw new Error('unknown list');
    const needsAi = raw.importance == null || raw.estHours == null;
    let importance = raw.importance;
    let timeSensitivity: number | undefined;
    let complexity: any;
    let estHours = raw.estHours;
    let sublistId = raw.sublistId ?? null;
    let rationale: string | undefined;

    if (needsAi) {
      const j = await this.enricher.enrich(raw, {
        list,
        sublists: this.sublists(list.id),
        siblings: this.tasks()
          .filter((t) => t.listId === list.id)
          .map((t) => ({ title: t.title, importance: t.importance, complexity: t.complexity })),
        today,
      });
      importance = importance ?? j.importance;
      timeSensitivity = j.timeSensitivity;
      complexity = j.complexity;
      estHours = estHours ?? undefined;
      sublistId = sublistId ?? j.sublistId;
      rationale = j.rationale;
    }

    const derived = deriveFields(
      {
        importance: importance ?? 3,
        timeSensitivity,
        complexity: complexity ?? 'M',
        estHours,
        due: raw.due ?? null,
        rationale,
      },
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
    this.insertTask(task);
    return task;
  }

  updateTask(id: string, patch: Partial<Task>): Task | null {
    const cur = this.tasks().find((t) => t.id === id);
    if (!cur) return null;
    const next: Task = { ...cur, ...patch, updatedAt: Date.now() };
    if (patch.status === 'done' && !next.completedAt) {
      next.completedAt = Date.now();
      next.slotsDone = next.slots;
    }
    this.db
      .prepare(
        `UPDATE tasks SET listId=@listId,sublistId=@sublistId,title=@title,importance=@importance,
         timeSensitivity=@timeSensitivity,complexity=@complexity,estHours=@estHours,due=@due,
         slotType=@slotType,slots=@slots,slotsDone=@slotsDone,status=@status,blocker=@blocker,
         sprintId=@sprintId,dependsOn=@dependsOn,rationale=@rationale,updatedAt=@updatedAt,completedAt=@completedAt
         WHERE id=@id`,
      )
      .run(taskToRow(next));
    return next;
  }

  private insertTask(t: Task) {
    this.db
      .prepare(
        `INSERT INTO tasks (id,listId,sublistId,title,importance,timeSensitivity,complexity,estHours,due,
         slotType,slots,slotsDone,status,blocker,sprintId,dependsOn,rationale,createdAt,updatedAt,completedAt)
         VALUES (@id,@listId,@sublistId,@title,@importance,@timeSensitivity,@complexity,@estHours,@due,
         @slotType,@slots,@slotsDone,@status,@blocker,@sprintId,@dependsOn,@rationale,@createdAt,@updatedAt,@completedAt)`,
      )
      .run(taskToRow(t));
  }
}

type RawRow = Omit<Task, 'dependsOn'> & { dependsOn: string };
function rowToTask(r: RawRow): Task {
  return { ...r, dependsOn: JSON.parse((r.dependsOn as unknown as string) || '[]') };
}
function taskToRow(t: Task): Record<string, unknown> {
  return { ...t, dependsOn: JSON.stringify(t.dependsOn) };
}
