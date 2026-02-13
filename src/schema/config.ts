import { z } from 'zod';

// ── Test entry ──────────────────────────────────────────────

export const testEntrySchema = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  url: z.string().url().optional(),
});

export type TestEntry = z.infer<typeof testEntrySchema>;

// ── Auth block ──────────────────────────────────────────────

export const authConfigSchema = z.object({
  cookie: z.string().optional(),
  loginPrompt: z.string().optional(),
});

export type AuthConfig = z.infer<typeof authConfigSchema>;

// ── Full config file ────────────────────────────────────────

export const fileConfigSchema = z.object({
  baseUrl: z.string().url(),
  maxSteps: z.number().int().positive().optional().default(12),
  headless: z.boolean().optional().default(false),
  timeout: z.number().positive().optional().default(180),
  provider: z.enum(['anthropic', 'openai', 'mock']).optional(),
  model: z.string().min(1).optional(),
  auth: authConfigSchema.optional(),
  tests: z.array(testEntrySchema).min(1),
});

export type FileConfig = z.infer<typeof fileConfigSchema>;
