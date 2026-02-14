import { z } from 'zod';

// ── SelectorHint ──────────────────────────────────────────────

export const selectorStrategySchema = z.enum(['testid', 'role', 'text', 'css']);

export type SelectorStrategy = z.infer<typeof selectorStrategySchema>;

export const selectorHintSchema = z.object({
  strategy: selectorStrategySchema,
  value: z.string().min(1),
  role: z.string().optional(),
  name: z.string().optional(),
});

export type SelectorHint = z.infer<typeof selectorHintSchema>;

// ── Step type discriminator ───────────────────────────────────

export const stepTypeSchema = z.enum([
  'goto',
  'click',
  'type',
  'select',
  'upload',
  'wait',
  'expect_text',
  'press_key',
]);

export type StepType = z.infer<typeof stepTypeSchema>;

// ── Individual step schemas ───────────────────────────────────

const baseFields = {
  description: z.string().min(1),
  timeout: z.number().int().positive().optional(),
};

export const gotoStepSchema = z.object({
  ...baseFields,
  type: z.literal('goto'),
  value: z.string().min(1),
});

export const clickStepSchema = z.object({
  ...baseFields,
  type: z.literal('click'),
  selector: selectorHintSchema,
});

export const typeStepSchema = z.object({
  ...baseFields,
  type: z.literal('type'),
  selector: selectorHintSchema,
  value: z.string(),
});

export const selectStepSchema = z.object({
  ...baseFields,
  type: z.literal('select'),
  selector: selectorHintSchema,
  value: z.string(),
});

export const uploadStepSchema = z.object({
  ...baseFields,
  type: z.literal('upload'),
  selector: selectorHintSchema,
  value: z.string().min(1),
});

export const waitStepSchema = z.object({
  ...baseFields,
  type: z.literal('wait'),
  selector: selectorHintSchema.optional(),
  value: z.string().optional(),
});

export const expectTextStepSchema = z.object({
  ...baseFields,
  type: z.literal('expect_text'),
  selector: selectorHintSchema.optional(),
  value: z.string().min(1),
});

export const pressKeyStepSchema = z.object({
  ...baseFields,
  type: z.literal('press_key'),
  value: z.string().min(1),
});

// ── Union schema ──────────────────────────────────────────────

export const stepSchema = z.discriminatedUnion('type', [
  gotoStepSchema,
  clickStepSchema,
  typeStepSchema,
  selectStepSchema,
  uploadStepSchema,
  waitStepSchema,
  expectTextStepSchema,
  pressKeyStepSchema,
]);

export type Step = z.infer<typeof stepSchema>;

// Convenience aliases for individual step types
export type GotoStep = z.infer<typeof gotoStepSchema>;
export type ClickStep = z.infer<typeof clickStepSchema>;
export type TypeStep = z.infer<typeof typeStepSchema>;
export type SelectStep = z.infer<typeof selectStepSchema>;
export type UploadStep = z.infer<typeof uploadStepSchema>;
export type WaitStep = z.infer<typeof waitStepSchema>;
export type ExpectTextStep = z.infer<typeof expectTextStepSchema>;
export type PressKeyStep = z.infer<typeof pressKeyStepSchema>;

// ── List schema ───────────────────────────────────────────────

export const stepListSchema = z.array(stepSchema).min(1);

// ── Parser ────────────────────────────────────────────────────

export function parseStepJSON(raw: string): Step[] {
  const parsed: unknown = JSON.parse(raw);
  return stepListSchema.parse(parsed);
}

export function parseStep(data: unknown): Step {
  return stepSchema.parse(data);
}

// ── Type guards ───────────────────────────────────────────────

export function isGotoStep(step: Step): step is GotoStep {
  return step.type === 'goto';
}

export function isClickStep(step: Step): step is ClickStep {
  return step.type === 'click';
}

export function isTypeStep(step: Step): step is TypeStep {
  return step.type === 'type';
}

export function isSelectStep(step: Step): step is SelectStep {
  return step.type === 'select';
}

export function isUploadStep(step: Step): step is UploadStep {
  return step.type === 'upload';
}

export function isWaitStep(step: Step): step is WaitStep {
  return step.type === 'wait';
}

export function isExpectTextStep(step: Step): step is ExpectTextStep {
  return step.type === 'expect_text';
}

export function isPressKeyStep(step: Step): step is PressKeyStep {
  return step.type === 'press_key';
}
