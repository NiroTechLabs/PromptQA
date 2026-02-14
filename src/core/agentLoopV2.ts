import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LLMClient } from '../llm/index.js';
import type {
  Step,
  StepExecutionResult,
  BugReport,
  RunSummary,
  EvaluationVerdict,
  PageSnapshot,
} from '../schema/index.js';
import { computeSummaryVerdict } from '../schema/index.js';
import type {
  AgentStepResponse,
  AgentFinalEvaluation,
  ActionHistoryEntry,
} from '../schema/agentStep.js';
import {
  agentStepResponseSchema,
  agentFinalEvaluationSchema,
} from '../schema/agentStep.js';
import { TIMEOUTS, TOKEN_GUARDS } from '../config/defaults.js';
import * as log from '../utils/logger.js';
import type { CookieParam } from '../browser/runner.js';
import { launchSession } from '../browser/runner.js';
import { prescanCurrentPage } from '../browser/prescan.js';
import { generateJSON, serializeJSON } from '../report/reporter.js';

// ── Public types ─────────────────────────────────────────────

export interface AgentLoopV2Config {
  url: string;
  prompt: string;
  headless: boolean;
  outputDir: string;
  maxSteps?: number | undefined;
  totalTimeout?: number | undefined;
  cookies?: readonly CookieParam[] | undefined;
  loginPrompt?: string | undefined;
}

export interface AgentLoopV2Result {
  summary: RunSummary;
  exitCode: number;
}

// ── Constants ────────────────────────────────────────────────

const V2_MAX_STEPS = 15;
const LOGIN_MAX_STEPS = 8;

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(THIS_DIR, '..', '..', 'prompts');

// ── Pre-validation fixups (reused from planner) ─────────────

function fixupRawAction(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const obj = parsed as Record<string, unknown>;

  // If it has an action, fix up the action object
  const action = obj['action'];
  if (typeof action === 'object' && action !== null) {
    const step = action as Record<string, unknown>;

    // Fix missing description
    if (!step['description'] && typeof step['type'] === 'string') {
      step['description'] = `${step['type']} step`;
    }

    // Fix invalid selector strategies
    const selector = step['selector'];
    if (typeof selector === 'object' && selector !== null) {
      const sel = selector as Record<string, unknown>;
      const strategy = sel['strategy'];
      const value = sel['value'];

      if (typeof strategy === 'string' && typeof value === 'string') {
        if (!['testid', 'role', 'text', 'css'].includes(strategy)) {
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

    // Fix missing value on expect_text
    if (step['type'] === 'expect_text' && !step['value']) {
      const desc = String(step['description'] ?? '');
      const quoted = /"([^"]+)"/.exec(desc) ?? /'([^']+)'/.exec(desc);
      if (quoted?.[1]) {
        step['value'] = quoted[1];
      } else {
        step['value'] = desc.slice(0, 50) || 'page content';
      }
    }
  }

  return parsed;
}

// ── JSON extraction ─────────────────────────────────────────

function extractJSON(raw: string): string {
  const fenced = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(raw);
  if (fenced?.[1]) return fenced[1].trim();

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) return raw.slice(start, end + 1);

  return raw.trim();
}

// ── Element formatting (same as planner) ────────────────────

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

// ── History formatting ──────────────────────────────────────

function formatHistory(history: readonly ActionHistoryEntry[]): string {
  if (history.length === 0) return '(no actions taken yet)';

  return history
    .map((entry) => {
      const icon = entry.success ? '\u2713' : '\u2717';
      return `${String(entry.stepIndex + 1)}. [${entry.action}] ${entry.description} \u2192 ${icon} ${entry.observation}`;
    })
    .join('\n');
}

// ── Prompt building ─────────────────────────────────────────

async function buildStepPrompt(
  goal: string,
  snapshot: PageSnapshot,
  history: readonly ActionHistoryEntry[],
): Promise<string> {
  const template = await readFile(
    path.join(PROMPTS_DIR, 'agent_step.txt'),
    'utf-8',
  );

  const elementsText = snapshot.elements
    .map((el) => formatElement(el))
    .join('\n');

  return template
    .replace('{{goal}}', goal)
    .replace('{{url}}', snapshot.url)
    .replace('{{title}}', snapshot.title)
    .replace('{{visibleText}}', snapshot.visibleText.slice(0, TOKEN_GUARDS.MAX_VISIBLE_TEXT_CHARS))
    .replace('{{elements}}', elementsText)
    .replace('{{history}}', formatHistory(history));
}

