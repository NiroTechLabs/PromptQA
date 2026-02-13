import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { LLMClient } from '../llm/index.js';
import type {
  Step,
  StepExecutionResult,
  BugReport,
  RunSummary,
  EvaluationVerdict,
} from '../schema/index.js';
import { computeSummaryVerdict } from '../schema/index.js';
import { TIMEOUTS, LIMITS } from '../config/defaults.js';
import type { CookieParam } from '../browser/runner.js';
import { launchSession } from '../browser/runner.js';
import { prescanPage } from '../browser/prescan.js';
import { generateJSON, serializeJSON } from '../report/reporter.js';
import { planSteps, PlannerError } from './planner.js';
import { evaluateStep } from './evaluator.js';

// ── Public types ─────────────────────────────────────────────

export interface AgentLoopConfig {
  url: string;
  prompt: string;
  headless: boolean;
  outputDir: string;
  maxSteps?: number | undefined;
  totalTimeout?: number | undefined;
  cookies?: readonly CookieParam[] | undefined;
  loginPrompt?: string | undefined;
}

export interface AgentLoopResult {
  summary: RunSummary;
  exitCode: number;
}

// ── Retry classification ─────────────────────────────────────

type FailureKind = 'element_not_found' | 'action_no_effect' | 'hard_fail' | 'none';

function classifyFailure(
  result: StepExecutionResult,
  prevVisibleText: string,
): FailureKind {
  if (!result.success) {
    // Step threw — distinguish selector-not-found from real crashes.
    // Page errors or 5xx on mutations are hard fails (not retryable).
    const hasPageError = result.capture.pageErrors.length > 0;
    const hasServerError = result.capture.networkFailures.some(
      (f) =>
        f.status >= 500 &&
        ['POST', 'PUT', 'DELETE'].includes(f.method.toUpperCase()),
    );
    if (hasPageError || hasServerError) {
      return 'hard_fail';
    }
    // Otherwise it's likely a selector timeout → retryable
    return 'element_not_found';
  }

  // Step succeeded but page errors occurred → hard fail
  if (result.capture.pageErrors.length > 0) {
    return 'hard_fail';
  }

  // Step succeeded but nothing changed on an interactive step → retryable
  if (
    result.step.type !== 'goto' &&
    result.step.type !== 'wait' &&
    result.step.type !== 'expect_text' &&
    result.visibleText === prevVisibleText
  ) {
    return 'action_no_effect';
  }

  return 'none';
}

// ── Bug extraction (deterministic) ──────────────────────────

function extractBugs(steps: readonly StepExecutionResult[]): BugReport[] {
  const bugs: BugReport[] = [];

  for (const sr of steps) {
    const evidence: string[] = [];

    // Collect evidence from capture
    for (const entry of sr.capture.consoleEntries) {
      if (entry.level === 'error') {
        evidence.push(`Console error: ${entry.text}`);
      }
    }
    for (const failure of sr.capture.networkFailures) {
      evidence.push(
        `Network ${failure.method} ${failure.url} → ${String(failure.status)}`,
      );
    }
    for (const pe of sr.capture.pageErrors) {
      evidence.push(`Page error: ${pe.message}`);
    }

    if (!sr.success) {
      bugs.push({
        stepIndex: sr.stepIndex,
        description: `Step failed: ${sr.step.description}`,
        severity: 'critical',
        evidence,
      });
      continue;
    }

    if (sr.evaluation?.result === 'FAIL') {
      const severity = sr.capture.pageErrors.length > 0 ? 'critical' : 'major';
      bugs.push({
        stepIndex: sr.stepIndex,
        description: sr.evaluation.reason,
        severity,
        evidence,
      });
    }
  }

  return bugs;
}

// ── Artifact writing ─────────────────────────────────────────

async function writeStepArtifact(
  outputDir: string,
  stepIndex: number,
  result: StepExecutionResult,
): Promise<void> {
  const filePath = path.join(outputDir, `step-${String(stepIndex)}.json`);
  await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
}

// ── Main agent loop ──────────────────────────────────────────

