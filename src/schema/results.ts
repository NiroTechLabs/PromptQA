import { z } from 'zod';

import { stepSchema } from './step.js';
import { stepCaptureSchema } from './capture.js';

// ── EvaluationResult ──────────────────────────────────────────

export const evaluationVerdictSchema = z.enum(['PASS', 'FAIL', 'UNCERTAIN']);

export type EvaluationVerdict = z.infer<typeof evaluationVerdictSchema>;

export const evaluationResultSchema = z.object({
  result: evaluationVerdictSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;

// ── StepExecutionResult ───────────────────────────────────────

export const stepExecutionResultSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  step: stepSchema,
  success: z.boolean(),
  url: z.string().url(),
  screenshotPath: z.string().min(1),
  visibleText: z.string(),
  capture: stepCaptureSchema,
  evaluation: evaluationResultSchema.optional(),
});

export type StepExecutionResult = z.infer<typeof stepExecutionResultSchema>;

// ── BugReport ─────────────────────────────────────────────────

export const bugSeveritySchema = z.enum(['critical', 'major', 'minor']);

export type BugSeverity = z.infer<typeof bugSeveritySchema>;

export const bugReportSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  description: z.string().min(1),
  severity: bugSeveritySchema,
  evidence: z.array(z.string()),
});

export type BugReport = z.infer<typeof bugReportSchema>;

// ── RunSummary ────────────────────────────────────────────────

export const runSummarySchema = z.object({
  runId: z.string().min(1),
  url: z.string().url(),
  prompt: z.string().min(1),
  summary: evaluationVerdictSchema,
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  steps: z.array(stepExecutionResultSchema),
  bugs: z.array(bugReportSchema),
});

export type RunSummary = z.infer<typeof runSummarySchema>;

// ── Deterministic summary decision ───────────────────────────
// CLAUDE.md rule: "Do NOT let the LLM decide the run summary —
// summary is deterministic (any FAIL → FAIL)."

export function computeSummaryVerdict(
  steps: readonly StepExecutionResult[],
): EvaluationVerdict {
  let hasUncertain = false;

  for (const step of steps) {
    if (!step.success) return 'FAIL';
    if (step.evaluation?.result === 'FAIL') return 'FAIL';
    if (step.evaluation?.result === 'UNCERTAIN') hasUncertain = true;
  }

  return hasUncertain ? 'UNCERTAIN' : 'PASS';
}

// ── Validators ────────────────────────────────────────────────

export function parseEvaluationResult(data: unknown): EvaluationResult {
  return evaluationResultSchema.parse(data);
}

export function parseRunSummary(data: unknown): RunSummary {
  return runSummarySchema.parse(data);
}
