/**
 * Default configuration values.
 * All values are overridable via config file.
 */

export const TIMEOUTS = {
  NAVIGATION_TIMEOUT: 15_000,
  ACTION_TIMEOUT: 8_000,
  TOTAL_RUN_TIMEOUT: 180_000,
  RETRY_WAIT: 2_000,
} as const;

export const LIMITS = {
  MAX_STEPS: 12,
  MAX_STEP_RETRIES: 1,
  MAX_LLM_RETRIES: 1,
} as const;

export const TOKEN_GUARDS = {
  MAX_CONSOLE_ERRORS: 20,
  MAX_NETWORK_ERRORS: 10,
  MAX_VISIBLE_TEXT_CHARS: 8_000,
} as const;
