/**
 * Browser execution module.
 * Deterministic Playwright runner — no LLM calls.
 * Receives structured steps, executes them, captures artifacts.
 */

export { resolveSelector, describeSelector, SelectorError } from './selectors.js';
export { launchSession } from './runner.js';
export type { RunnerConfig, BrowserSession } from './runner.js';
export { attachCapture } from './capture.js';
export type { CaptureCollector } from './capture.js';
export { prescanPage } from './prescan.js';
