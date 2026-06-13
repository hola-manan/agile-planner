import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { openDb } from './db.js';
import { Store } from './store.js';
import { resolveConfig } from './agent/model.js';

const db = openDb();
const store = new Store(db);
const app = new Hono();
app.use('/api/*', cors());

const cfg = resolveConfig();
const today = () => new Date().toISOString().slice(0, 10);

app.get('/api/health', (c) => c.json({ ok: true, aiBackend: cfg.backend, model: cfg.judgeModel }));

/** One endpoint returns everything the UI needs, including the freshly solved plan. */
app.get('/api/state', (c) =>
  c.json({
    lists: store.lists(),
    sublists: store.sublists(),
    sprints: store.sprints(),
    tasks: store.tasks(),
    plan: store.solveState(today()),
    aiBackend: cfg.backend,
  }),
);

app.post('/api/lists', async (c) => c.json(store.createList(await c.req.json())));
app.post('/api/lists/:id/sublists', async (c) => {
  const { name } = await c.req.json();
  return c.json(store.createSublist(c.req.param('id'), name));
});

app.post('/api/sprints', async (c) => c.json(store.createSprint(await c.req.json())));
app.patch('/api/sprints/:id', async (c) => {
  const updated = store.updateSprint(c.req.param('id'), await c.req.json());
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ sprint: updated, plan: store.solveState(today()) });
});

// Add a task — the agent enriches missing fields, then we return the new plan.
app.post('/api/tasks', async (c) => {
  const raw = await c.req.json();
  const task = await store.addTask(raw, today());
  return c.json({ task, plan: store.solveState(today()) });
});

// Mutate a task (complete, block, move, edit) and re-solve.
app.patch('/api/tasks/:id', async (c) => {
  const updated = store.updateTask(c.req.param('id'), await c.req.json());
  if (!updated) return c.json({ error: 'not found' }, 404);
  return c.json({ task: updated, plan: store.solveState(today()) });
});

const port = Number(process.env.PORT || 8787);
serve({ fetch: app.fetch, port });
console.log(`helm server on :${port} (AI backend: ${cfg.backend}, model: ${cfg.judgeModel})`);
