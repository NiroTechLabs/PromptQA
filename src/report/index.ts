/**
 * Report generation module.
 * Deterministic — no LLM calls.
 * Transforms evaluated results into markdown + JSON artifacts.
 */

export { generateMarkdown, generateJSON } from './reporter.js';
export type { SummaryJSON, SummaryStepJSON } from './reporter.js';
