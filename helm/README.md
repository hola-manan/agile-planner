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

## Run it locally

Helm runs as a single **Cloudflare Worker** (Hono API + React SPA + D1 database).
Local dev uses Wrangler's local D1 — no Cloudflare account needed:

```bash
npm install
npm run db:migrate:local          # create + migrate local D1
npm run cf:dev                    # builds engine, runs Worker at http://localhost:8787
```

That serves the UI and `/api` together. With no key it runs in `mock` mode
(heuristic enrichment) so you can try the whole flow offline.

## Deploy free on Cloudflare

```bash
wrangler login
npm run db:create                 # paste the printed database_id into wrangler.toml
npm run db:migrate                # apply schema to remote D1
npm run deploy                    # builds engine + web, deploys the Worker
```

Add real AI with a **Vertex AI Express key** (Express keys serve Gemini — that's
why the model is Gemini, not Claude):

```bash
wrangler secret put GOOGLE_API_KEY
```

The app is then live at `https://helm.<your-subdomain>.workers.dev`, reachable
from any device. **Auth:** until you attach a custom domain, that URL is the only
thing gating access — treat it as private. Add free **Cloudflare Access**
(Zero Trust → Access, Google login) once a custom domain is on the zone.

## Tests

```bash
npm test    # engine unit tests (quadrants, 3-3-3 packing, capacity, blockers)
```

## Status

P1 foundation: engine + tests, server API + LangGraph agent skeleton, web shell.
Roadmap (Gemini structured output end-to-end, HELM.md sync, routines/briefings,
history-based estimates) is in `docs/ARCHITECTURE.md`.