async function buildFinalPrompt(
  goal: string,
  snapshot: PageSnapshot,
  history: readonly ActionHistoryEntry[],
): Promise<string> {
  const template = await readFile(
    path.join(PROMPTS_DIR, 'agent_final.txt'),
    'utf-8',
  );

  return template
    .replace('{{goal}}', goal)
    .replace('{{url}}', snapshot.url)
    .replace('{{visibleText}}', snapshot.visibleText.slice(0, TOKEN_GUARDS.MAX_VISIBLE_TEXT_CHARS))
    .replace('{{history}}', formatHistory(history));
}

// ── LLM call: decide next step ──────────────────────────────

async function decideNextStep(
  client: LLMClient,
  goal: string,
  snapshot: PageSnapshot,
  screenshotBase64: string | undefined,
  history: readonly ActionHistoryEntry[],
): Promise<AgentStepResponse> {
  const prompt = await buildStepPrompt(goal, snapshot, history);

  let raw: string;
  if (screenshotBase64 && client.generateWithImage) {
    raw = await client.generateWithImage(prompt, goal, screenshotBase64, 'image/png');
  } else {
    raw = await client.generate(prompt, goal);
  }

  const json = extractJSON(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Agent returned invalid JSON: ${raw.slice(0, 200)}`);
  }

  const fixed = fixupRawAction(parsed);
  const result = agentStepResponseSchema.safeParse(fixed);
  if (!result.success) {
    throw new Error(`Agent response validation failed: ${result.error.message}`);
  }

  return result.data;
}

// ── LLM call: final evaluation ──────────────────────────────

async function runFinalEvaluation(
  client: LLMClient,
  goal: string,
  snapshot: PageSnapshot,
  screenshotBase64: string | undefined,
  history: readonly ActionHistoryEntry[],
): Promise<AgentFinalEvaluation> {
  const prompt = await buildFinalPrompt(goal, snapshot, history);

  let raw: string;
  if (screenshotBase64 && client.generateWithImage) {
    raw = await client.generateWithImage(prompt, goal, screenshotBase64, 'image/png');
  } else {
    raw = await client.generate(prompt, goal);
  }

  const json = extractJSON(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { result: 'UNCERTAIN', confidence: 0, reason: 'Final evaluator returned invalid JSON' };
  }

  // Clamp confidence
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'confidence' in parsed &&
    typeof (parsed as Record<string, unknown>)['confidence'] === 'number'
  ) {
    const obj = parsed as Record<string, unknown>;
    obj['confidence'] = Math.max(0, Math.min(1, obj['confidence'] as number));
  }

  const result = agentFinalEvaluationSchema.safeParse(parsed);
  if (!result.success) {
    return { result: 'UNCERTAIN', confidence: 0, reason: 'Final evaluator response validation failed' };
  }

  return result.data;
}

// ── Convert AgentActionStep to Step ─────────────────────────

function toStep(action: AgentStepResponse & { done: false }): Step {
  // The action.action is already a valid Step (minus goto), which is
  // compatible with the Step union type used by executeStep
  return action.action as Step;
}

// ── Describe action for history ─────────────────────────────

function describeAction(step: Step): string {
  switch (step.type) {
    case 'click':
      return `click ${step.selector.strategy}="${step.selector.value}"`;
    case 'type':
      return `type ${step.selector.strategy}="${step.selector.value}"`;
    case 'select':
      return `select ${step.selector.strategy}="${step.selector.value}"`;
    case 'wait':
      return step.selector
        ? `wait ${step.selector.strategy}="${step.selector.value}"`
        : `wait ${step.value ?? '?'}ms`;
    case 'expect_text':
      return `expect_text "${step.value}"`;
    default:
      return `${step.type}`;
  }
}

// ── Bug extraction (same as V1) ─────────────────────────────

function extractBugs(steps: readonly StepExecutionResult[]): BugReport[] {
  const bugs: BugReport[] = [];

  for (const sr of steps) {
    const evidence: string[] = [];

    for (const entry of sr.capture.consoleEntries) {
      if (entry.level === 'error') {
        evidence.push(`Console error: ${entry.text}`);
      }
    }
    for (const failure of sr.capture.networkFailures) {
      evidence.push(
        `Network ${failure.method} ${failure.url} \u2192 ${String(failure.status)}`,
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

// ── Artifact writing ────────────────────────────────────────

async function writeStepArtifact(
  outputDir: string,
  stepIndex: number,
  result: StepExecutionResult,
): Promise<void> {
  const filePath = path.join(outputDir, `step-${String(stepIndex)}.json`);
  await writeFile(filePath, JSON.stringify(result, null, 2), 'utf-8');
}

// ── Observe-Decide-Act sub-loop ─────────────────────────────

interface SubLoopConfig {
  client: LLMClient;
  session: { page: import('playwright').Page; executeStep: (step: Step, index: number) => Promise<StepExecutionResult> };
  goal: string;
  maxSteps: number;
  deadline: number;
  screenshotDir: string;
  outputDir: string;
  stepOffset: number;
}

interface SubLoopResult {
  results: StepExecutionResult[];
  history: ActionHistoryEntry[];
  done: boolean;
  doneSummary?: string;
}

async function runSubLoop(config: SubLoopConfig): Promise<SubLoopResult> {
  const { client, session, goal, maxSteps, deadline, screenshotDir, outputDir, stepOffset } = config;
  const results: StepExecutionResult[] = [];
  const history: ActionHistoryEntry[] = [];

  for (let i = 0; i < maxSteps; i++) {
    if (Date.now() > deadline) {
      log.warn('Timeout reached — stopping agent loop');
      break;
    }

    const stepIndex = stepOffset + i;

    // ── OBSERVE ──────────────────────────────────────────
    let snapshot: PageSnapshot;
    try {
      snapshot = await prescanCurrentPage(session.page);
    } catch {
      log.warn('Prescan failed — stopping loop');
      break;
    }

    let screenshotBase64: string | undefined;
    try {
      const buf = await session.page.screenshot({ type: 'png' });
      screenshotBase64 = buf.toString('base64');
    } catch {
      // Non-fatal
    }

    // ── DECIDE ───────────────────────────────────────────
    log.llm(`Agent deciding step ${String(i + 1)}/${String(maxSteps)}...`);

    let decision: AgentStepResponse;
    try {
      decision = await decideNextStep(client, goal, snapshot, screenshotBase64, history);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Agent decision failed: ${msg}`);
      // Record in history as a failed LLM call and continue
      history.push({
        stepIndex: i,
        action: 'decide',
        description: 'LLM decision call',
        success: false,
        observation: `LLM error: ${msg}`,
      });
      continue;
    }

    // ── CHECK DONE ───────────────────────────────────────
    if (decision.done) {
      log.info(`Agent says done: ${decision.summary}`);
      return { results, history, done: true, doneSummary: decision.summary };
    }

    // ── ACT ──────────────────────────────────────────────
    const step = toStep(decision);
    const actionStr = describeAction(step);
    log.step(stepIndex, stepOffset + maxSteps, step.description);

    let result: StepExecutionResult;
    try {
      result = await session.executeStep(step, stepIndex);
    } catch (execErr) {
      const execMsg = execErr instanceof Error ? execErr.message : String(execErr);
      log.error(`Step ${String(stepIndex + 1)} crashed: ${execMsg}`);

      // Try screenshot on crash
      const crashScreenshotPath = path.join(screenshotDir, `step-${String(stepIndex)}.png`);
      try {
        await session.page.screenshot({ path: crashScreenshotPath, fullPage: true });
      } catch {
        // Browser may be dead
      }

      result = {
        stepIndex,
        step,
        success: false,
        url: session.page.url(),
        screenshotPath: crashScreenshotPath,
        visibleText: '',
        capture: {
          consoleEntries: [],
          networkFailures: [],
          pageErrors: [{ message: `executeStep crashed: ${execMsg}` }],
        },
      };
    }

    // ── RECORD ───────────────────────────────────────────
    const observation = result.success
      ? `Page at ${result.url}${result.visibleText.length > 0 ? ` — text starts: "${result.visibleText.slice(0, 80)}..."` : ''}`
      : `Failed — ${result.capture.pageErrors[0]?.message ?? 'element not found or action failed'}`;

    history.push({
      stepIndex: i,
      action: actionStr,
      description: step.description,
      success: result.success,
      observation,
    });

    log.stepResult(stepIndex, stepOffset + maxSteps, result.success, step.description);

    results.push(result);
    await writeStepArtifact(outputDir, stepIndex, result).catch(() => {});
  }

  return { results, history, done: false };
}

