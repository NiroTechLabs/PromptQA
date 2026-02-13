import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LLMClient } from '../llm/index.js';
import type { StepExecutionResult, EvaluationResult } from '../schema/index.js';
import { evaluationResultSchema } from '../schema/index.js';
import { TOKEN_GUARDS } from '../config/defaults.js';

// ── Public types ─────────────────────────────────────────────

export interface EvaluatorInput {
  stepResult: StepExecutionResult;
}

// ── Template paths ───────────────────────────────────────────

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(THIS_DIR, '..', '..', 'prompts');

// ── Fallback on total failure ────────────────────────────────

const UNCERTAIN_FALLBACK: EvaluationResult = {
  result: 'UNCERTAIN',
  confidence: 0,
  reason: 'Evaluator failed to produce a valid response',
};

// ── Main entry ───────────────────────────────────────────────

export async function evaluateStep(
  client: LLMClient,
  input: EvaluatorInput,
): Promise<EvaluationResult> {
  const systemPrompt = await buildSystemPrompt(input.stepResult);
  const raw = await client.generate(systemPrompt, input.stepResult.step.description);

  const firstAttempt = tryParse(raw);
  if (firstAttempt.ok) return firstAttempt.evaluation;

  // Repair: one retry
  const repairPrompt = await buildRepairPrompt(raw, firstAttempt.error);
  const repaired = await client.generate(systemPrompt, repairPrompt);

  const secondAttempt = tryParse(repaired);
  if (secondAttempt.ok) return secondAttempt.evaluation;

  return UNCERTAIN_FALLBACK;
}

// ── Template rendering ───────────────────────────────────────

async function buildSystemPrompt(sr: StepExecutionResult): Promise<string> {
  const template = await readFile(
    path.join(PROMPTS_DIR, 'evaluator.txt'),
    'utf-8',
  );

  const consoleErrors = formatConsoleErrors(sr);
  const networkErrors = formatNetworkErrors(sr);
  const pageErrors = sr.capture.pageErrors
    .map((e) => e.message)
    .join('\n') || '(none)';

  return template
    .replace('{{description}}', sr.step.description)
    .replace('{{expected}}', describeExpected(sr))
    .replace('{{success}}', String(sr.success))
    .replace('{{url}}', sr.url)
    .replace('{{visibleText}}', sr.visibleText.slice(0, TOKEN_GUARDS.MAX_VISIBLE_TEXT_CHARS))
    .replace('{{consoleErrors}}', consoleErrors)
    .replace('{{networkErrors}}', networkErrors)
    .replace('{{pageErrors}}', pageErrors);
}

async function buildRepairPrompt(
  previousOutput: string,
  error: string,
): Promise<string> {
  const template = await readFile(
    path.join(PROMPTS_DIR, 'evaluator_repair.txt'),
    'utf-8',
  );

  return template
    .replace('{{error}}', error)
    .replace('{{previousOutput}}', previousOutput);
}

// ── JSON extraction + validation ─────────────────────────────

type ParseResult =
  | { ok: true; evaluation: EvaluationResult }
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

  // Clamp confidence before validation
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'confidence' in parsed &&
    typeof (parsed as Record<string, unknown>)['confidence'] === 'number'
  ) {
    const obj = parsed as Record<string, unknown>;
    const raw = obj['confidence'] as number;
    obj['confidence'] = Math.max(0, Math.min(1, raw));
  }

  const result = evaluationResultSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }

  return { ok: true, evaluation: result.data };
}

function extractJSON(raw: string): string {
  // Strip markdown fences if present
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) return fenced[1].trim();

  // Find outermost object braces
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return raw.slice(start, end + 1);

  return raw.trim();
}

// ── Hard failure detection (no LLM needed) ───────────────────

export function detectHardFail(result: StepExecutionResult): string | null {
  if (!result.success) {
    return 'Step execution failed';
  }

  const firstPageError = result.capture.pageErrors[0];
  if (firstPageError) {
    return `Uncaught page error: ${firstPageError.message}`;
  }

  const serverError = result.capture.networkFailures.find(
    (f) =>
      f.status >= 500 &&
      ['POST', 'PUT', 'DELETE'].includes(f.method.toUpperCase()),
  );
  if (serverError) {
    return `Server error ${String(serverError.status)} on ${serverError.method} ${serverError.url}`;
  }

  return null;
}

// ── Formatting helpers ───────────────────────────────────────

function formatConsoleErrors(sr: StepExecutionResult): string {
  const entries = sr.capture.consoleEntries.slice(0, TOKEN_GUARDS.MAX_CONSOLE_ERRORS);
  if (entries.length === 0) return '(none)';
  return entries.map((e) => `[${e.level}] ${e.text}`).join('\n');
}

function formatNetworkErrors(sr: StepExecutionResult): string {
  const failures = sr.capture.networkFailures.slice(0, TOKEN_GUARDS.MAX_NETWORK_ERRORS);
  if (failures.length === 0) return '(none)';
  return failures
    .map((f) => `${f.method} ${f.url} → ${String(f.status)} ${f.statusText}`)
    .join('\n');
}

function describeExpected(sr: StepExecutionResult): string {
  switch (sr.step.type) {
    case 'goto':
      return `Navigate to ${sr.step.value}`;
    case 'click':
      return `Click element described as: ${sr.step.description}`;
    case 'type':
      return `Type "${sr.step.value}" into field`;
    case 'select':
      return `Select option "${sr.step.value}"`;
    case 'upload':
      return `Upload file "${sr.step.value}"`;
    case 'wait':
      return sr.step.selector
        ? `Wait for element to appear`
        : `Wait ${sr.step.value ?? 'unspecified'} ms`;
    case 'expect_text':
      return `Expect text "${sr.step.value}" to be visible`;
  }
}
