import { z } from 'zod';

// ── InteractiveElement ───────────────────────────────────────

export const interactiveElementSchema = z.object({
  tag: z.string().min(1),
  type: z.string().optional(),
  text: z.string().optional(),
  testId: z.string().optional(),
  name: z.string().optional(),
  placeholder: z.string().optional(),
  href: z.string().optional(),
  options: z.array(z.string()).optional(),
});

export type InteractiveElement = z.infer<typeof interactiveElementSchema>;

// ── PageSnapshot ─────────────────────────────────────────────

export const pageSnapshotSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  metaDescription: z.string().optional(),
  visibleText: z.string(),
  elements: z.array(interactiveElementSchema),
});

export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;