// ── Main V2 agent loop ──────────────────────────────────────

export async function runAgentLoopV2(
  client: LLMClient,
  config: AgentLoopV2Config,
): Promise<AgentLoopV2Result> {
  const runId = randomUUID();
  const startedAt = new Date();
  const maxSteps = config.maxSteps ?? V2_MAX_STEPS;
  const totalTimeout = config.totalTimeout ?? TIMEOUTS.TOTAL_RUN_TIMEOUT;

  const screenshotDir = path.join(config.outputDir, 'screenshots');
  await mkdir(config.outputDir, { recursive: true });

  const deadline = startedAt.getTime() + totalTimeout;

  // ── 1. Launch browser session ──────────────────────────

  log.section(`Run (V2 Agent): ${config.prompt}`);
  log.info(`Target: ${config.url}`);

  const session = await launchSession({
    headless: config.headless,
    screenshotDir,
  });

  try {
    // ── 2. Inject cookies ────────────────────────────────

    if (config.cookies && config.cookies.length > 0) {
      await session.addCookies(config.cookies);
    }

    // ── 3. Navigate to base URL ──────────────────────────

    log.info(`Navigating to ${config.url}`);
    await session.page.goto(config.url, {
      timeout: TIMEOUTS.NAVIGATION_TIMEOUT,
      waitUntil: 'domcontentloaded',
    });

    // ── 4. Login sub-loop (if requested) ─────────────────

    let loginStepCount = 0;

    if (config.loginPrompt) {
      log.section('Login Flow (V2 Agent)');
      log.login('Starting agent-driven login...');

      const loginResult = await runSubLoop({
        client,
        session,
        goal: config.loginPrompt,
        maxSteps: LOGIN_MAX_STEPS,
        deadline,
        screenshotDir,
        outputDir: config.outputDir,
        stepOffset: 0,
      });

      loginStepCount = loginResult.results.length;

      if (loginResult.done) {
        log.login(`Login complete: ${loginResult.doneSummary ?? 'done'}`);
      } else {
        log.warn('Login sub-loop ended without agent confirming done — continuing anyway');
      }

      // Let the app settle after login
      try {
        await session.page.waitForLoadState('networkidle', { timeout: 5_000 });
      } catch {
        // Non-fatal
      }
    }

    // ── 5. Main test loop ────────────────────────────────

    log.section('Test Execution (V2 Agent)');

    const mainResult = await runSubLoop({
      client,
      session,
      goal: config.prompt,
      maxSteps,
      deadline,
      screenshotDir,
      outputDir: config.outputDir,
      stepOffset: loginStepCount,
    });

    const allResults = mainResult.results;

    // ── 6. Final evaluation ──────────────────────────────

    log.section('Final Evaluation');

    let finalEvaluation: AgentFinalEvaluation | undefined;

    if (Date.now() <= deadline) {
      let finalSnapshot: PageSnapshot;
      try {
        finalSnapshot = await prescanCurrentPage(session.page);
      } catch {
        finalSnapshot = {
          url: session.page.url(),
          title: '',
          visibleText: '',
          elements: [],
        };
      }

      let finalScreenshot: string | undefined;
      try {
        const buf = await session.page.screenshot({ type: 'png' });
        finalScreenshot = buf.toString('base64');
        // Save final screenshot
        await session.page.screenshot({
          path: path.join(screenshotDir, 'final.png'),
          fullPage: true,
        });
      } catch {
        // Non-fatal
      }

      try {
        finalEvaluation = await runFinalEvaluation(
          client,
          config.prompt,
          finalSnapshot,
          finalScreenshot,
          mainResult.history,
        );
        log.info(`Final evaluation: ${finalEvaluation.result} (confidence: ${String(finalEvaluation.confidence)}) — ${finalEvaluation.reason}`);
      } catch (evalErr) {
        const evalMsg = evalErr instanceof Error ? evalErr.message : String(evalErr);
        log.warn(`Final evaluation failed: ${evalMsg}`);
      }
    }

    // ── 7. Compute verdict ───────────────────────────────

    // If the agent completed and said done, and no steps failed,
    // use the final evaluation. Otherwise fall back to deterministic verdict.
    let verdict: EvaluationVerdict;

    if (finalEvaluation) {
      // Apply final evaluation to the last result if we have one
      if (allResults.length > 0) {
        const lastResult = allResults[allResults.length - 1]!;
        allResults[allResults.length - 1] = {
          ...lastResult,
          evaluation: {
            result: finalEvaluation.result,
            confidence: finalEvaluation.confidence,
            reason: finalEvaluation.reason,
          },
        };
      }
    }

    verdict = computeSummaryVerdict(allResults);

    // If no steps at all but agent said done, trust the final eval
    if (allResults.length === 0 && mainResult.done && finalEvaluation) {
      verdict = finalEvaluation.result;
    }

    const bugs = extractBugs(allResults);
    const finishedAt = new Date();

    log.section('Summary');
    const durationSec = ((finishedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
    log.info(`Verdict: ${verdict} (${String(allResults.length)} steps, ${durationSec}s)`);
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
      steps: allResults,
      bugs,
    };

    const exitCode = verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2;

    // Write contract-format summary.json
    const jsonOutput = generateJSON(summary, exitCode);
    const summaryPath = path.join(config.outputDir, 'summary.json');
    await writeFile(summaryPath, serializeJSON(jsonOutput) + '\n', 'utf-8').catch(
      () => {},
    );

    return { summary, exitCode };
  } finally {
    await session.close();
  }
}
