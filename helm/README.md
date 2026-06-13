# Helm

An AI **chief of staff** for one person. You enter tasks (no Slack/email/calendar
connectors — everything is manual or lives in a project markdown file you keep),
and Helm turns them into a short, ordered, always-current list of **what to do
next**.

It runs three planning frameworks at once:

- **Eisenhower quadrants** — importance × time-sensitivity.
- **3-3-3** — one 3-hour deep block, three 1-hour important slots, three 1-hour
  maintenance slots per working day.
- **Agile** — lists/sublists, complexity estimates, sprints with capacity &
  leave, backlog, and blockers that reshuffle the plan.

The **deterministic engine** does the scheduling math; **Gemini** (via Vertex AI
Express keys, through LangGraph/LangChain) supplies the judgement you didn't:
how important a task is, how complex, which sublist it belongs to, and how to
slice it across slots. See [`docs/FRAMEWORKS.md`](docs/FRAMEWORKS.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Layout

```
packages/engine   Pure, tested planning core (no IO, no AI).
apps/server       Node + Hono API, SQLite, LangGraph enrichment agent.
apps/web          Vite + React "Today / Chief of Staff" UI.
docs/             Framework notes, architecture, project-md template.
```

## Run it

```bash
npm install
npm run build --workspace @helm/engine     # engine types for the server/web

# Terminal 1 — API (mock AI mode needs no key):
npm run dev:server

# Terminal 2 — UI:
npm run dev:web        # http://localhost:5173
```

To use real AI, copy `apps/server/.env.example` → `apps/server/.env` and paste a
**Vertex AI Express key** into `GOOGLE_API_KEY` (Express keys serve Gemini; that's
why the model is Gemini and not Claude). With no key, Helm runs in `mock` mode
using a heuristic so you can try the whole flow offline.

## Tests

```bash
npm test    # engine unit tests (quadrants, 3-3-3 packing, capacity, blockers)
```

## Status

P1 foundation: engine + tests, server API + LangGraph agent skeleton, web shell.
Roadmap (Gemini structured output end-to-end, HELM.md sync, routines/briefings,
history-based estimates) is in `docs/ARCHITECTURE.md`.
