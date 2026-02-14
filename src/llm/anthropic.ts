import Anthropic from '@anthropic-ai/sdk';

import type { LLMClient } from './client.js';

// ── Constants ────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 4096;
const MAX_RETRIES = 3;

// ── Rate-limit-aware wrapper ────────────────────────────────

function isRateLimitError(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Error && err.message.includes('429')) return true;
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt === MAX_RETRIES - 1) throw err;

      const waitMs = (attempt + 1) * 5000;
      console.error(
        `[llm] Rate limited, waiting ${String(Math.round(waitMs / 1000))}s...`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }

  throw new Error('Anthropic API: max retries exceeded due to rate limiting');
}

// ── Provider factory ─────────────────────────────────────────

export function createAnthropicClient(
  apiKey: string,
  model?: string,
): LLMClient {
  const resolvedModel = model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });

  return {
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await withRetry(() =>
        client.messages.create({
          model: resolvedModel,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
          temperature: 0,
        }),
      );

      const firstBlock = response.content[0];
      if (!firstBlock || firstBlock.type !== 'text') {
        throw new Error('Anthropic API returned no text content');
      }

      return firstBlock.text;
    },

    async generateWithImage(
      systemPrompt: string,
      userPrompt: string,
      imageBase64: string,
      mimeType: string,
    ): Promise<string> {
      const response = await withRetry(() =>
        client.messages.create({
          model: resolvedModel,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: mimeType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
                    data: imageBase64,
                  },
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
      );

      const firstBlock = response.content[0];
      if (!firstBlock || firstBlock.type !== 'text') {
        throw new Error('Anthropic API returned no text content');
      }

      return firstBlock.text;
    },
  };
}
