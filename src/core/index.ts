/**
 * Core orchestration module.
 * Coordinates planner → runner → evaluator → reporter pipeline.
 * Pure logic — no IO, no CLI, no browser APIs.
 */

export { planSteps, PlannerError } from './planner.js';
export type { PlannerInput } from './planner.js';
export { evaluateStep, detectHardFail } from './evaluator.js';
export type { EvaluatorInput } from './evaluator.js';
export { runAgentLoop } from './agentLoop.js';
export type { AgentLoopConfig, AgentLoopResult } from './agentLoop.js';
