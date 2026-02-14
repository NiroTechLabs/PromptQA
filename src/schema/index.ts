/**
 * Schema module — single source of truth for all data shapes.
 * Zod schemas + inferred TypeScript types.
 * Every boundary validates through these schemas.
 */

export * from './step.js';
export * from './capture.js';
export * from './results.js';
export * from './prescan.js';
export * from './config.js';
export * from './jsonOutput.js';
export * from './agentStep.js';
