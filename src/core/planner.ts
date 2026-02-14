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

// ── Pre-validation fixups ────────────────────────────────────
// The LLM sometimes invents strategies like "placeholder" or "name".
// Convert these to valid CSS selectors before Zod validation.

function fixupRawSteps(parsed: unknown): unknown {
  if (!Array.isArray(parsed)) return parsed;

  for (const step of parsed) {
    if (typeof step !== 'object' || step === null) continue;
    const s = step as Record<string, unknown>;

    // Fix missing description
    if (!s['description'] && typeof s['type'] === 'string') {
      s['description'] = `${s['type']} step`;
    }

    // Fix invalid selector strategies
    const selector = s['selector'];
    if (typeof selector === 'object' && selector !== null) {
      const sel = selector as Record<string, unknown>;
      const strategy = sel['strategy'];
      const value = sel['value'];

      if (typeof strategy === 'string' && typeof value === 'string') {
        if (!['testid', 'role', 'text', 'css'].includes(strategy)) {
          // Convert to CSS selector
          switch (strategy) {
            case 'placeholder':
              sel['strategy'] = 'css';
              sel['value'] = `input[placeholder='${value}']`;
              break;
            case 'name':
              sel['strategy'] = 'css';
              sel['value'] = `[name='${value}']`;
              break;
            case 'id':
              sel['strategy'] = 'css';
              sel['value'] = `#${value}`;
              break;
            case 'label':
              sel['strategy'] = 'text';
              break;
            default:
              sel['strategy'] = 'css';
              sel['value'] = `[${strategy}='${value}']`;
              break;
          }
        }
      }
    }

    // Fix missing value on expect_text steps
    if (s['type'] === 'expect_text' && !s['value']) {
      // Try to extract from description
      const desc = String(s['description'] ?? '');
      const quoted = /"([^"]+)"/.exec(desc) ?? /'([^']+)'/.exec(desc);
      if (quoted?.[1]) {
        s['value'] = quoted[1];
      } else {
        s['value'] = desc.slice(0, 50) || 'page content';
      }
    }
  }

  return parsed;
}

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

  parsed = fixupRawSteps(parsed);

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

  // UI state flags
  if (el.disabled) parts.push('DISABLED');
  if (el.ariaBusy) parts.push('BUSY');
  if (el.readOnly) parts.push('READONLY');
  if (el.classList && /loading|disabled|opacity/i.test(el.classList)) {
    parts.push(`class="${el.classList}"`);
  }

  return parts.join(' ');
}
