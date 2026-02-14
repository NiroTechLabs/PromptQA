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
import * as log from '../utils/logger.js';
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

  log.section(`Run: ${config.prompt}`);
  log.info(`Target: ${config.url}`);

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
    log.prescan(snapshot.elements.length, config.url);

    // Capture screenshot for vision-assisted planning
    let screenshotBase64: string | undefined;
    try {
      const buf = await session.page.screenshot({ type: 'png' });
      screenshotBase64 = buf.toString('base64');
      log.detail('Page screenshot captured for planner vision');
    } catch {
      // Non-fatal — planner falls back to DOM-only mode
    }

    // ── 4. Login flow (if requested) ─────────────────────────

    let loginFailed = false;

    if (config.loginPrompt) {
      try {
        log.section('Login Flow');
        log.login('Starting login flow...');
        const loginSteps = await planSteps(client, {
          prompt: config.loginPrompt,
          baseUrl: config.url,
          snapshot,
          screenshotBase64,
        });
        for (let i = 0; i < loginSteps.length; i++) {
          log.step(i, loginSteps.length, loginSteps[i]!.description);
          await session.executeStep(loginSteps[i]!, i);
        }
        log.login('Login flow complete');
        // Give the page time to settle after login before re-scanning
        log.info('Waiting for page to settle after login...');
        try {
          await session.page.waitForLoadState('networkidle', { timeout: 5_000 });
        } catch {
          // Non-fatal — page may have long-polling or streaming connections
        }
        // Re-scan after login — page state has changed
        snapshot = await prescanPage(session.page, session.page.url());
        log.prescan(snapshot.elements.length, session.page.url());
        try {
          const buf = await session.page.screenshot({ type: 'png' });
          screenshotBase64 = buf.toString('base64');
        } catch {
          screenshotBase64 = undefined;
        }
      } catch (loginErr) {
        loginFailed = true;
        const loginMessage = loginErr instanceof Error ? loginErr.message : String(loginErr);
        log.error(`Login flow failed: ${loginMessage}`);
        log.warn('Continuing test run — results may reflect unauthenticated state');
        // Take a screenshot to show the state at login failure
        try {
          const buf = await session.page.screenshot({ type: 'png' });
          screenshotBase64 = buf.toString('base64');
          await session.page.screenshot({
            path: path.join(screenshotDir, 'login-failure.png'),
            fullPage: true,
          });
        } catch {
          // Browser may be in a bad state — nothing we can do
        }
        // Re-scan if possible so planner has something to work with
        try {
          snapshot = await prescanPage(session.page, session.page.url());
        } catch {
          // Keep existing snapshot
        }
      }
    }

    // ── 5. Plan steps ──────────────────────────────────────────

    log.section('Planning');
    let steps: Step[];
    try {
      steps = await planSteps(client, {
        prompt: config.prompt,
        baseUrl: config.url,
        snapshot,
        screenshotBase64,
      });
    } catch (err) {
      const plannerMessage = err instanceof Error ? err.message : String(err);
      const exitCode = err instanceof PlannerError ? err.exitCode : 4;
      log.error(`Planner failed: ${plannerMessage}`);

      const finishedAt = new Date();
      const failSummary: RunSummary = {
        runId,
        url: config.url,
        prompt: config.prompt,
        summary: 'FAIL',
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        steps: [],
        bugs: [{
          stepIndex: 0,
          description: `Planner error: ${plannerMessage}`,
          severity: 'critical',
          evidence: loginFailed ? ['Login flow also failed before planning'] : [],
        }],
      };

      // Always write summary.json even on planner failure
      const jsonOutput = generateJSON(failSummary, exitCode);
      const summaryPath = path.join(config.outputDir, 'summary.json');
      await writeFile(summaryPath, serializeJSON(jsonOutput) + '\n', 'utf-8').catch(() => {});

      return { summary: failSummary, exitCode };
    }

    if (steps.length > maxSteps) {
      log.warn(`Truncating plan from ${String(steps.length)} to ${String(maxSteps)} steps`);
      steps = steps.slice(0, maxSteps);
    }

    // ── 4. Execute each step ───────────────────────────────────

    log.section('Execution');
    const results: StepExecutionResult[] = [];
    let prevVisibleText = snapshot.visibleText;

    for (let i = 0; i < steps.length; i++) {
      // Check total run timeout
      if (Date.now() > deadline) {
        break;
      }

      const step = steps[i]!;
      log.step(i, steps.length, step.description);

      let result: StepExecutionResult;

      try {
        result = await session.executeStep(step, i);
      } catch (execErr) {
        // Unexpected crash in executeStep — build a synthetic failed result
        const execMessage = execErr instanceof Error ? execErr.message : String(execErr);
        log.error(`Step ${String(i + 1)} crashed: ${execMessage}`);

        // Try to take a screenshot even on crash
        const crashScreenshotPath = path.join(screenshotDir, `step-${String(i)}.png`);
        try {
          await session.page.screenshot({ path: crashScreenshotPath, fullPage: true });
        } catch {
          // Browser may be dead — nothing we can do
        }

        result = {
          stepIndex: i,
          step,
          success: false,
          url: session.page.url(),
          screenshotPath: crashScreenshotPath,
          visibleText: '',
          capture: {
            consoleEntries: [],
            networkFailures: [],
            pageErrors: [{ message: `executeStep crashed: ${execMessage}` }],
          },
        };
        results.push(result);
        await writeStepArtifact(config.outputDir, i, result).catch(() => {});
        // Continue to next step instead of crashing the whole run
        continue;
      }

      // ── 4a. Check retry conditions ─────────────────────────

      const failKind = classifyFailure(result, prevVisibleText);

      if (
        failKind === 'element_not_found' &&
        Date.now() + TIMEOUTS.RETRY_WAIT < deadline
      ) {
        // Selector timeout — wait and retry once
        log.warn(`Element not found, retrying step ${String(i + 1)}...`);
        await delay(TIMEOUTS.RETRY_WAIT);
        try {
          result = await session.executeStep(step, i);
        } catch {
          // Retry also crashed — keep original failed result
        }
      } else if (failKind === 'action_no_effect') {
        // Page unchanged after interaction — retry once immediately
        log.warn(`No page change detected, retrying step ${String(i + 1)}...`);
        try {
          result = await session.executeStep(step, i);
        } catch {
          // Retry crashed — keep original result
        }
      }
      // hard_fail or none: no retry

      // ── 4b. Evaluate with LLM ─────────────────────────────

      if (Date.now() <= deadline) {
        try {
          const evaluation = await evaluateStep(client, {
            stepResult: result,
          });
          result = { ...result, evaluation };
        } catch (evalErr) {
          const evalMessage = evalErr instanceof Error ? evalErr.message : String(evalErr);
          log.warn(`Evaluator failed for step ${String(i + 1)}: ${evalMessage}`);
          // Continue without evaluation — step result still gets recorded
        }
      }

      // ── 4c. Store result and write artifact ────────────────

      log.stepResult(i, steps.length, result.success, step.description);
      if (!result.success) {
        log.error(`Step failed: ${step.description}`);
      }

      results.push(result);
      await writeStepArtifact(config.outputDir, i, result).catch(() => {});

      prevVisibleText = result.visibleText;

      // ── 4d. Hard fail → stop early ─────────────────────────

      if (!result.success || classifyFailure(result, prevVisibleText) === 'hard_fail') {
        if (classifyFailure(result, prevVisibleText) === 'hard_fail') {
          log.error('Hard failure detected — stopping early');
        }
        break;
      }
    }

    // ── 5. Calculate deterministic summary ─────────────────────

    const verdict: EvaluationVerdict = computeSummaryVerdict(results);
    const bugs = extractBugs(results);
    const finishedAt = new Date();

    log.section('Summary');
    const durationSec = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
    log.info(`Verdict: ${verdict} (${String(results.length)} steps, ${durationSec}s)`);
    if (bugs.length > 0) {
      log.warn(`${String(bugs.length)} bug(s) found`);
    }

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
