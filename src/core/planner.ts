import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LLMClient } from '../llm/index.js';
import type { Step, PageSnapshot } from '../schema/index.js';
import { stepListSchema } from '../schema/index.js';
import { LIMITS } from '../config/defaults.js';
import * as log from '../utils/logger.js';

// ── Public types ─────────────────────────────────────────────

export interface PlannerInput {
  prompt: string;
  baseUrl: string;
  snapshot: PageSnapshot;
  screenshotBase64?: string | undefined;
}

// ── Error ────────────────────────────────────────────────────

export class PlannerError extends Error {
  readonly exitCode = 3;

  constructor(message: string) {
    super(message);
    this.name = 'PlannerError';
  }
}

// ── Template paths ───────────────────────────────────────────

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(THIS_DIR, '..', '..', 'prompts');

// ── Main entry ───────────────────────────────────────────────

export async function planSteps(
  client: LLMClient,
  input: PlannerInput,
): Promise<Step[]> {
  log.llm('Planner generating steps...');
  const systemPrompt = await buildSystemPrompt(input);

  let raw: string;
  if (input.screenshotBase64 && client.generateWithImage) {
    log.detail('Screenshot attached — using vision mode');
    raw = await client.generateWithImage(systemPrompt, input.prompt, input.screenshotBase64, 'image/png');
  } else {
    raw = await client.generate(systemPrompt, input.prompt);
  }

  const firstAttempt = tryParse(raw);
  if (firstAttempt.ok) {
    logPlannedSteps(firstAttempt.steps);
    return firstAttempt.steps;
  }

  // Repair: one retry with the repair prompt
  log.warn(`Planner parse failed, attempting repair: ${firstAttempt.error}`);
  const repairPrompt = await buildRepairPrompt(raw, firstAttempt.error);
  const repaired = await client.generate(systemPrompt, repairPrompt);

  const secondAttempt = tryParse(repaired);
  if (secondAttempt.ok) {
    logPlannedSteps(secondAttempt.steps);
    return secondAttempt.steps;
  }

  throw new PlannerError(
    `Planner failed after repair attempt: ${secondAttempt.error}`,
  );
}

function logPlannedSteps(steps: Step[]): void {
  log.planned(steps.length);
  for (let i = 0; i < steps.length; i++) {
    log.detail(`${String(i + 1)}. [${steps[i]!.type}] ${steps[i]!.description}`);
  }
}

// ── Template rendering ───────────────────────────────────────

async function buildSystemPrompt(input: PlannerInput): Promise<string> {
  const template = await readFile(
    path.join(PROMPTS_DIR, 'planner.txt'),
    'utf-8',
  );

  const elementsText = input.snapshot.elements
    .map((el) => formatElement(el))
    .join('\n');

  const metaLine = input.snapshot.metaDescription
    ? `Meta description: ${input.snapshot.metaDescription}`
    : '';

  return template
    .replace('{{title}}', input.snapshot.title)
    .replace('{{url}}', input.snapshot.url)
    .replace('{{metaDescription}}', metaLine)
    .replace('{{visibleText}}', input.snapshot.visibleText)
    .replace('{{elements}}', elementsText)
    .replace('{{prompt}}', input.prompt)
    .replace('{{baseUrl}}', input.baseUrl);
}

async function buildRepairPrompt(
  previousOutput: string,
  error: string,
): Promise<string> {
  const template = await readFile(
    path.join(PROMPTS_DIR, 'planner_repair.txt'),
    'utf-8',
  );

  return template
    .replace('{{error}}', error)
    .replace('{{previousOutput}}', previousOutput);
}

// ── JSON extraction + validation ─────────────────────────────

type ParseResult =
  | { ok: true; steps: Step[] }
  | { ok: false; error: string };

function tryParse(raw: string): ParseResult {
  const json = extractJSON(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Invalid JSON: ${message}` };
  }

  const result = stepListSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }

  const steps = result.data;

  if (steps.length > LIMITS.MAX_STEPS) {
    return {
      ok: false,
      error: `Too many steps: ${String(steps.length)} (max ${String(LIMITS.MAX_STEPS)})`,
    };
  }

  if (steps[0]?.type !== 'goto') {
    return { ok: false, error: 'First step must be a "goto" step' };
  }

  return { ok: true, steps };
}

function extractJSON(raw: string): string {
  // Strip markdown fences if present
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) return fenced[1].trim();

  // Find outermost array brackets
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start !== -1 && end > start) return raw.slice(start, end + 1);

  return raw.trim();
}

// ── Element formatting ───────────────────────────────────────

function formatElement(el: PageSnapshot['elements'][number]): string {
  const parts = [`<${el.tag}`];

  if (el.type) parts.push(`type="${el.type}"`);
  if (el.testId) parts.push(`data-testid="${el.testId}"`);
  if (el.name) parts.push(`name="${el.name}"`);
  if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
  if (el.href) parts.push(`href="${el.href}"`);

  parts.push('>');

  if (el.text) parts.push(el.text);
  if (el.options && el.options.length > 0) {
    parts.push(`options=[${el.options.join(', ')}]`);
  }

  return parts.join(' ');
}
