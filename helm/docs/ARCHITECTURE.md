# Helm — architecture

Helm is a single-user "chief of staff". **No external connectors** (no Slack,
email, calendar, etc.) — every input is entered by you or lives in a project
markdown file you maintain. The intelligence reasons over *your own data*.

## Shape

A small TypeScript monorepo (npm workspaces):

```
packages/engine   Pure, deterministic planning core. No IO, no AI, fully unit-tested.
apps/server       Node + Hono REST API, SQLite persistence, LangGraph/LangChain agent.
apps/web          Vite + React + Tailwind. "Today / Chief of Staff" first UI.
```

### Why this split

The **hard math is deterministic and the fuzzy judgement is the LLM's** — never
the other way around. The engine packs 3-3-3 slots, enforces sprint capacity,
computes quadrants and re-solves the plan: this must be predictable and
testable, so it is pure functions with zero dependencies. The LLM only supplies
*judgement* the user didn't: importance, urgency, complexity, how to slice work,
which sublist fits, and the proactive risk narrative.

## The agent (LangGraph + LangChain)

`apps/server/src/agent` defines a `StateGraph`:

1. **enrich** — given a raw task + context (the List's goal, sibling tasks,
   the project `.md`), produce structured fields: `importance`, `timeSensitivity`,
   `complexity`, `estHours`, suggested `sublistId`, and a one-line rationale.
   Uses Gemini structured output.
2. **slice** — decide `slotType` and split into `slots` slices respecting the
   3-3-3 slot sizes.
3. **review** (portfolio-level) — read the whole solved plan and emit proactive
   **alerts**: Q2 neglect, aging tasks, sprint over capacity, unresolved
   blockers, deadline risk.

Deterministic quadrant/priority/packing is done by `packages/engine`, *not* the
LLM — the agent calls the engine, never re-implements it.

### Model layer — Vertex AI Express → Gemini

Vertex AI **Express mode** keys authenticate with an API key and serve **Gemini**
models only (`gemini-2.5-pro`, `gemini-2.5-flash`, …). Anthropic Claude on Vertex
needs `rawPredict`, which requires service-account auth and rejects API keys — so
with Express keys the model is Gemini. `agent/model.ts` wraps this behind a
`createModel()` factory with three backends:

- `gemini` (default) — `ChatGoogleGenerativeAI` via the Express/GenAI API key.
- `vertex` — `ChatVertexAI` for full Vertex auth (swap-in later).
- `mock` — deterministic heuristic enrichment, **no key required**, so the whole
  app runs and is testable offline. Selected automatically when no key is set.

Config via env: `HELM_AI_BACKEND`, `GOOGLE_API_KEY` / `HELM_VERTEX_API_KEY`,
`HELM_MODEL_JUDGE` (default `gemini-2.5-pro`), `HELM_MODEL_FAST`
(default `gemini-2.5-flash`).

## Persistence

SQLite (`better-sqlite3`) — one file, single user. Tables mirror the engine
types: `lists`, `sublists`, `tasks`, `sprints`, plus `alerts` and a LangGraph
checkpoint store. Project `.md` files live in *your* project repos; Helm reads a
pasted copy (or a raw URL) and keeps the machine-readable backlog block in sync.

## Data flow on every mutation

```
client mutates (add/complete/block task, edit capacity, take leave)
        │
        ▼
server persists ──► engine.solve(state) ──► new plan + alerts ──► returned to client
        │                                                         │
        └── if task is missing fields: agent.enrich() first ──────┘
```

`engine.solve` is cheap and pure, so it runs on *every* change — that is what
makes "Today" always current.

## Roadmap

- **P1 (this commit):** engine + tests, docs, project template, server API +
  agent skeleton, web Today/Inbox/Sprint shell.
- **P2:** wire Gemini structured output end-to-end; project `.md` sync.
- **P3:** historical time-tracking → better estimates; routines/briefings;
  leave calendar UI; bump-to-backlog animations.
