import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { D1Database } from '@cloudflare/workers-types';
import { Store } from './store.js';
import { buildEnricher } from './agent/graph.js';
import { resolveConfig, type EnvMap } from './agent/model.js';

export type Bindings = {
  DB: D1Database;
  GOOGLE_API_KEY?: string;
  HELM_VERTEX_API_KEY?: string;
  GEMINI_API_KEY?: string;
  HELM_AI_BACKEND?: string;
  HELM_MODEL_JUDGE?: string;
  HELM_MODEL_FAST?: string;
};
type Variables = { store: Store };

const today = () => new Date().toISOString().slice(0, 10);

export function createApp() {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  app.use('/api/*', cors());

  // Build a per-request store from the Worker's bindings (DB + AI config).
  app.use('/api/*', async (c, next) => {
    const cfg = resolveConfig(c.env as unknown as EnvMap);
    c.set('store', new Store(c.env.DB, buildEnricher(cfg)));
    await next();
  });

  app.get('/api/health', (c) => {
    const cfg = resolveConfig(c.env as unknown as EnvMap);
    return c.json({ ok: true, aiBackend: cfg.backend, model: cfg.judgeModel });
  });

  app.get('/api/state', async (c) => {
    const store = c.get('store');
    const cfg = resolveConfig(c.env as unknown as EnvMap);
    const [lists, sublists, sprints, tasks, plan] = await Promise.all([
      store.lists(), store.sublists(), store.sprints(), store.tasks(), store.solveState(today()),
    ]);
    return c.json({ lists, sublists, sprints, tasks, plan, aiBackend: cfg.backend });
  });

  app.post('/api/lists', async (c) => c.json(await c.get('store').createList(await c.req.json())));
  app.post('/api/lists/:id/sublists', async (c) => {
    const { name } = await c.req.json();
    return c.json(await c.get('store').createSublist(c.req.param('id'), name));
  });

  app.post('/api/sprints', async (c) => c.json(await c.get('store').createSprint(await c.req.json())));
  app.patch('/api/sprints/:id', async (c) => {
    const store = c.get('store');
    const sprint = await store.updateSprint(c.req.param('id'), await c.req.json());
    if (!sprint) return c.json({ error: 'not found' }, 404);
    return c.json({ sprint, plan: await store.solveState(today()) });
  });

  // Add a task — agent enriches missing fields, then return the new plan.
  app.post('/api/tasks', async (c) => {
    const store = c.get('store');
    const task = await store.addTask(await c.req.json(), today());
    return c.json({ task, plan: await store.solveState(today()) });
  });

  // Mutate a task (complete, block, edit) and re-solve.
  app.patch('/api/tasks/:id', async (c) => {
    const store = c.get('store');
    const task = await store.updateTask(c.req.param('id'), await c.req.json());
    if (!task) return c.json({ error: 'not found' }, 404);
    return c.json({ task, plan: await store.solveState(today()) });
  });

  return app;
}
