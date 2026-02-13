import { z } from 'zod';

// ── LLMClient interface ──────────────────────────────────────

export interface LLMClient {
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ── Config schema ────────────────────────────────────────────

export const llmProviderSchema = z.enum(['anthropic', 'openai', 'mock']);

export type LLMProvider = z.infer<typeof llmProviderSchema>;

export const llmConfigSchema = z.object({
  provider: llmProviderSchema,
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export type LLMConfig = z.infer<typeof llmConfigSchema>;

// ── Env loader ───────────────────────────────────────────────

export function loadLLMConfig(): LLMConfig {
  const provider = process.env['LLM_PROVIDER'] ?? 'anthropic';

  const apiKey = provider === 'anthropic'
    ? process.env['ANTHROPIC_API_KEY']
    : process.env['OPENAI_API_KEY'];

  const model = provider === 'anthropic'
    ? process.env['PROMPTQA_MODEL']
    : process.env['LLM_MODEL'];

  return llmConfigSchema.parse({
    provider,
    apiKey,
    model,
  });
}
