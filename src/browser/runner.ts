import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from 'playwright';
import type { Page } from 'playwright';

import type { Step, StepExecutionResult, WaitStep } from '../schema/index.js';
import { TIMEOUTS, TOKEN_GUARDS } from '../config/defaults.js';
import { resolveSelector } from './selectors.js';
import { attachCapture } from './capture.js';
import * as log from '../utils/logger.js';

// ── Public types ─────────────────────────────────────────────

export interface RunnerConfig {
  headless: boolean;
  screenshotDir: string;
}

export interface CookieParam {
  name: string;
  value: string;
  url: string;
}

export interface BrowserSession {
  readonly page: Page;
  executeStep(step: Step, stepIndex: number): Promise<StepExecutionResult>;
  addCookies(cookies: readonly CookieParam[]): Promise<void>;
  close(): Promise<void>;
}

// ── Session launcher ─────────────────────────────────────────

export async function launchSession(
  config: RunnerConfig,
): Promise<BrowserSession> {
  await mkdir(config.screenshotDir, { recursive: true });

  const browser = await chromium.launch({ headless: config.headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const capture = attachCapture(page);

  return {
    page,

    async addCookies(cookies: readonly CookieParam[]): Promise<void> {
      await context.addCookies([...cookies]);
    },

    async executeStep(
      step: Step,
      stepIndex: number,
    ): Promise<StepExecutionResult> {
      // Flush any stale data from between steps
      capture.flush();

      let success = true;
      try {
        await performAction(page, step);
      } catch {
        success = false;
      }

      const screenshotPath = path.join(
        config.screenshotDir,
        `step-${String(stepIndex)}.png`,
      );
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(
        () => {},
      );

      const visibleText = await extractVisibleText(page);

      return {
        stepIndex,
        step,
        success,
        url: page.url(),
        screenshotPath,
        visibleText,
        capture: capture.flush(),
      };
    },

    async close(): Promise<void> {
      await browser.close();
    },
  };
}

// ── Step dispatch ────────────────────────────────────────────

async function performAction(page: Page, step: Step): Promise<void> {
  switch (step.type) {
    case 'goto':
      log.detail(`goto → ${step.value}`);
      await page.goto(step.value, {
        timeout: step.timeout ?? TIMEOUTS.NAVIGATION_TIMEOUT,
        waitUntil: 'domcontentloaded',
      });
      break;

    case 'click': {
      log.detail(`click → ${step.selector.strategy}="${step.selector.value}"`);
      const locator = resolveSelector(page, step.selector);
      await locator.click({
        timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
      });
      break;
    }

    case 'type': {
      log.detail(`type "${step.value}" → ${step.selector.strategy}="${step.selector.value}"`);
      const locator = resolveSelector(page, step.selector);
      await locator.fill(step.value, {
        timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
      });
      break;
    }

    case 'select': {
      log.detail(`select "${step.value}" → ${step.selector.strategy}="${step.selector.value}"`);
      const locator = resolveSelector(page, step.selector);
      await locator.selectOption(step.value, {
        timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
      });
      break;
    }

    case 'upload': {
      log.detail(`upload "${step.value}" → ${step.selector.strategy}="${step.selector.value}"`);
      const locator = resolveSelector(page, step.selector);
      await locator.setInputFiles(step.value, {
        timeout: step.timeout ?? TIMEOUTS.ACTION_TIMEOUT,
      });
      break;
    }

    case 'wait':
      log.detail(`wait → ${step.selector ? `${step.selector.strategy}="${step.selector.value}"` : `${step.value ?? '?'}ms`}`);
      await handleWait(page, step);
      break;

    case 'expect_text': {
      log.detail(`expect_text → "${step.value}"`);
      const timeout = step.timeout ?? TIMEOUTS.ACTION_TIMEOUT;
      const locator = step.selector
        ? resolveSelector(page, step.selector)
        : page.locator('body');
      await locator.waitFor({ state: 'visible', timeout });
      const text = await locator.innerText();
      if (!text.includes(step.value)) {
        throw new Error(`Expected text "${step.value}" not found`);
      }
      break;
    }
  }
}

// ── Wait handling ────────────────────────────────────────────

async function handleWait(page: Page, step: WaitStep): Promise<void> {
  const timeout = step.timeout ?? TIMEOUTS.ACTION_TIMEOUT;

  if (step.selector) {
    const locator = resolveSelector(page, step.selector);
    await locator.waitFor({ state: 'visible', timeout });
  } else if (step.value) {
    const ms = Number(step.value);
    if (!Number.isNaN(ms)) {
      await page.waitForTimeout(ms);
    }
  }
}

// ── Text extraction ──────────────────────────────────────────

async function extractVisibleText(page: Page): Promise<string> {
  try {
    const text = await page.innerText('body');
    return text.slice(0, TOKEN_GUARDS.MAX_VISIBLE_TEXT_CHARS);
  } catch {
    return '';
  }
}
