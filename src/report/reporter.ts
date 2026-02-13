import type {
  RunSummary,
  StepExecutionResult,
  EvaluationVerdict,
} from '../schema/index.js';
import {
  JSON_OUTPUT_VERSION,
} from '../schema/jsonOutput.js';
import type {
  JsonOutput,
  JsonOutputStep,
  JsonOutputBug,
} from '../schema/jsonOutput.js';

// Re-export contract types for consumers
export type { JsonOutput, JsonOutputStep, JsonOutputBug };

// ── JSON generator ───────────────────────────────────────────

export function generateJSON(
  run: RunSummary,
  exitCode: number,
): JsonOutput {
  return {
    version: JSON_OUTPUT_VERSION,
    summary: run.summary,
    runId: run.runId,
    url: run.url,
    prompt: run.prompt,
    durationMs: run.durationMs,
    exitCode,
    steps: run.steps.map(stepToJSON),
    bugs: run.bugs.map(bugToJSON),
  };
}

function stepToJSON(sr: StepExecutionResult): JsonOutputStep {
  return {
    index: sr.stepIndex,
    type: sr.step.type,
    description: sr.step.description,
    result: sr.evaluation?.result ?? (sr.success ? 'PASS' : 'FAIL'),
    confidence: sr.evaluation?.confidence ?? 0,
    reason: sr.evaluation?.reason ?? (sr.success ? '' : 'Step execution failed'),
    screenshotPath: sr.screenshotPath,
    errors: collectErrors(sr),
  };
}

function bugToJSON(bug: RunSummary['bugs'][number]): JsonOutputBug {
  return {
    stepIndex: bug.stepIndex,
    description: bug.description,
    severity: bug.severity,
    evidence: bug.evidence,
  };
}

// ── Deterministic serialization ─────────────────────────────
// Keys are sorted lexicographically for stable, diffable output.

export function serializeJSON(output: JsonOutput): string {
  return JSON.stringify(output, sortedReplacer, 2);
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = (value as Record<string, unknown>)[k];
  }
  return sorted;
}

// ── Markdown generator ───────────────────────────────────────

export function generateMarkdown(run: RunSummary): string {
  const lines: string[] = [];

  // Header + metadata
  lines.push(`# PromptQA Report`);
  lines.push('');
  lines.push(`| Field | Value |`);
  lines.push(`|-------|-------|`);
  lines.push(`| **URL** | ${run.url} |`);
  lines.push(`| **Prompt** | ${run.prompt} |`);
  lines.push(`| **Run ID** | \`${run.runId}\` |`);
  lines.push(`| **Started** | ${run.startedAt} |`);
  lines.push(`| **Finished** | ${run.finishedAt} |`);
  lines.push(`| **Duration** | ${formatDuration(run.durationMs)} |`);
  lines.push(`| **Result** | **${run.summary}** ${verdictIcon(run.summary)} |`);
  lines.push('');

  // Step summary table
  lines.push(`## Steps`);
  lines.push('');
  lines.push(`| # | Description | Result | Confidence | Reason |`);
  lines.push(`|---|-------------|--------|------------|--------|`);

  for (const sr of run.steps) {
    const result = sr.evaluation?.result ?? (sr.success ? 'PASS' : 'FAIL');
    const confidence = sr.evaluation?.confidence ?? 0;
    const reason = escapeMarkdownCell(
      sr.evaluation?.reason ?? (sr.success ? '' : 'Step execution failed'),
    );
    lines.push(
      `| ${String(sr.stepIndex)} | ${escapeMarkdownCell(sr.step.description)} | ${result} ${verdictIcon(result)} | ${formatConfidence(confidence)} | ${reason} |`,
    );
  }

  lines.push('');

  // Per-step details
  lines.push(`## Step Details`);
  lines.push('');

  for (const sr of run.steps) {
    lines.push(`### Step ${String(sr.stepIndex)}: ${sr.step.description}`);
    lines.push('');
    lines.push(`![screenshot](${sr.screenshotPath})`);
    lines.push('');

    const consoleErrors = sr.capture.consoleEntries.filter(
      (e) => e.level === 'error',
    );
    if (consoleErrors.length > 0) {
      lines.push(`**Console Errors:**`);
      lines.push('');
      for (const entry of consoleErrors) {
        lines.push(`- ${entry.text}`);
      }
      lines.push('');
    }

    if (sr.capture.networkFailures.length > 0) {
      lines.push(`**Network Failures:**`);
      lines.push('');
      for (const f of sr.capture.networkFailures) {
        lines.push(
          `- \`${f.method} ${f.url}\` -> ${String(f.status)} ${f.statusText}`,
        );
      }
      lines.push('');
    }

    if (sr.capture.pageErrors.length > 0) {
      lines.push(`**Page Errors:**`);
      lines.push('');
      for (const pe of sr.capture.pageErrors) {
        lines.push(`- ${pe.message}`);
      }
      lines.push('');
    }
  }

  // Bug reports
  if (run.bugs.length > 0) {
    lines.push(`## Bug Reports`);
    lines.push('');

    for (const bug of run.bugs) {
      lines.push(
        `### [${bug.severity.toUpperCase()}] Step ${String(bug.stepIndex)}: ${bug.description}`,
      );
      lines.push('');
      if (bug.evidence.length > 0) {
        lines.push(`**Evidence:**`);
        lines.push('');
        for (const e of bug.evidence) {
          lines.push(`- ${e}`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ── Helpers ──────────────────────────────────────────────────

function collectErrors(sr: StepExecutionResult): string[] {
  const errors: string[] = [];

  for (const entry of sr.capture.consoleEntries) {
    if (entry.level === 'error') {
      errors.push(`console: ${entry.text}`);
    }
  }
  for (const f of sr.capture.networkFailures) {
    errors.push(`network: ${f.method} ${f.url} ${String(f.status)}`);
  }
  for (const pe of sr.capture.pageErrors) {
    errors.push(`page: ${pe.message}`);
  }

  return errors;
}

function verdictIcon(verdict: EvaluationVerdict): string {
  switch (verdict) {
    case 'PASS':
      return '[PASS]';
    case 'FAIL':
      return '[FAIL]';
    case 'UNCERTAIN':
      return '[?]';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(ms)}ms`;
  const seconds = (ms / 1000).toFixed(1);
  return `${seconds}s`;
}

function formatConfidence(value: number): string {
  return `${String(Math.round(value * 100))}%`;
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
