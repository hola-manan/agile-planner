<!--
  HELM PROJECT FILE
  Keep this file at the root of a code project's git repo as `HELM.md`.
  You and Helm co-maintain it:
    - Prose sections (Vision, Decisions, Notes) are yours — edit freely.
    - The fenced `helm:backlog` YAML block is kept in sync by the tool. You may
      edit it by hand; Helm reconciles by `id` on next sync.
  Only needed for code-related Lists. Most life areas don't need a file.
-->

# <Project name>

## Meta
```yaml
list: <core life aspect this project belongs to, e.g. "Side Project: Helm">
sublist: <current phase, e.g. "MVP">
repo: <git remote url>
status: active        # active | paused | done
goal: <one sentence: the outcome that defines "done">
hours_per_week: <how much capacity you give this, optional>
```

## Vision / why
<Why this exists and what success looks like. Prose.>

## Current focus
<What this sprint is actually about. 1–3 sentences.>

## Architecture & key decisions
<ADR-style bullets. The LLM reads this to estimate complexity and spot risk.>
- <decision> — <why>

## Backlog
<!-- Managed by Helm. id is stable; importance 1-5; complexity XS|S|M|L|XL.
     Leave a field blank and Helm's AI fills it in on sync. -->
```helm:backlog
- id: T-001
  title: <task>
  sublist: <phase>
  type: feature        # feature | bug | chore | spike
  importance:          # 1-5 vs the goal — blank = AI infers
  complexity:          # XS|S|M|L|XL — blank = AI infers
  est_hours:           # number — blank = derived from complexity
  due:                 # YYYY-MM-DD — optional
  slot_type:           # deep | important | maintenance — derived
  slots:               # derived
  status: backlog      # backlog | todo | scheduled | in_progress | blocked | done
  blocker:             # text if blocked
  sprint:              # sprint id once committed
  depends_on: []       # ids that must finish first
```

## Blockers & risks
<Anything stuck or threatening the goal. Helm escalates these.>

## Changelog
<!-- Dated, newest first. Helm appends on completion; add context yourself. -->
- <YYYY-MM-DD> — <what changed>
