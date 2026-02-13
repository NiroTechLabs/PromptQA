/**
 * LLM abstraction module.
 * Provider-agnostic interface for planner and evaluator.
 * Only module allowed to make LLM API calls.
 */

import type { LLMClient, LLMConfig } from './client.js';
import { createAnthropicClient } from './anthropic.js';
import { createOpenAIClient } from './openai.js';
import { createMockClient } from './mock.js';

export * from './client.js';
export { createAnthropicClient } from './anthropic.js';
export { createOpenAIClient } from './openai.js';
export { createMockClient } from './mock.js';

// ── Provider factory ─────────────────────────────────────────

export function createLLMClient(config: LLMConfig): LLMClient {
  switch (config.provider) {
    case 'anthropic': {
      if (!config.apiKey) {
        throw new Error(
          'ANTHROPIC_API_KEY is required when using the anthropic provider',
        );
      }
      return createAnthropicClient(config.apiKey, config.model);
    }
    case 'openai': {
      if (!config.apiKey) {
        throw new Error(
          'OPENAI_API_KEY is required when using the openai provider',
        );
      }
      return createOpenAIClient(config.apiKey, config.model);
    }
    case 'mock':
      return createMockClient();
  }
}
