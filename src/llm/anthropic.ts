import Anthropic from '@anthropic-ai/sdk';

import type { LLMClient } from './client.js';

// ── Constants ────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const MAX_TOKENS = 4096;

// ── Provider factory ─────────────────────────────────────────

export function createAnthropicClient(
  apiKey: string,
  model?: string,
): LLMClient {
  const resolvedModel = model ?? DEFAULT_MODEL;
  const client = new Anthropic({ apiKey });

  return {
    async generate(systemPrompt: string, userPrompt: string): Promise<string> {
      const response = await client.messages.create({
        model: resolvedModel,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        temperature: 0,
      });

      const firstBlock = response.content[0];
      if (!firstBlock || firstBlock.type !== 'text') {
        throw new Error('Anthropic API returned no text content');
      }

      return firstBlock.text;
    },
  };
}
