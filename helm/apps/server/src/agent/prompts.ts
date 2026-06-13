import type { List, Sublist, Task } from '@helm/engine';

export interface RawTaskInput {
  title: string;
  listId: string;
  sublistId?: string | null;
  importance?: number;
  estHours?: number;
  due?: string | null;
  note?: string;
}

export interface EnrichContext {
  list: List;
  sublists: Sublist[];
  /** A few sibling tasks so the model calibrates against existing work. */
  siblings: Pick<Task, 'title' | 'importance' | 'complexity'>[];
  /** Optional pasted HELM.md prose for extra project context. */
  projectDoc?: string;
  today: string;
}

export const ENRICH_SYSTEM = `You are Helm, a chief-of-staff that triages a single user's tasks.
You assign three judgement fields and NOTHING about scheduling (the engine does that).

Rate against the user's stated goal for the life-area ("List"):
- importance (1-5): how much finishing this moves the goal. 5 = directly decisive, 1 = trivial.
- timeSensitivity (1-5): how much a delay hurts. Use the due date if given. 5 = today/overdue.
- complexity: one of XS,S,M,L,XL using an agile sizing intuition:
    XS ~0.5h trivial, S ~1h small, M ~3h a focused session, L ~6h a day, XL ~12h multi-day.
- Pick the best-fitting sublist id from the provided list (or null if none fit).
- rationale: one short sentence explaining the importance call.

Be decisive and calibrated against the sibling tasks. Do not inflate everything to 5.`;

export function enrichUserPrompt(raw: RawTaskInput, ctx: EnrichContext): string {
  const subs = ctx.sublists.map((s) => `  - ${s.id}: ${s.name}`).join('\n') || '  (none)';
  const sibs =
    ctx.siblings
      .slice(0, 8)
      .map((s) => `  - "${s.title}" (importance ${s.importance}, ${s.complexity})`)
      .join('\n') || '  (none yet)';
  return [
    `Today: ${ctx.today}`,
    `Life-area (List): "${ctx.list.name}" — goal: ${ctx.list.goal || '(no goal set)'}`,
    `Available sublists:\n${subs}`,
    `Existing sibling tasks for calibration:\n${sibs}`,
    ctx.projectDoc ? `Project notes:\n${ctx.projectDoc.slice(0, 2000)}` : '',
    '',
    `New task: "${raw.title}"`,
    raw.note ? `User note: ${raw.note}` : '',
    raw.importance ? `User-stated importance: ${raw.importance}` : '',
    raw.due ? `Due: ${raw.due}` : '',
    raw.estHours ? `User estimate: ${raw.estHours}h` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
