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

// ── Rate-limit-aware fetch ───────────────────────────────────

const MAX_RETRIES = 3;

async function fetchWithRetry(
  url: string,
  init: RequestInit,
): Promise<Response> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const waitMs = retryAfter
        ? parseFloat(retryAfter) * 1000
        : (attempt + 1) * 5000;
      console.error(
        `[llm] Rate limited, waiting ${String(Math.round(waitMs / 1000))}s...`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `OpenAI API error (${String(response.status)}): ${body}`,
      );
    }

    return response;
  }

  throw new Error('OpenAI API: max retries exceeded due to rate limiting');
}

// ── Provider factory ─────────────────────────────────────────

export function createOpenAIClient(
  apiKey: string,
  model?: string,
): LLMClient {
  const resolvedModel = model ?? DEFAULT_MODEL;

  return {
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await fetchWithRetry(COMPLETIONS_URL, {
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

      const raw = await response.text();
      const body: unknown = JSON.parse(raw);
      const parsed = chatResponseSchema.parse(body);

      return parsed.choices[0].message.content;
    },

    async generateWithImage(
      systemPrompt: string,
      userPrompt: string,
      imageBase64: string,
      mimeType: string,
    ): Promise<string> {
      const dataUri = `data:${mimeType};base64,${imageBase64}`;

      const response = await fetchWithRetry(COMPLETIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: dataUri },
                },
                {
                  type: 'text',
                  text: userPrompt,
                },
              ],
            },
          ],
          temperature: 0,
        }),
      });

      const raw = await response.text();
      const body: unknown = JSON.parse(raw);
      const parsed = chatResponseSchema.parse(body);

      return parsed.choices[0].message.content;
    },
  };
}
