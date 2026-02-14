import { z } from 'zod';

import { selectorHintSchema } from './step.js';

// ── Step schema for V2 agent loop (no "goto") ───────────────

const agentStepTypeSchema = z.enum([
  'click',
  'type',
  'select',
  'wait',
  'expect_text',
]);

export type AgentStepType = z.infer<typeof agentStepTypeSchema>;

const baseFields = {
  description: z.string().min(1),
  timeout: z.number().int().positive().optional(),
};

const agentClickStepSchema = z.object({
  ...baseFields,
  type: z.literal('click'),
  selector: selectorHintSchema,
});

const agentTypeStepSchema = z.object({
  ...baseFields,
  type: z.literal('type'),
  selector: selectorHintSchema,
  value: z.string(),
});

const agentSelectStepSchema = z.object({
  ...baseFields,
  type: z.literal('select'),
  selector: selectorHintSchema,
  value: z.string(),
});

const agentWaitStepSchema = z.object({
  ...baseFields,
  type: z.literal('wait'),
  selector: selectorHintSchema.optional(),
  value: z.string().optional(),
});

const agentExpectTextStepSchema = z.object({
  ...baseFields,
  type: z.literal('expect_text'),
  selector: selectorHintSchema.optional(),
  value: z.string().min(1),
});

export const agentActionStepSchema = z.discriminatedUnion('type', [
  agentClickStepSchema,
  agentTypeStepSchema,
  agentSelectStepSchema,
  agentWaitStepSchema,
  agentExpectTextStepSchema,
]);

export type AgentActionStep = z.infer<typeof agentActionStepSchema>;

// ── Agent step response (done OR action) ────────────────────

const agentDoneSchema = z.object({
  done: z.literal(true),
  summary: z.string().min(1),
});

const agentNextActionSchema = z.object({
  done: z.literal(false),
  action: agentActionStepSchema,
});

export const agentStepResponseSchema = z.discriminatedUnion('done', [
  agentDoneSchema,
  agentNextActionSchema,
]);

export type AgentStepResponse = z.infer<typeof agentStepResponseSchema>;
export type AgentDoneResponse = z.infer<typeof agentDoneSchema>;
export type AgentNextAction = z.infer<typeof agentNextActionSchema>;

// ── Final evaluation response ───────────────────────────────

export const agentFinalEvaluationSchema = z.object({
  result: z.enum(['PASS', 'FAIL', 'UNCERTAIN']),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export type AgentFinalEvaluation = z.infer<typeof agentFinalEvaluationSchema>;

// ── Action history entry ────────────────────────────────────

export interface ActionHistoryEntry {
  stepIndex: number;
  action: string;
  description: string;
  success: boolean;
  observation: string;
}
