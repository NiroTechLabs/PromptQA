import { z } from 'zod';

// ── Console entry ────────────────────────────────────────────

export const consoleLevelSchema = z.enum(['error', 'warn']);

export type ConsoleLevel = z.infer<typeof consoleLevelSchema>;

export const consoleEntrySchema = z.object({
  level: consoleLevelSchema,
  text: z.string(),
});

export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

// ── Network failure ──────────────────────────────────────────

export const networkFailureSchema = z.object({
  url: z.string(),
  status: z.number().int(),
  statusText: z.string(),
  method: z.string(),
});

export type NetworkFailure = z.infer<typeof networkFailureSchema>;

// ── Page error ───────────────────────────────────────────────

export const pageErrorEntrySchema = z.object({
  message: z.string(),
});

export type PageErrorEntry = z.infer<typeof pageErrorEntrySchema>;

// ── Step capture (aggregate per step) ────────────────────────

export const stepCaptureSchema = z.object({
  consoleEntries: z.array(consoleEntrySchema),
  networkFailures: z.array(networkFailureSchema),
  pageErrors: z.array(pageErrorEntrySchema),
});

export type StepCapture = z.infer<typeof stepCaptureSchema>;
