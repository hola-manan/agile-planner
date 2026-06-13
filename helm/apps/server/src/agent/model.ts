// Model layer. Vertex AI Express keys serve Gemini (Claude-on-Vertex needs
// service-account rawPredict, which Express keys can't do), so the default
// backend is Gemini. `mock` lets the whole app run with no key at all.
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

export type AiBackend = 'gemini' | 'vertex' | 'mock';

export interface ModelConfig {
  backend: AiBackend;
  judgeModel: string;
  fastModel: string;
  apiKey?: string;
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): ModelConfig {
  const apiKey = env.GOOGLE_API_KEY || env.HELM_VERTEX_API_KEY || env.GEMINI_API_KEY;
  const explicit = env.HELM_AI_BACKEND as AiBackend | undefined;
  const backend: AiBackend = explicit ?? (apiKey ? 'gemini' : 'mock');
  return {
    backend,
    judgeModel: env.HELM_MODEL_JUDGE || 'gemini-2.5-pro',
    fastModel: env.HELM_MODEL_FAST || 'gemini-2.5-flash',
    apiKey,
  };
}

/**
 * Returns a LangChain chat model, or null when running in `mock` mode. Kept
 * dynamic-import so the server boots (and the engine API works) even if the
 * Google packages aren't installed yet.
 */
export async function createJudgeModel(cfg: ModelConfig): Promise<BaseChatModel | null> {
  if (cfg.backend === 'mock') return null;
  if (cfg.backend === 'gemini') {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      model: cfg.judgeModel,
      apiKey: cfg.apiKey,
      temperature: 0.2,
    }) as unknown as BaseChatModel;
  }
  // 'vertex' — full Vertex AI auth (service account / ADC). Express API keys may
  // not work here; prefer the `gemini` backend with an Express key.
  const { ChatVertexAI } = await import('@langchain/google-vertexai');
  return new ChatVertexAI({ model: cfg.judgeModel, temperature: 0.2 }) as unknown as BaseChatModel;
}
