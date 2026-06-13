// The enrichment agent, as a LangGraph StateGraph. One node today (enrich),
// structured so a `slice`/`review` node can be added without reshaping callers.
import { StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type { Complexity } from '@helm/engine';
import { createJudgeModel, resolveConfig, type ModelConfig } from './model.js';
import {
  ENRICH_SYSTEM,
  enrichUserPrompt,
  type EnrichContext,
  type RawTaskInput,
} from './prompts.js';

export interface Judgement {
  importance: number;
  timeSensitivity: number;
  complexity: Complexity;
  sublistId: string | null;
  rationale: string;
  source: 'gemini' | 'vertex' | 'heuristic';
}

const JudgementSchema = z.object({
  importance: z.number().min(1).max(5).describe('1-5 value toward the list goal'),
  timeSensitivity: z.number().min(1).max(5).describe('1-5, how much delay hurts'),
  complexity: z.enum(['XS', 'S', 'M', 'L', 'XL']),
  sublistId: z.string().nullable(),
  rationale: z.string(),
});

const GraphState = Annotation.Root({
  raw: Annotation<RawTaskInput>(),
  context: Annotation<EnrichContext>(),
  judgement: Annotation<Judgement | null>(),
});

/** Cheap, deterministic fallback used in mock mode or when a model call fails. */
export function heuristicJudge(raw: RawTaskInput, ctx: EnrichContext): Judgement {
  const text = `${raw.title} ${raw.note ?? ''}`.toLowerCase();
  const urgentWords = /(today|asap|urgent|now|deadline|due|tomorrow|overdue)/;
  const bigWords = /(build|design|implement|migrate|refactor|research|write|launch|plan)/;
  const smallWords = /(fix|update|email|call|review|check|reply|tidy|rename)/;

  const importance = raw.importance ?? (bigWords.test(text) ? 4 : smallWords.test(text) ? 2 : 3);
  const timeSensitivity = raw.due ? 4 : urgentWords.test(text) ? 4 : 2;
  const complexity: Complexity = raw.estHours
    ? raw.estHours <= 0.5
      ? 'XS'
      : raw.estHours <= 1
        ? 'S'
        : raw.estHours <= 3
          ? 'M'
          : raw.estHours <= 6
            ? 'L'
            : 'XL'
    : bigWords.test(text)
      ? 'L'
      : smallWords.test(text)
        ? 'S'
        : 'M';

  return {
    importance,
    timeSensitivity,
    complexity,
    sublistId: raw.sublistId ?? ctx.sublists[0]?.id ?? null,
    rationale: 'Heuristic estimate (no model configured).',
    source: 'heuristic',
  };
}

export function buildEnricher(cfg: ModelConfig = resolveConfig()) {
  async function enrichNode(state: typeof GraphState.State): Promise<Partial<typeof GraphState.State>> {
    const { raw, context } = state;
    const model = await createJudgeModel(cfg).catch(() => null);
    if (!model) {
      return { judgement: heuristicJudge(raw, context) };
    }
    try {
      const structured = model.withStructuredOutput(JudgementSchema, { name: 'judge_task' });
      const out = (await structured.invoke([
        new SystemMessage(ENRICH_SYSTEM),
        new HumanMessage(enrichUserPrompt(raw, context)),
      ])) as z.infer<typeof JudgementSchema>;
      return {
        judgement: {
          importance: out.importance,
          timeSensitivity: out.timeSensitivity,
          complexity: out.complexity,
          sublistId: out.sublistId,
          rationale: out.rationale,
          source: cfg.backend === 'vertex' ? 'vertex' : 'gemini',
        },
      };
    } catch {
      return { judgement: heuristicJudge(raw, context) };
    }
  }

  const graph = new StateGraph(GraphState)
    .addNode('enrich', enrichNode)
    .addEdge(START, 'enrich')
    .addEdge('enrich', END)
    .compile();

  return {
    backend: cfg.backend,
    async enrich(raw: RawTaskInput, context: EnrichContext): Promise<Judgement> {
      const res = await graph.invoke({ raw, context });
      return res.judgement ?? heuristicJudge(raw, context);
    },
  };
}

export type Enricher = ReturnType<typeof buildEnricher>;