export async function runAgentLoop(
  client: LLMClient,
  config: AgentLoopConfig,
): Promise<AgentLoopResult> {
  const runId = randomUUID();
  const startedAt = new Date();
  const maxSteps = config.maxSteps ?? LIMITS.MAX_STEPS;
  const totalTimeout = config.totalTimeout ?? TIMEOUTS.TOTAL_RUN_TIMEOUT;

  const screenshotDir = path.join(config.outputDir, 'screenshots');
  await mkdir(config.outputDir, { recursive: true });

  const runTimer = setTimeout(() => {
    // Intentionally left empty — checked via deadline comparison
  }, totalTimeout);
  const deadline = startedAt.getTime() + totalTimeout;

  // ── 1. Launch browser session ──────────────────────────────

  const session = await launchSession({
    headless: config.headless,
    screenshotDir,
  });

  try {
    // ── 2. Inject cookies (before any navigation) ──────────────

    if (config.cookies && config.cookies.length > 0) {
      await session.addCookies(config.cookies);
    }

    // ── 3. Pre-scan target URL ─────────────────────────────────

    let snapshot = await prescanPage(session.page, config.url);

    // ── 4. Login flow (if requested) ─────────────────────────

    if (config.loginPrompt) {
      const loginSteps = await planSteps(client, {
        prompt: config.loginPrompt,
        baseUrl: config.url,
        snapshot,
      });
      for (let i = 0; i < loginSteps.length; i++) {
        await session.executeStep(loginSteps[i]!, i);
      }
      // Re-scan after login — page state has changed
      snapshot = await prescanPage(session.page, session.page.url());
    }

    // ── 5. Plan steps ──────────────────────────────────────────

    let steps: Step[];
    try {
      steps = await planSteps(client, {
        prompt: config.prompt,
        baseUrl: config.url,
        snapshot,
      });
    } catch (err) {
      if (err instanceof PlannerError) {
        const finishedAt = new Date();
        return {
          summary: {
            runId,
            url: config.url,
            prompt: config.prompt,
            summary: 'FAIL',
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
            durationMs: finishedAt.getTime() - startedAt.getTime(),
            steps: [],
            bugs: [],
          },
          exitCode: err.exitCode,
        };
      }
      throw err;
    }

    if (steps.length > maxSteps) {
      steps = steps.slice(0, maxSteps);
    }

    // ── 4. Execute each step ───────────────────────────────────

    const results: StepExecutionResult[] = [];
    let prevVisibleText = snapshot.visibleText;

    for (let i = 0; i < steps.length; i++) {
      // Check total run timeout
      if (Date.now() > deadline) {
        break;
      }

      const step = steps[i]!;
      let result = await session.executeStep(step, i);

      // ── 4a. Check retry conditions ─────────────────────────

      const failKind = classifyFailure(result, prevVisibleText);

      if (
        failKind === 'element_not_found' &&
        Date.now() + TIMEOUTS.RETRY_WAIT < deadline
      ) {
        // Selector timeout — wait and retry once
        await delay(TIMEOUTS.RETRY_WAIT);
        result = await session.executeStep(step, i);
      } else if (failKind === 'action_no_effect') {
        // Page unchanged after interaction — retry once immediately
        result = await session.executeStep(step, i);
      }
      // hard_fail or none: no retry

      // ── 4b. Evaluate with LLM ─────────────────────────────

      if (Date.now() <= deadline) {
        const evaluation = await evaluateStep(client, {
          stepResult: result,
        });
        result = { ...result, evaluation };
      }

      // ── 4c. Store result and write artifact ────────────────

      results.push(result);
      await writeStepArtifact(config.outputDir, i, result).catch(() => {});

      prevVisibleText = result.visibleText;

      // ── 4d. Hard fail → stop early ─────────────────────────

      if (!result.success || classifyFailure(result, prevVisibleText) === 'hard_fail') {
        break;
      }
    }

    // ── 5. Calculate deterministic summary ─────────────────────

    const verdict: EvaluationVerdict = computeSummaryVerdict(results);
    const bugs = extractBugs(results);
    const finishedAt = new Date();

    const summary: RunSummary = {
      runId,
      url: config.url,
      prompt: config.prompt,
      summary: verdict,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      steps: results,
      bugs,
    };

    const exitCode = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2;

    // Write contract-format summary.json (sorted keys, stable output)
    const jsonOutput = generateJSON(summary, exitCode);
    const summaryPath = path.join(config.outputDir, 'summary.json');
    await writeFile(summaryPath, serializeJSON(jsonOutput) + '\n', 'utf-8').catch(
      () => {},
    );

    return { summary, exitCode };
  } finally {
    clearTimeout(runTimer);
    await session.close();
  }
}

// ── Helpers ──────────────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
