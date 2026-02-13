import { z } from 'zod';

// ── LLMClient interface ──────────────────────────────────────

export interface LLMClient {
  generate(systemPrompt: string, userPrompt: string): Promise<string>;
}

// ── Config schema ────────────────────────────────────────────

export const llmProviderSchema = z.enum(['openai', 'mock']);

export type LLMProvider = z.infer<typeof llmProviderSchema>;

export const llmConfigSchema = z.object({
  provider: llmProviderSchema,
  apiKey: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});

export type LLMConfig = z.infer<typeof llmConfigSchema>;

// ── Env loader ───────────────────────────────────────────────

export function loadLLMConfig(): LLMConfig {
  return llmConfigSchema.parse({
    provider: process.env['LLM_PROVIDER'] ?? 'openai',
    apiKey: process.env['OPENAI_API_KEY'],
    model: process.env['LLM_MODEL'],
  });
}
