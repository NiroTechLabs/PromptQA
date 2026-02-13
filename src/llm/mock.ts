import type { LLMClient } from './client.js';

const DEFAULT_RESPONSE = '{"result":"mock"}';

/**
 * Mock LLM provider for testing.
 * Cycles through provided canned responses, falling back to a default.
 */
export function createMockClient(
  responses?: readonly string[],
): LLMClient {
  let callIndex = 0;

  return {
    async generate(
      _systemPrompt: string,
      _userPrompt: string,
    ): Promise<string> {
      const response = responses?.[callIndex] ?? DEFAULT_RESPONSE;
      callIndex++;
      return response;
    },
  };
}
