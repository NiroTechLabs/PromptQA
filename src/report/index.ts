/**
 * Report generation module.
 * Deterministic — no LLM calls.
 * Transforms evaluated results into markdown + JSON artifacts.
 */

export { generateMarkdown, generateJSON, serializeJSON } from './reporter.js';
export type { JsonOutput, JsonOutputStep, JsonOutputBug } from './reporter.js';
