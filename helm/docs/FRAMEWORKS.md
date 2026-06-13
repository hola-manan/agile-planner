# The three frameworks Helm runs at once

Helm's whole job is to take the things you *want* or *need* to do and turn them
into a short, ordered, honest list of **what to actually do next** — never a wall
of 200 undifferentiated to-dos. It does this by running three planning
frameworks simultaneously and letting them constrain each other.

You provide the raw intent (a task name, and which part of your life it belongs
to). Helm — partly with deterministic rules, partly with an LLM — fills in
everything else and keeps the plan current.

---

## 1. Eisenhower quadrants — *what deserves attention*

Every task is placed on two axes:

- **Importance** (1–5): how much it moves your *goals* (the goal you set on the
  parent List). This is the LLM's judgement when you don't state it.
- **Time-sensitivity / urgency** (1–5): how much a delay hurts. Driven by an
  explicit due date when present, otherwise inferred.

|                     | Urgent (TS ≥ 3)        | Not urgent (TS < 3)     |
|---------------------|------------------------|-------------------------|
| **Important (I ≥ 3)** | **Q1 — Do**          | **Q2 — Schedule**       |
| **Not important (I < 3)** | **Q3 — Delegate/Minimise** | **Q4 — Drop** |

Quadrant sets the *base* priority and feeds the 3-3-3 slot decision. Helm
actively warns when you live in Q1/Q3 and never touch Q2 (the classic trap).

## 2. The 3-3-3 method — *how a day is shaped*

A working day is a fixed container, not an open field:

- **1 × Deep slot — 3 hours** on the single most important thing.
- **3 × Important slots — 1 hour each** on other things that matter.
- **3 × Maintenance slots — 1 hour each** on upkeep/admin that keeps life running.

That's **9 hours / 7 slots** per working day (all configurable). A task is
assigned a **slot type** based on importance + complexity:

- `deep` — high importance **and** needs sustained focus (complexity ≥ M).
- `important` — matters, but fits in an hour-sized chunk.
- `maintenance` — routine/admin/low-importance upkeep.

Tasks bigger than their slot are **split into slices** (a 6h deep task = two
deep slots across two days). Helm decides the number of slots.

## 3. Agile — *how work is committed and estimated*

- **Lists & Sublists** are the taxonomy. A **List** is a core aspect of your
  life (Career, Health, a specific side-project…) and carries a *goal*. A
  **Sublist** is a phase/part of that aspect. A task's "type" is just which
  sublist it lives under.
- **Complexity** is an agile estimate (`XS S M L XL`) that maps to hours.
  The LLM estimates it when you don't.
- **Sprints** have a **capacity** = working days you actually have × hours/day,
  minus leave. You can take leave mid-sprint and the plan re-solves.
- Tasks are normally **committed to a sprint**, not micromanaged day-by-day —
  *except* a genuinely high-priority arrival, which is allowed to bump the
  lowest-value committed tasks **back to the backlog**.
- **Blockers** are first-class: a blocked task leaves the active plan and
  surfaces as a risk until cleared.

---

## How they compose

```
raw task ──► [AI enrich] ─► importance, urgency, complexity→hours, slot type, #slots
                               │
                               ▼
                    [Quadrant] sets base priority
                               │
                               ▼
            [Agile] commit to sprint within capacity (bump overflow → backlog)
                               │
                               ▼
            [3-3-3] pack each working day: 1 deep + 3 important + 3 maintenance
                               │
                               ▼
                 "Today": the short ordered list of what to do next
```

The plan is **dynamic**: completing a task, adding a task, or reporting a
blocker re-runs the solve so "what's next" is always honest.
