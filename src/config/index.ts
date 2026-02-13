/**
 * Configuration module.
 * Loads and validates runtime config from env, CLI flags, and config files.
 * Zod-validated. No defaults leak — everything explicit.
 */

export { TIMEOUTS, LIMITS, TOKEN_GUARDS } from './defaults.js';
export { loadConfigFile } from './loader.js';
