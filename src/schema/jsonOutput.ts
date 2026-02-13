import { z } from 'zod';

import { evaluationVerdictSchema, bugSeveritySchema } from './results.js';

// ── Version ─────────────────────────────────────────────────
// Bump this when the contract changes.

export const JSON_OUTPUT_VERSION = '1.0' as const;

// ── Step output ─────────────────────────────────────────────

export const jsonOutputStepSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.string().min(1),
  description: z.string(),
  result: evaluationVerdictSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  screenshotPath: z.string(),
  errors: z.array(z.string()),
});

export type JsonOutputStep = z.infer<typeof jsonOutputStepSchema>;

// ── Bug output ──────────────────────────────────────────────

export const jsonOutputBugSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  description: z.string().min(1),
  severity: bugSeveritySchema,
  evidence: z.array(z.string()),
});

export type JsonOutputBug = z.infer<typeof jsonOutputBugSchema>;

// ── Root output ─────────────────────────────────────────────

export const jsonOutputSchema = z.object({
  version: z.literal(JSON_OUTPUT_VERSION),
  summary: evaluationVerdictSchema,
  runId: z.string().min(1),
  url: z.string(),
  prompt: z.string(),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int().nonnegative(),
  steps: z.array(jsonOutputStepSchema),
  bugs: z.array(jsonOutputBugSchema),
});

export type JsonOutput = z.infer<typeof jsonOutputSchema>;
