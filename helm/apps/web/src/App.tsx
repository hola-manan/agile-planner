import { useEffect, useMemo, useState } from 'react';
import {
  api, type AppState, type Alert, type DayPlan, type List, type Sprint, type Task,
} from './lib/api';

const SLOT_LABEL = { deep: 'Deep · 3h', important: 'Important · 1h', maintenance: 'Maintenance · 1h' } as const;

function quadrant(t: Task) {
  const imp = t.importance >= 3, urg = t.timeSensitivity >= 3;
  return imp && urg ? 'Q1' : imp ? 'Q2' : urg ? 'Q3' : 'Q4';
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => api.state().then(setState).catch((e) => setErr(String(e)));
  useEffect(() => { refresh(); }, []);

  if (err) return <div className="app"><h1>Helm</h1><p className="alert critical">{err}</p></div>;
  if (!state) return <div className="app"><h1>Helm</h1><p className="dim">Loading…</p></div>;

  const sprint = state.sprints.find((s) => s.status === 'active') ?? state.sprints.at(-1) ?? null;
  const taskById = (id: string) => state.tasks.find((t) => t.id === id);

  async function mutate(p: Promise<unknown>) {
    setBusy(true); setErr(null);
    try { await p; await refresh(); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  return (
    <div className="app">
      <div className="topbar">
        <div>
          <h1>Helm</h1>
          <div className="dim">Your chief of staff — what to actually do next.</div>
        </div>
        <div className="row">
          {busy && <span className="spinner" />}
          <span className="badge">AI: {state.aiBackend}</span>
        </div>
      </div>

      {state.lists.length === 0 ? (
        <FirstRun onSeed={(p) => mutate(p)} />
      ) : (
        <>
          <SprintBar sprint={sprint} plan={state.plan} onSave={(b) => sprint && mutate(api.patchSprint(sprint.id, b))} />
          <AlertsPanel alerts={state.plan.alerts} taskById={taskById} />
          <h2>Today · {state.plan.today.date}</h2>
          <TodayPlan plan={state.plan.today} taskById={taskById} onComplete={(id) => mutate(api.patchTask(id, { status: 'done' }))} />

          <div className="grid2">
            <div>
              <h2>Capture a task</h2>
              <QuickAdd lists={state.lists} sublists={state.sublists} onAdd={(b) => mutate(api.addTask(b))} />
            </div>
            <div>
              <h2>Backlog</h2>
              <Backlog tasks={state.plan.backlog} lists={state.lists}
                onBlock={(id, blocker) => mutate(api.patchTask(id, { status: 'blocked', blocker }))}
                onUnblock={(id) => mutate(api.patchTask(id, { status: 'backlog', blocker: null }))}
                onDone={(id) => mutate(api.patchTask(id, { status: 'done' }))} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SprintBar({ sprint, plan, onSave }: { sprint: Sprint | null; plan: AppState['plan']; onSave: (b: Record<string, unknown>) => void }) {
  const committedH = plan.committed.reduce((s, t) => s + t.estHours, 0);
  const capacityH = sprint ? Math.max(0, (sprint.capacityDays - sprint.leaveDays.length) * 9) : 0;
  const pct = capacityH ? Math.min(100, (committedH / capacityH) * 100) : 0;
  const over = committedH > capacityH;
  if (!sprint) return <div className="panel dim">No sprint yet.</div>;
  return (
    <div className="panel capacity">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Sprint {sprint.number}{sprint.goal ? ` — ${sprint.goal}` : ''}</strong>
        <span className="mono dim">{committedH.toFixed(1)} / {capacityH}h committed</span>
      </div>
      <div className={`bar ${over ? 'over' : ''}`} style={{ marginTop: 8 }}><span style={{ width: `${pct}%` }} /></div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="dim">Working days
          <input type="number" min={0} defaultValue={sprint.capacityDays} style={{ width: 64, marginLeft: 8 }}
            onBlur={(e) => onSave({ capacityDays: Number(e.target.value) })} />
        </label>
        <label className="dim">Leave (comma dates)
          <input defaultValue={sprint.leaveDays.join(',')} placeholder="2026-06-16" style={{ width: 180, marginLeft: 8 }}
            onBlur={(e) => onSave({ leaveDays: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} />
        </label>
      </div>
    </div>
  );
}

function AlertsPanel({ alerts, taskById }: { alerts: Alert[]; taskById: (id: string) => Task | undefined }) {
  if (!alerts.length) return null;
  return (
    <div className="alerts" style={{ marginTop: 14 }}>
      {alerts.map((a, i) => (
        <div key={i} className={`alert ${a.severity}`}>
          <span className="tag">{a.kind.replace(/_/g, ' ')}</span>
          <div>{a.message}
            {a.taskIds.length > 0 && (
              <div className="faint mono" style={{ fontSize: 11, marginTop: 2 }}>
                {a.taskIds.map((id) => taskById(id)?.title ?? id).slice(0, 4).join(' · ')}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function TodayPlan({ plan, taskById, onComplete }: { plan: DayPlan; taskById: (id: string) => Task | undefined; onComplete: (id: string) => void }) {
  const bands = ['deep', 'important', 'maintenance'] as const;
  const empty = plan.slots.length === 0;
  return (
    <div className="slots">
      {empty && <div className="empty">Nothing scheduled. Add tasks or commit a sprint — Helm will fill your 3-3-3 day.</div>}
      {bands.map((band) => {
        const slots = plan.slots.filter((s) => s.type === band);
        const unfilled = plan.unfilled.filter((u) => u.type === band).length;
        if (!slots.length && !unfilled) return null;
        return (
          <div key={band} className={`band ${band}`}>
            <h3>{SLOT_LABEL[band].split(' · ')[0]} <span className="hrs">{SLOT_LABEL[band].split(' · ')[1]}</span></h3>
            {slots.map((s, i) => {
              const t = taskById(s.taskId);
              return (
                <div className="slot" key={i}>
                  <div className="title">{s.taskTitle}{s.slicePosition && <span className="meta"> · slice {s.slicePosition}</span>}
                    {t && <span className={`qchip ${quadrant(t).toLowerCase()}`} style={{ marginLeft: 8 }}>{quadrant(t)}</span>}
                  </div>
                  <span className="meta">{s.hours}h</span>
                  <button className="tiny" onClick={() => onComplete(s.taskId)}>Done</button>
                </div>
              );
            })}
            {Array.from({ length: unfilled }).map((_, i) => <div className="empty" key={`u${i}`}>open slot</div>)}
          </div>
        );
      })}
    </div>
  );
}

function QuickAdd({ lists, sublists, onAdd }: { lists: List[]; sublists: AppState['sublists']; onAdd: (b: Record<string, unknown>) => void }) {
  const [title, setTitle] = useState('');
  const [listId, setListId] = useState(lists[0]?.id ?? '');
  const [sublistId, setSublistId] = useState('');
  const [importance, setImportance] = useState('');
  const [due, setDue] = useState('');
  const subs = useMemo(() => sublists.filter((s) => s.listId === listId), [sublists, listId]);

  function submit() {
    if (!title.trim() || !listId) return;
    onAdd({
      title: title.trim(), listId,
      sublistId: sublistId || null,
      importance: importance ? Number(importance) : undefined,
      due: due || undefined,
    });
    setTitle(''); setImportance(''); setDue('');
  }
  return (
    <div className="panel">
      <input placeholder="What needs doing?" value={title} style={{ width: '100%' }}
        onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      <div className="row" style={{ marginTop: 8 }}>
        <select value={listId} onChange={(e) => { setListId(e.target.value); setSublistId(''); }}>
          {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select value={sublistId} onChange={(e) => setSublistId(e.target.value)}>
          <option value="">(sublist — AI picks)</option>
          {subs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={importance} onChange={(e) => setImportance(e.target.value)}>
          <option value="">importance: AI</option>
          {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>importance {n}</option>)}
        </select>
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button className="primary" onClick={submit}>Add</button>
      </div>
      <div className="faint" style={{ marginTop: 8, fontSize: 12 }}>
        Leave importance/sublist blank and the agent fills them, sizes complexity, and slots it for you.
      </div>
    </div>
  );
}

function Backlog({ tasks, lists, onBlock, onUnblock, onDone }: {
  tasks: Task[]; lists: List[];
  onBlock: (id: string, blocker: string) => void; onUnblock: (id: string) => void; onDone: (id: string) => void;
}) {
  const listName = (id: string) => lists.find((l) => l.id === id)?.name ?? '';
  if (!tasks.length) return <div className="panel dim">Backlog clear. 🎯</div>;
  return (
    <div className="tasklist">
      {tasks.map((t) => (
        <div key={t.id} className={`taskrow ${t.status === 'blocked' ? 'blocked' : ''}`}>
          <span className={`qchip ${quadrant(t).toLowerCase()}`}>{quadrant(t)}</span>
          <div className="title">
            {t.title}
            <span className="meta mono faint"> · {listName(t.listId)} · {t.complexity} · {t.slotType}</span>
            {t.blocker && <div className="faint" style={{ fontSize: 12 }}>⛔ {t.blocker}</div>}
            {t.rationale && <div className="faint" style={{ fontSize: 11 }}>{t.rationale}</div>}
          </div>
          {t.status === 'blocked'
            ? <button className="tiny ghost" onClick={() => onUnblock(t.id)}>Unblock</button>
            : <button className="tiny ghost" onClick={() => { const b = prompt('Blocker?'); if (b) onBlock(t.id, b); }}>Block</button>}
          <button className="tiny" onClick={() => onDone(t.id)}>Done</button>
        </div>
      ))}
    </div>
  );
}

function FirstRun({ onSeed }: { onSeed: (p: Promise<unknown>) => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  async function seed() {
    const list = await api.createList({ name: name || 'My work', goal, kind: 'general' });
    const today = new Date();
    const end = new Date(today.getTime() + 13 * 86400000);
    await api.createSprint({
      startDate: today.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10),
      status: 'active', capacityDays: 10, goal: 'First sprint',
    });
    return list;
  }
  return (
    <div className="panel" style={{ marginTop: 20 }}>
      <h2 style={{ marginTop: 0 }}>Set up your first life-area</h2>
      <p className="dim">A "List" is a core aspect of your life. Its goal is the yardstick the AI judges every task against.</p>
      <div className="row">
        <input placeholder="e.g. Career, Health, Side Project" value={name} onChange={(e) => setName(e.target.value)} />
        <input placeholder="Goal for this area" value={goal} style={{ flex: 1 }} onChange={(e) => setGoal(e.target.value)} />
        <button className="primary" onClick={() => onSeed(seed())}>Create + start a sprint</button>
      </div>
    </div>
  );
}
