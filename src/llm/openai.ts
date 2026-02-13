import { z } from 'zod';

import type { LLMClient } from './client.js';

// ── Constants ────────────────────────────────────────────────

const DEFAULT_MODEL = 'gpt-4o-mini';
const COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';

// ── Response validation ──────────────────────────────────────

const chatResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string(),
        }),
      }),
    )
    .nonempty(),
});

// ── Provider factory ─────────────────────────────────────────

export function createOpenAIClient(
  apiKey: string,
  model?: string,
): LLMClient {
  const resolvedModel = model ?? DEFAULT_MODEL;

  return {
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await fetch(COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(
          `OpenAI API error (${String(response.status)}): ${body}`,
        );
      }

      const raw = await response.text();
      const body: unknown = JSON.parse(raw);
      const parsed = chatResponseSchema.parse(body);

      return parsed.choices[0].message.content;
    },
  };
}
