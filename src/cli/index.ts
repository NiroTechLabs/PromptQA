/**
 * CLI module — thin wrapper over core.
 * Parses arguments, delegates to core, handles exit codes.
 * No business logic lives here.
 */

export { registerTestCommand, registerRunCommand } from './run.js';
